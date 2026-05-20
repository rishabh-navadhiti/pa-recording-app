# Feature landscape

Every feature Fahd is asking for, mapped against what our recording-app already does. Status legend:

- ✅ **Done** — already shipped in the recording-app
- 🟡 **Partial** — exists but needs upgrade to match what Fahd wants
- 🆕 **New** — not yet built, would need a new skill or pipeline step
- 🔮 **Future** — Fahd's later phases, not Phase 2

---

## Core pipeline — what we already have

| Feature | Status | Where it lives |
|---|---|---|
| Audio capture from system loopback | ✅ | [python/record.py](../../python/record.py) |
| Transcription (ElevenLabs, diarised) | ✅ | [python/transcribe.py](../../python/transcribe.py) |
| Per-doctor SOAP note generation | ✅ | [notes-claude/skills/generate-note/](../../notes-claude/skills/generate-note/) |
| Per-doctor template authoring (AI-built from 50–100 sample notes) | ✅ | [notes-claude/skills/create-doctor-profile/](../../notes-claude/skills/create-doctor-profile/) |
| Template updating with natural-language corrections | ✅ | [notes-claude/skills/update-doctor-profile/](../../notes-claude/skills/update-doctor-profile/) |
| Note iteration via pre-chart (attach files + instructions → regenerate) | ✅ | [notes-claude/skills/edit-note/](../../notes-claude/skills/edit-note/) |
| ICD-10 codes appended to note | ✅ | claude.ai ICD-10 MCP connector, fired between SOAP and DOCX |
| Word-doc export | ✅ | [python/md_to_docx.py](../../python/md_to_docx.py) |
| Background pipeline with non-blocking UI | ✅ | main.js pipeline staging |
| One-at-a-time background job lock | ✅ | `templateJobProc` |
| Skills sync from repo to runtime | ✅ | `notes-claude/` → `<NOTES_DIR>/.claude/` on every launch |
| Auto-update via `git pull` | ✅ | main.js startup |
| Settings + per-doctor registry | ✅ | `<NOTES_DIR>/settings.json` |

---

## What Fahd is adding — the 8 engines

| # | Engine | Status | Notes |
|---|---|---|---|
| 1 | **CDI Co-Pilot** — gap detection, specificity flags, evidence matching, confidence scores, HCC capture, DRG impact, quality score | 🆕 | This is the core ask. Output format: per-flag {type, title, evidence found, evidence missing, suggested code, confidence, DRG impact}. Operating modes: compliance / balanced / aggressive. |
| 2 | **SOAP Note Validator** — 26-point structural pre-check before CDI | 🟡 | Our `generate-note` already enforces structure via per-doctor template. But Fahd's "AMBCI 25-point billing evidence proof map" is a separate, billing-focused validator. Worth absorbing as a post-generation linter. |
| 3 | **Specificity Dictionary + E/M MDM Scorer** — 20 vague dx with required modifiers; AMA 2023 MDM → predicted E/M level | 🆕 | Pattern-match locally for detection (0 API tokens), LLM fires only for query generation. The JSON dict is gold — see `cdi_standards/specificity_v2026.json`. |
| 4 | **Workers Comp** — PR-1 / PR-2 / PR-4 extraction + narrative | 🆕 | California DWC. PR-4 is medical-legal — high stakes. AMA Guides 5th Ed for impairment, Labor Code §4663 apportionment. |
| 5 | **Prior Authorization** — criteria check + letter draft | 🆕 | 5-7 medical necessity criteria per procedure, scored Met / Partial / Unmet with evidence citations. |
| 6 | **Clinical Order Generation** — extract orders from Plan, flag implied orders | 🆕 | Labs / imaging / referrals / meds / therapy / DME / follow-up. Implied-orders is the interesting bit — flags clinically-indicated orders missing from the plan. |
| 7 | **Patient Summary Generator** — full summary + 150-word pocket card, 4 languages, 6th-grade reading level | 🆕 | Output for patient, not biller. |
| 8 | **Quality + Feedback Loop + Level 1 Self-Learning** — QA cross-review, feedback log, few-shot adaptation from accepted outputs | 🆕 | Self-learning via accumulating accepted outputs as few-shot examples. Stored in `.pa_feedback_log.json`. Reports "autonomy %" toward 85% target. |

### Auto-Pilot orchestration

| Feature | Status | Notes |
|---|---|---|
| **Orchestrator agent** — reads note, builds task manifest, decides which engines to run | 🆕 | Determines: is this WC? Report type? Prior auth needed? Patient language? Expected E/M level? |
| **Parallel execution** — fire applicable engines simultaneously | 🆕 | Fahd uses Promise.all in JS. Our pipeline is currently sequential. |
| **Provider Query Generator** — auto-create AHIMA-compliant queries from CDI critical flags | 🆕 | Format: subject / clinical context / question / multi-choice response (incl. "clinically undetermined") / signature line. Includes per-patient repeat-query blocking. |
| **Quality Agent** — cross-review all outputs, 0–100 score, ready-to-submit flag | 🆕 | The "linter for the linters". |
| **Unified Review Package** — single panel where scribe approves/edits each output | 🆕 | UI question: a new tab? A floating window? Inline in existing Cases view? |
| **Confidence gate** — auto-approve ≥80%, review 50–79%, full review <50% | 🆕 | Per-output behavior. |

---

## Fahd's roadmap — not phase 2

| Phase | What it adds | Status |
|---|---|---|
| Phase 2 (Fahd's) | Backend API proxy (remove browser API-key exposure), SSO/OAuth, BAA execution, HIPAA-eligible hosting, server-side audit logging, Level 2 fine-tuning pipeline | 🔮 |
| Phase 3 (Fahd's) | Real ambient-tool API integration (i.e. *us*), Epic FHIR R4 / Cerner ingestion, in-EHR checklist, 835 denial-feed mapping | 🔮 |
| Phase 4 (Fahd's) | Provider scorecards, query-prevention dashboard, HCC risk-lift analytics, denial prediction, custom CDI rule editor | 🔮 |

Our Phase 2 should focus on engines 1, 2, 3, 5, 6, 7, 8 + orchestration. **Engine 4 (Workers Comp) deserves its own track** — it's high-stakes (medical-legal) and California-specific. Probably best done as a separately-scoped feature once the CDI / specificity / E/M loop is working.

---

## Standards content — to absorb verbatim

The standards packs Fahd built are genuinely valuable codified knowledge:

| File | Worth absorbing? |
|---|---|
| `cdi_standards/specificity_v2026.json` (20 dx) | ✅ Yes — this is gold. Drop into `notes-claude/standards/`. |
| `standards/icd10_fy2026.yaml` | ✅ Yes — distilled FY2026 CMS guidelines with section refs. |
| `standards/ahima_acdis_2026.yaml` | ✅ Yes — query compliance rules. |
| `standards/ama_em_2023.yaml` | ✅ Yes — MDM scoring framework. |
| `standards/ca_dwc_wc.yaml` | ⏸️ Defer — only matters when we tackle WC. |
| `pa_standards.py` (loader) | 🟡 Adapt — same idea (versioned packs) but lives inside skills, not as a separate Python module. |
| `pa_agents.py` (the MCP server itself) | ❌ No — different deployment model. We absorb the prompts/rules, not the MCP infrastructure. |

---

## Open feature questions

These belong in [04-open-questions.md](04-open-questions.md) but flagging here so they're visible while reading the feature list:

1. **CDI scope per doctor vs per specialty.** Our app is per-doctor (each doctor has a template). Fahd's CDI rules are per-specialty (hospitalist / orthopedics / cardiology). How do these layer? Probably: doctor.specialty in `settings.json` → load specialty CDI ruleset on top of doctor template.
2. **Where the CDI flags surface.** Options: (a) inline section in the SOAP note `.md`, (b) separate `<case>_cdi.md` next to soap_note, (c) new floating UI panel, (d) post-process inside the same `.docx` as a "Documentation review" section. Each implies different scribe-edit workflow.
3. **Provider queries — who sees them?** Currently the scribe is the only audience for the note. Provider queries are meant to go *to the doctor* for clarification. Does the app email/Slack/print them? Or just produce text the scribe relays?
4. **Patient summaries — when do they fire?** "Every encounter" per Fahd. But that's a lot of extra tokens. Maybe opt-in per doctor.
5. **What does "Auto-Pilot" actually look like in the UI?** Fahd shows a "unified review package" panel. We have tabs (Record / Pre-chart / Templates) and a Cases folder view. Adding a 4th tab? A floating window? Inline?

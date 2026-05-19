# Architecture observations

Notes on where Fahd's proposed architecture conflicts with what we have, and what I think the right path looks like. **Not** a final design — input for the conversation.

---

## Fahd's mental model (from his PDF + diagram)

```
Ambient scribing tool         Integration layer            Physician Assist
(browser-based, ours)         (postMessage / localStorage) (his — browser OR MCP)
─────────────────────         ────────────────────────     ──────────────────
Audio → AI draft note    →    Handoff JSON payload    →    PA receiver
                                                            ↓
                                                            Orchestrator
                                                            ↓
                                                            CDI + WC + PA agents (parallel)
                                                            ↓
                                                            Quality agent
                                                            ↓
                                                            Unified review panel
                                                            ↓
                                                            Provider attests
```

Two products with a JSON handoff between them.

---

## Our reality

```
Electron app (recording-app)
├── tray + popup window + 3 tabs
├── Python children (record / transcribe / docx)
├── Local `claude` CLI invoked by main.js, cwd = <NOTES_DIR>
└── notes-claude/.claude/skills/  ←  the skills the CLI auto-discovers
        ├── generate-note/
        ├── create-doctor-profile/
        ├── update-doctor-profile/
        └── edit-note/
```

We don't have a browser. We don't have a postMessage bus. The "AI tool" and the "Physician Assist tool" can be the same thing — they're both desktop processes that already share the Claude CLI and the notes-dir.

---

## The big architectural decision

**Are PA features a separate product, or the next phase of our app?**

| Option | Description | Implications |
|---|---|---|
| **A. PA absorbed into recording-app** | CDI, WC, PA, orders, summary, quality become new skills in `notes-claude/skills/`. Pipeline gains new steps. Scribe sees them as new tabs / new sections in existing UI. | One product, one install, one notes folder. Lowest user friction. Fits our existing patterns. But it's a big surface increase for one app. |
| **B. PA as a sibling app, separate process** | Recording-app produces notes; a separate PA Electron app reads from `<NOTES_DIR>/Cases/` and adds its own outputs alongside. Communicates via files, not IPC. | Cleaner separation of concerns. Two installs. Possible if PA is destined to also serve non-scribe-recorder workflows (e.g. paste-in notes from elsewhere). |
| **C. PA as an MCP server consumed by recording-app's Claude CLI** | Build PA features as an MCP server; our skills call its tools (`run_cdi`, `run_wc_report`, etc.). | Most aligned with Fahd's existing pa_agents.py. Lets the same MCP server also be consumed by Claude Desktop / other apps later. But adds a Python process to manage at install time. |
| **D. Pure Fahd model** | Browser-based ambient tool + browser/MCP PA. Replace our Electron app entirely. | Massive rewrite. Throws away the Electron pipeline that works. Not under serious consideration. |

**My read:** **A is the right first step**, but design the skills so they're **portable to C** later. A skill is just a directory with prompts + scripts — easy to also expose as MCP tools if Phase 3 needs that. The MCP indirection is only valuable when the same tools serve multiple consumers; for now there's one consumer (the recording-app's Claude CLI).

This is a decision for rish/Fahd/Jayanth, not Claude.

---

## Specific design tensions

### 1. Per-doctor templates vs per-specialty CDI rules

Our app's central abstraction is the **doctor template** — captures *that doctor's* phrasing, structure, idiosyncrasies. Fahd's CDI rules are per **specialty** — applies to all orthopedists, regardless of which orthopedist.

These are complementary, not competing:
- **Template** = "how does Dr Harris write a note?" (style)
- **CDI rules** = "what does FY2026 ICD-10-CM require for this kind of clinical content?" (compliance)

Both should fire. The doctor template informs *generation*; CDI rules inform *validation*. Storage: doctor `.specialty` field already implied in settings — add it as a first-class field, use it to pick which CDI ruleset to run.

### 2. Where the standards live

Fahd has standards packs in `pa-mcp-server/standards/*.yaml` and `pa-mcp-server/cdi_standards/specificity_v2026.json`, with a Python loader (`pa_standards.py`). Versioned. Smart pattern.

We should absorb the **content** into `notes-claude/standards/` and reference it from skills. The loader pattern doesn't need to be Python — the skills are markdown prompts; they can `Read` the standards file directly. The versioning + audit-trail pattern (each pack has `version` / `effective_date` / `last_reviewed`) is worth keeping.

```
notes-claude/
├── skills/
│   ├── cdi-analysis/SKILL.md
│   ├── score-em/SKILL.md
│   └── ...
└── standards/             ← new
    ├── icd10_fy2026.yaml
    ├── ahima_acdis_2026.yaml
    ├── ama_em_2023.yaml
    └── specificity_v2026.json
```

Skills reference these as absolute paths within `<NOTES_DIR>/.claude/` (resolved at runtime since `notes-claude/` is synced there).

### 3. The pipeline shape

Today:
```
audio → transcript → soap → icd-codes → docx
```

After Phase 2 (proposed):
```
audio → transcript → soap → cdi-analysis → docx
                          → em-score   ──┘
                          → orders     ──┘
                          → patient-summary
```

CDI replaces (or wraps) the current "ICD codes appended" step. The other engines (orders, summary) run in parallel after SOAP completes. Workers Comp and Prior Auth are **opt-in by visit context**, not always-on — the orchestrator decides.

**Question for rish:** is the orchestrator a real component, or just a `if visit_type == "wc"` branch in main.js? Fahd describes it as a separate agent; in practice it could be a tiny rules-based dispatcher in JS, no LLM needed.

### 4. The "scribe is in the loop twice" question

Rish asked this on WhatsApp. Fahd didn't answer directly. The diagram suggests:
- **Loop 1**: scribe reviews + edits the initial AI note before export.
- **Loop 2**: scribe reviews the CDI flags + WC report + PA letter + etc. *after* PA fires.

For our app, this would mean: after the current SOAP-generation completes, the scribe edits as today, and *then* CDI/PA/orders/summary fire on the **edited final note**, not the original AI draft. Otherwise CDI is auditing a draft the scribe has already corrected — wasted work.

This means we probably want a **"finalize" action** in the scribe UI that triggers the second pipeline. Pre-chart already has this shape ("done editing → docx regenerated"). The Phase 2 pipeline can hang off the same trigger.

### 5. Auto-Pilot vs scribe-controlled

Fahd's vision is fully autonomous: one click, all engines fire. Our app gives scribes structured control via tabs and buttons. The optimal answer is probably:
- **Settings flag per doctor**: which engines to auto-run after SOAP generation? (CDI: always; orders: usually; patient-summary: if patient-facing visit; WC: only WC doctors; PA: only when plan section contains a procedure)
- **Manual trigger** for one-off: "run CDI on this case" / "draft a prior auth letter for this procedure"

This is in the spirit of the recording-app — scribes are pros, they want control, not magic.

### 6. The feedback loop / self-learning

Fahd's "Level 1 self-learning" is essentially few-shot prompting from a `.pa_feedback_log.json`. Per-engine, accumulates accepted (edit% < 15%) outputs as examples. Future calls inject the 3 most recent as a few-shot prefix.

This is good and worth implementing. But it has implications:
- Storage location: should live in `<NOTES_DIR>/.pa_feedback_log.json` (per the existing pattern of state files in notes-dir).
- Privacy: it includes clinical content. Need a way to clear it.
- Bootstrap: cold-start sessions get no benefit; the win compounds over weeks.
- Cross-doctor sharing: if Dr Harris's accepted CDI outputs become few-shot examples, do they pollute Dr Spencer's CDI runs? Probably segment by doctor (or by doctor+engine).

### 7. Two-deployment problem

Fahd ships **two** versions of the same engines: browser (Vercel) and local MCP. That's wasteful duplication for him — every prompt change must update both.

We sidestep this by having **one** deployment (skills inside recording-app). Fahd's Vercel app continues to exist as his demo/marketing surface — it doesn't have to die. We don't need to consolidate his side; we just don't replicate his mistake on ours.

---

## What we should reuse from Fahd's pa-mcp-server

- ✅ The **specificity dictionary JSON** — verbatim, with attribution.
- ✅ The **ICD-10-CM yaml pack** — verbatim.
- ✅ The **AHIMA/ACDIS yaml pack** — verbatim.
- ✅ The **AMA E/M MDM yaml pack** — verbatim.
- ✅ The **per-specialty CDI rule prompts** in `pa_agents.py` (the big string constants for Hospitalist/Orthopedics/Cardiology/ENT/etc.). These are good prompts.
- ✅ The **system_prompt.md** structure (how the orchestrator presents flags, the AHIMA query format) — informs our skill prompts.
- ✅ The **versioning pattern** (every pack has version / effective_date / last_reviewed / next_review).
- ⚠️ The **MCP infrastructure** itself — re-evaluate when there's a real reason to go MCP. Not now.
- ⚠️ The **few-shot learning loop** — implement the *idea*, not the file structure as-is.

---

## What we should *not* do

- ❌ Build a separate Python process for PA that the Electron app launches. Adds install complexity, two source-of-truth problems for prompts, and a new IPC boundary. Skills already work.
- ❌ Adopt the postMessage / localStorage handoff. Doesn't apply to our architecture.
- ❌ Ask scribes to use Claude Desktop for PA features while continuing to use our app for recording. Two-app workflow is bad UX; switches break flow.
- ❌ Treat "85% autonomy" as a measured target before we have a feedback loop running. It's a vision metric, not a KPI yet.

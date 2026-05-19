# What Fahd has shipped — inventory

All paths below are on `rish`'s machine. Confidential — do not redistribute.

---

## 1. The PDF — `pa-feature-overview_1.pdf`

📁 `/Users/rish/Development/PA/Fahd doc/pa-feature-overview_1.pdf` (21 pages, April 30 2026)

Internal feature overview titled **"PHYSICIAN ASSIST — Clinical Operations AI Platform"**. Authored by Fahd as a management/dev-team brief. Distills his full vision into 8 "engines" + an Auto-Pilot orchestrator + two deployment modes (browser and local MCP).

Key claims (from the exec summary table):
- 17 AI engines (the doc itself describes 8 main + orchestration + supporting)
- 9 clinical specialties supported
- 32 structured CDI rules + FY2026 ICD-10-CM
- 20-diagnosis specificity dictionary
- E/M MDM scoring per AMA 2023
- 4 languages (English, Spanish, Mandarin, Tagalog)
- "85% AI / 15% human" autonomy target
- Compliance standards: FY2026 ICD-10-CM, AHIMA/ACDIS 2026, AMA 2023 E/M, AMA Guides 5th Ed (for WC impairment ratings)

---

## 2. The PA flow diagram — `PA flow diag.jpeg`

📁 `/Users/rish/Development/PA/Fahd doc/PA flow diag.jpeg`

Three-column flow:
- **Left — Ambient scribing tool** (Fahd's mental model of *our* app): Audio capture → AI draft note → Scribe review → Export trigger.
- **Center — Integration layer**: Handoff payload `{note, suggestedCodes, patient, visitType, specialty, provider, wcContext?}` via Option A `postMessage` (same browser) or Option B `localStorage` (same device).
- **Right — Physician Assist**: PA receiver → Auto-Pilot runs (CDI + WC + PA agents) → Review package → Provider attests.

**Critical assumption to flag:** the diagram assumes the ambient scribing tool is **browser-based** (otherwise postMessage / localStorage handoff makes no sense). Ours is an **Electron desktop app**. This mismatch underlies most of the architectural tension — see [03-architecture-observations.md](03-architecture-observations.md).

---

## 3. The local MCP server — `pa-mcp-server/`

📁 `/Users/rish/Development/PA/Fahd doc/pa-mcp-server/`

A working Python MCP server Fahd built (and tried in Claude Desktop). Files:

| File | Role |
|---|---|
| `pa_agents.py` | ~655 lines. Defines 15–17 MCP tools, each backed by a `claude_call()` to the Anthropic API. CDI rules per specialty hard-coded inline. |
| `pa_standards.py` | Standards-pack loader. Versioned, file-backed. `load_pack("icd10_fy2026")` etc. Smart: decouples guideline content from agent code. |
| `cdi_standards/specificity_v2026.json` | The 20-diagnosis specificity dictionary. Per-dx: vague terms, required attributes, trigger indicators, compliant query options, unspecified vs specific ICD codes, DRG impact, HCC flag, guideline ref. |
| `standards/icd10_fy2026.yaml` | FY2026 ICD-10-CM official guidelines, distilled. Cites the actual CMS sections (I.B.13 laterality, I.C.1.d sepsis, I.C.9.a HTN+HF, etc.). |
| `standards/ahima_acdis_2026.yaml` | AHIMA/ACDIS query compliance rules. |
| `standards/ama_em_2023.yaml` | AMA 2023 E/M MDM scoring framework. |
| `standards/ca_dwc_wc.yaml` | California DWC workers comp report requirements. |
| `README.md` | Setup, Claude Desktop config, ambient-tool integration spec. |
| `system_prompt.md` | Pasted into Claude Desktop custom instructions to drive the orchestration. |

**Tools exposed (from README + PDF):**
`run_orchestrator`, `validate_soap`, `run_specificity_check`, `score_em_mdm`, `run_cdi`, `run_wc_report`, `run_prior_auth`, `generate_orders`, `generate_patient_summary`, `generate_document`, `generate_provider_query`, `run_quality_check`, `record_feedback`, `get_learning_stats`, `watch_transcript`, `list_outputs`.

**The ambient-tool contract** (from README):
```json
{
  "note": "...",
  "suggested_codes": [{"code": "M54.41", "description": "...", "confidence": 0.91}],
  "patient": "J. Smith (de-identified)",
  "specialty": "Orthopedics",
  "visit_type": "workers_comp",
  "provider": "Dr. Jones",
  "wc_context": {"doi": "04/15/2026", "employer": "...", "claim": "...", "report_type": "pr2"}
}
```
Saved as `encounter_<ts>.json` into `~/pa-transcripts/`. The MCP server polls (or scribe types "check for new transcripts").

---

## 4. The Vercel CDI Co-Pilot — `cdi-copilot.vercel.app`

A browser-deployed version of (a subset of) the same engines.

- Single-file HTML/CSS/JS, ~185 KB
- Repo: `github.com/fahd015-PhyAssist/cdi-copilot`
- Auto-deploys on push to `main`
- User pastes Anthropic API key (stored in `localStorage`) → pastes clinical note → picks specialty → runs analysis
- Sidebar: CDI Co-Pilot / Workers Comp / Prior Auth / Auto-Pilot / Learning
- Has a "Simulate ambient" button to test the handoff path without a real ambient tool

This is the same engine code as the MCP server but in the browser. Two deployments, one set of features.

---

## 5. The ICD-10 reference PDF — *not yet read in depth*

📁 `/Users/rish/Development/PA/Fahd doc/icd_10_cm_october_2025_guidelines_0.pdf` (820 KB)

This is the official **ICD-10-CM Official Guidelines for FY2026** (effective Oct 1 2025), as edited / annotated by Fahd. Per rish: "just take a peek, we can analyse entire doc when we are actually working on it". Not read in detail yet — defer until we're implementing the specificity / CDI feature.

The `icd10_fy2026.yaml` standards pack appears to be Fahd's distilled version of this document.

---

## 6. Suggested external resources (rish mentioned, not yet evaluated)

- **DeepSense MCP guides** — `docs.mcp.deepsense.ai/guides/cms_coverage.html` — sidebar lists MCPs for CMS coverage, ICD-10, NPI registry, etc. Possibly what the Claude Healthcare plugin uses internally.
- **Claude Healthcare** — `claude.com/solutions/healthcare`, `anthropic.com/news/healthcare-life-sciences`.

Worth a closer look when we get to the CDI / ICD implementation — there may be off-the-shelf MCPs that supersede what we'd build ourselves.

---

## What's notably **not** in Fahd's materials

- Any awareness of our actual codebase (Electron + Python + local `claude` CLI + `notes-claude/` skills).
- Any awareness of our **per-doctor templates** as the central abstraction. Fahd thinks per-**specialty** rules.
- The pre-chart edit-note loop. Fahd's model is one-pass: ambient → PA → done. Ours has iteration.
- The "scribe is in the loop TWICE" question rish asked Fahd on WhatsApp and didn't get a clear answer to.
- Cost / token / latency considerations — Fahd's "20–24 second runtime" claim per encounter is plausible but not measured for our setup, and his Auto-Pilot fires *every* agent on *every* note (sledgehammer).

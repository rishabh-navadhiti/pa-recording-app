# CDI v1 — Skill + standards files

**Status:** Finalised 2026-05-19. Ready for implementing-session handoff.

**Scope of this plan:** Author the `cdi-review` skill and its supporting standards files in `notes-claude/`. Produce a prompt-driven CDI engine that runs against any SOAP note + transcript pair via `claude -p "..."` and produces a structured JSON output + a styled markdown rendering.

**Out of scope:** Application integration (main.js spawn point, UI, status display, doctor specialty UI, mode selector, on/off toggle, DB writes, docx styling extension). Those live in a separate Plan 2 — `2026-05-XX-rs-cdi-v2-app-integration.md` (to be written after this plan is implemented and the skill is verified manually by the user against real cases).

**⚠ FOR THE IMPLEMENTING SESSION:** Do NOT execute any tests via `claude -p` during implementation. Document recommended test scenarios in `TESTS.md` (see the "Test scenarios — DOCUMENT, DO NOT EXECUTE" section), but actual test execution is done by the user after merge.

---

## Context

Read first to ground yourself:

- `docs/pa-planning/05-engines.md` — full sub-feature list for CDI Engine 1 with v1 status markers. Authoritative scope reference.
- `docs/pa-planning/04-open-questions.md` — decisions already made (Option A / orthopedics first / no generic fallback / non-blocking / etc.)
- `CLAUDE.md` — repo conventions, code map, skill prompt signatures already in use
- `docs/ARCHITECTURE.md` — pipeline overview (this skill will become a new pipeline step in Plan 2; for now it's invocable standalone)

Existing skills to model your style on:
- `notes-claude/skills/generate-note/SKILL.md` — closest in shape; reads markdown inputs, produces markdown output
- `notes-claude/skills/edit-note/SKILL.md` — multi-step skill that backs up, regenerates, overwrites
- `notes-claude/skills/create-doctor-profile/SKILL.md` — reads many reference files, produces a markdown artifact

Reference materials (use as you see fit — distill, restructure, rewrite where useful for runtime Claude consumption; verbatim copying is **not required**):

| Path | Role |
|---|---|
| `/Users/rish/Development/PA/Fahd doc/icd_10_cm_october_2025_guidelines_0.md` | Official FY2026 ICD-10-CM Official Guidelines (CMS/NCHS Oct 1, 2025). **Use as citation-verification reference.** Don't ingest cover-to-cover. When other content cites "Sec I.B.13" — verify the section exists and reflects the rule correctly. |
| `/Users/rish/Downloads/CDI_SKILL_ORTHOPEDICS.md` | Jayanth's ortho CDI skill — well-structured agent-instruction format, cites guideline sections inline. Strong starting point for `specialties/orthopedics.md`. |
| `/Users/rish/Downloads/CDI_SKILL_CARDIOLOGY.md` | Jayanth's cardio CDI — useful for *universal* rules (Sections I.B/I.A.15/IV.J — same in every file) and as a future cardio specialty pack. |
| `/Users/rish/Downloads/CDI_SKILL_FAMILY_MEDICINE.md` | Same — universal rules + future FM pack |
| `/Users/rish/Downloads/CDI_SKILL_WORKER_COMP.md` | Future WC engine reference; ignore for v1 |
| `/Users/rish/Development/PA/Fahd doc/pa-mcp-server/pa_agents.py` | Fahd's CDI prompts, JSON schemas, specificity dictionary, MDM table. Worth reading the `run_cdi`, `generate_provider_query`, and operating-mode sections. Don't copy structure verbatim — derive what's useful. |
| `/Users/rish/Development/PA/Fahd doc/pa-mcp-server/cdi_standards/specificity_v2026.json` | Fahd's distilled 20-50 vague Dx dictionary. The structured-data form. |
| `/Users/rish/Development/PA/Fahd doc/pa-mcp-server/standards/icd10_fy2026.yaml` + `ahima_acdis_2026.yaml` | Fahd's distilled guideline packs |
| `/Users/rish/Development/PA/Fahd doc/pa-feature-overview_1.pdf` | Fahd's vision document. Useful for understanding Engine 1's intended sub-features. |
| `/Users/rish/Development/PA/Fahd doc/physician_assist_soap_cdi_icd10_audit_framework.pdf` | **Important — Fahd's elaborated CDI/ICD-10/SOAP audit framework (22 pages).** Section 6 is a 10-point ICD-10 Specificity Rubric, Section 7 is a 10-point CDI Completeness Rubric, Section 9 lists Automatic Hold Triggers (CDI-specific conditions that auto-elevate to critical), Section 13 is a JSON Implementation Data Fields schema. Cross-reference against the sub-features list in `05-engines.md` and the JSON schema below — these are good independent verification of our design. |
| `/Users/rish/Development/PA/Fahd doc/physician_assist_soap_only_audit_framework.pdf` | Same framework without CDI/ICD-10 sections (18 pages). Sections 1–5 identical to the CDI PDF. **Mostly relevant for the future Eval framework, not this CDI plan**, but useful background for understanding the SOAP-quality dimensions Fahd cares about. |
| `/Users/rish/Development/PA/Fahd doc/What Insurers Actually Grade Your SOAP Notes On.pdf` | Short payer-facing perspective (3 pages). "Big 3" insurance gatekeepers (Medical Necessity / Service Integrity / Defensibility). **Important: specialty add-ons table is directly applicable to ortho content** — ROM in degrees (not "limited"), named orthopedic tests with +/- results, specific anatomical levels (e.g. "L3-L4" not "lumbar"). Include these in `specialties/orthopedics.md`. |

---

## What CDI v1 produces (the contract)

For each invocation, the skill produces **three output files** in the case folder:

```
<case_dir>/
  <case_stem>_cdi.json     ← canonical structured output (source of truth)
  <case_stem>_cdi.md       ← human-readable rendering (hidden from user on Windows)
  <case_stem>_cdi.docx     ← Word document (visible — user opens this)
```

JSON is generated by Claude; markdown is rendered from the JSON (deterministic transformation); docx comes from the markdown via the existing `python/md_to_docx.py` (Plan 2 may extend that script for severity-coloured cells — out of scope here).

### Inputs

The skill receives (passed as prompt arguments — exact signature defined in "Skill invocation contract" below):

| Input | Purpose |
|---|---|
| `case_dir` | The case folder — skill reads transcript.md and `*_soap_note.md` from here |
| `specialty` | Doctor's specialty (lowercase). For v1: `orthopedics`. Other values produce a "specialty not yet supported" output. |
| `mode` | `balanced` (default) / `compliance` / `aggressive` |
| `doctor_name` | For metadata in the output (optional) |
| `standards_dir` | Path to `notes-claude/standards/` (absolute or relative to cwd) |

### Output JSON schema

```json
{
  "meta": {
    "case_dir": "/abs/path/to/case/folder",
    "patient": "Cecil Daniels",
    "doctor": "Dr. Spencer",
    "specialty": "orthopedics",
    "mode": "balanced",
    "generated_at": "2026-05-19T14:30:00Z",
    "standards_versions": {
      "icd10_cm": "FY2026 (CMS/NCHS, effective 2025-10-01)",
      "ahima_acdis": "2026",
      "specialty_pack": "orthopedics v1"
    }
  },
  "summary": {
    "overall_quality_score": 64,
    "specificity_subscore": 55,
    "evidence_subscore": 70,
    "completeness_subscore": 68,
    "flag_counts": { "critical": 1, "warning": 4, "suggestion": 3, "opportunity": 0 },
    "medical_necessity_status": "weak",
    "claim_defense_readiness": "needs_edits",
    "clinician_approval_required": true
  },
  "flags": [
    {
      "id": "flag-001",
      "type": "critical",
      "category": "Specificity",
      "title": "Primary diagnosis missing",
      "body": "Post-op follow-up note does not state the specific procedure or diagnosis being followed. Per ICD-10-CM Sec IV.A, the first-listed diagnosis must be the condition responsible for the encounter.",
      "guideline_reference": "ICD-10-CM Sec IV.A; AHIMA/ACDIS 2026 query rules",
      "drg_impact": null,
      "current_code": null,
      "suggested_codes": [
        { "code": "Z48.815", "description": "Encounter for surgical aftercare on the musculoskeletal system" },
        { "code": "G56.01", "description": "Carpal tunnel syndrome, right upper limb (presumed pre-surgical Dx)" }
      ],
      "confidence": 92,
      "evidence_found": [
        "incisions at the elbow",
        "buried sutures at the wrist",
        "carpal tunnel dressing"
      ],
      "evidence_missing": [
        "specific procedure performed",
        "date of procedure",
        "original diagnosis being treated"
      ]
    }
  ]
}
```

**Field rules:**
- `type`: one of `critical`, `warning`, `suggestion`, `opportunity` (last one only in aggressive mode)
- `category`: one of `Specificity`, `Linkage`, `HCC`, `Completeness`, `Audit-defense`
- `confidence`: integer 0–100
- `evidence_found` / `evidence_missing`: 0–4 strings each
- `suggested_codes`: 0–N codes; can be empty
- `drg_impact`: null in v1 (we're outpatient) — keep the field for forward-compat
- `current_code`: nullable; the code currently in the note that would be replaced

**Summary-level field rules:**
- `medical_necessity_status`: enum — `supported` / `weak` / `missing`
- `claim_defense_readiness`: enum — `ready` / `needs_edits` / `hold_for_review`
- `clinician_approval_required`: boolean — true if ANY flag is `critical` OR any auto-hold trigger condition fires (see "Automatic-critical conditions" in the prompt design below)

These summary fields align with the integration-contract fields documented in **PDF 2 Section 13 (Implementation Data Fields)** — useful for future UI rendering and as a contract for the eventual Plan 2 app integration.

### Markdown rendering format (per flag)

Each flag becomes a block like this in the .md file:

```markdown
## 🔴 CRITICAL · Primary diagnosis missing · 92% confidence

Post-op follow-up note does not state the specific procedure or diagnosis being followed. Per ICD-10-CM Sec IV.A, the first-listed diagnosis must be the condition responsible for the encounter.

**Category:** Specificity
**Guideline:** ICD-10-CM Sec IV.A; AHIMA/ACDIS 2026 query rules

**Evidence found:**
- incisions at the elbow
- buried sutures at the wrist
- carpal tunnel dressing

**Evidence missing:**
- specific procedure performed
- date of procedure
- original diagnosis being treated

**Suggested codes:**
- `Z48.815` — Encounter for surgical aftercare on the musculoskeletal system
- `G56.01` — Carpal tunnel syndrome, right upper limb (presumed pre-surgical Dx)
```

The full .md file structure:
```markdown
# CDI Review — <Patient Name> — <Date>

**Doctor:** Dr. <Name>
**Specialty:** <Specialty>
**Mode:** <Mode>
**Overall Quality Score:** <score>/100  ·  Specificity <s>/100  ·  Evidence <e>/100  ·  Completeness <c>/100

---

## Summary

<N> flags raised: <critical-count> critical, <warning-count> warnings, <suggestion-count> suggestions[, <opportunity-count> opportunities].

---

## 🔴 Critical (<N>)
[flag blocks per the format above]

## 🟡 Warnings (<N>)
[flag blocks]

## 🟢 Suggestions (<N>)
[flag blocks]

## 🔵 Opportunities (<N>)  ← only in aggressive mode
[flag blocks]

---

*Generated <timestamp> · Standards: ICD-10-CM FY2026 + AHIMA/ACDIS 2026 + Orthopedics pack v1*
```

The severity emoji + colour cue is the v1 styling. Plan 2 will extend `md_to_docx.py` to add background-coloured cells if we want richer styling.

---

## Skill invocation contract

The skill is invoked from outside (currently for manual testing; in Plan 2, from main.js) as:

```
claude -p "review cdi. Case: <abs-case-dir>. Specialty: <specialty>. Mode: <balanced|compliance|aggressive>. Doctor: <doctor-name>. Standards: <abs-standards-dir>"
```

`Standards:` is the absolute path to the `standards/` directory under `<NOTES_DIR>/.claude/standards/`. If omitted, the skill falls back to `${PWD}/.claude/standards/`.

The skill's Step 0 parses these arguments per the existing pattern in `generate-note` and `edit-note`. **The skill must be invocable from any cwd given absolute paths**, but in practice main.js will run it with `cwd = <NOTES_DIR>` (same as other skills).

---

## File structure to create

```
notes-claude/
├── skills/
│   └── cdi-review/
│       └── SKILL.md                                  ← the skill
└── standards/
    ├── README.md                                     ← what's here, update policy
    ├── icd10_fy2026.md                               ← universal ICD-10 rules
    ├── ahima_acdis_2026.md                           ← universal query rules
    └── specialties/
        └── orthopedics.md                            ← ortho-specific rules
```

Other specialty files (`cardiology.md`, `family_medicine.md`, etc.) — **do not create them**. They're 🔵 Phase 2+; future Claude sessions will drop them in.

### `notes-claude/standards/README.md`

Explain:
- What this directory is
- Naming convention (source guideline → top-level file; specialty rules → `specialties/<name>.md`)
- How to update (replace file content; bump version marker at top of file)
- How the skill consumes these files (which files load when)
- How a future engine (E/M Scorer, WC, Validator) would reference the same content

### `notes-claude/standards/icd10_fy2026.md`

Universal ICD-10-CM rules applicable across all specialties. Should cover:

- **Specificity mandate** (Sec I.B.2, Sec IV.F)
- **Laterality** (Sec I.B.13, Sec I.C.13.a)
- **7th character requirements** for injuries (Sec I.B.X, Sec I.C.19)
- **Outpatient uncertain diagnosis rule** (Sec IV.H — "rule out", "probable", "possible" code as symptoms)
- **First-listed diagnosis** (Sec IV.A, Sec IV.G)
- **Code all coexisting conditions affecting care** (Sec IV.J)
- **Acute vs chronic sequencing** (Sec I.B.8)
- **"With" convention** (Sec I.A.15)
- **Combination codes** (Sec I.B.9)
- **Symptom vs definitive Dx** (Sec I.B.4–6)

Start from Jayanth's "PART 1 — UNIVERSAL OUTPATIENT CODING RULES" section (his Cardiology and Family Medicine files have nearly-identical universal sections — pick the cleanest, merge if needed, verify citations against the official guidelines markdown).

Top of file should have:
```
# ICD-10-CM Universal Coding Rules
**Standards version:** FY2026 (CMS/NCHS, effective 2025-10-01)
**Last reviewed:** 2026-05-19
**Source:** Official FY2026 ICD-10-CM Guidelines for Coding and Reporting
**Used by:** CDI Co-Pilot, future SOAP Validator, future E/M Scorer
```

### `notes-claude/standards/ahima_acdis_2026.md`

AHIMA/ACDIS 2026 query compliance rules. Should cover:

- Non-leading query format requirements
- Multi-choice option requirement (with "clinically undetermined" always an option)
- Per-patient repeat-query rule (the in-app implementation comes later; this file documents the rule)
- 2+ clinical indicators threshold for raising a query
- Query subject/context/question/options/signature format
- Concurrent vs retrospective vs verbal query types

Plus general CDI conduct rules from AHIMA/ACDIS practice briefs.

Source: derive from Jayanth's references, Fahd's `ahima_acdis_2026.yaml`, and verify against publicly-cited AHIMA/ACDIS positions.

Top of file gets the same version header.

### `notes-claude/standards/specialties/orthopedics.md`

Ortho-specific layered rules. Starting point: Jayanth's `CDI_SKILL_ORTHOPEDICS.md` — substantial reworking welcome, but his structure is solid.

Sections to cover:

- **Chapter 13 vs Chapter 19 decision tree** (acute injury vs chronic condition)
- **Anatomic site hierarchy** by region (knee / shoulder / hip / spine / hand-wrist / foot-ankle)
- **Fracture coding** — displaced/non-displaced, open/closed (Gustilo grade), 7th character full set (A/B/C/D/G/K/P/S)
- **Conservative therapy documentation requirements** before surgical authorization
- **Post-op complication coding** (Sec I.B.16 cause-and-effect explicitly)
- **Arthroplasty status codes** (Z96.6x) for follow-up
- **Functional impairment quantification** when ROM/strength is the chief complaint
- **Specialty-specific specificity gaps** common to hand surgery, sports medicine, joint replacement
- **Doctor-style examples** (from Spencer / Sabbag / Dietrick patterns — see `docs/pa-planning/05-engines.md`)
- **Payer-specific ortho add-ons** (from PDF 3 "What Insurers Actually Grade"):
  - ROM documented in degrees (not vague terms like "limited")
  - Named orthopedic tests with explicit positive/negative results (Watson's, Finkelstein's, Tinel's, Phalen's, Spurling's, Lhermitte's, McMurray's, Lachman's, etc.)
  - Specific anatomical levels (e.g. "L3–L4" not just "lumbar")
  - Conservative therapy timeline + failure documented before surgical recommendation
  - Imaging findings interpreted in the note (not just "MRI reviewed")
- **Common ortho specificity traps** (from our doctor examples):
  - "Trigger finger" without specifying which digit (M65.311 vs M65.341 for ring finger)
  - "Carpal tunnel" without laterality (G56.00 unspecified is denied; G56.01/02/03 are billable)
  - "Fracture" without 7th character (A/D/S) or open/closed status
  - "CMC arthritis" without stage (II/III/IV per Eaton classification)

Top of file:
```
# Orthopedics — CDI Rules
**Specialty pack version:** orthopedics v1 (2026-05-19)
**Layered on:** icd10_fy2026.md + ahima_acdis_2026.md (universal rules above are required reading first)
**Applies to:** Outpatient orthopedic clinic encounters
```

### `notes-claude/skills/cdi-review/SKILL.md`

The skill itself. Should be structured similar to `generate-note/SKILL.md` (steps, explicit instructions, file reads).

#### Required steps

**Step 0: Parse arguments.** Extract `case_dir`, `specialty`, `mode`, `doctor_name`, `standards_dir` from the prompt. Validate. If `specialty` is null or not `orthopedics`, output a stub JSON with `error: "specialty not yet supported for CDI v1: <specialty>"` and exit cleanly.

**Step 1: Load inputs.**
- Read `<case_dir>/transcript.md` (may be missing — handle gracefully with a warning)
- Read the `*_soap_note.md` in `<case_dir>` (required — fail if missing)

**Step 2: Load standards.**
- Read `<standards_dir>/icd10_fy2026.md` (universal)
- Read `<standards_dir>/ahima_acdis_2026.md` (universal)
- Read `<standards_dir>/specialties/<specialty>.md` (specialty-specific)
- If specialty file missing → fail with clear error.

**Step 3: Compose the analysis prompt.** Build a system-prompt-style text block that:
- Establishes role ("You are a senior CDI specialist reviewing an outpatient orthopedic encounter for documentation gaps...")
- Embeds the loaded universal rules
- Embeds the loaded specialty rules
- States the operating mode and its specific behavior (see Mode behaviors below)
- Explicitly lists the JSON output schema with examples
- Sets thresholds: max 6 flags in balanced mode, max 8 in aggressive mode, max 4 in compliance mode
- Instructs Claude to **extract diagnoses from the entire note + transcript** before flagging (the "two-pass extraction" pattern — see Sabbag's Marx case in `05-engines.md`)
- Lists the **automatic-critical conditions** below

**Automatic-critical conditions** (these conditions, if detected, must produce a `critical` flag regardless of any other consideration — derived from PDF 2 Section 9 "Automatic Hold Triggers"):

| Condition | Why it's auto-critical |
|---|---|
| AI suggests a Dx not explicitly supported by the encounter, chart, or transcript | Hallucination guard — most dangerous failure mode of an AI CDI engine |
| Laterality conflicts between sections (e.g. HPI says "right" but Plan says "left") | Internal contradiction; flag for resolution before submission |
| Active condition documented as "history of," or historical condition treated as active | Tense/status confusion has billing + clinical safety implications |
| Rule-out / probable / suspected Dx presented as confirmed | Sec IV.H violation |
| HCC-relevant condition suggested without current assessment or treatment evidence | Cannot bill HCC without active management — over-coding risk |
| ICD-10 code suggested doesn't match the documented Dx language | Coder-coupling failure |
| Procedure/surgery in Plan lacks any conservative-therapy history when conventionally required | Prior auth defense gap |

Any of these set both `type: "critical"` AND increment `clinician_approval_required` to `true` in the summary.

**Additional Engine 1 sub-features added via PDF 2 cross-check (treat these as in-scope alongside 1.9–1.18):**
- **Clinical validation** — every Dx must be supported by clinical indicators (symptoms, exam findings, labs, imaging, medications, monitoring). Missing → flag as `Completeness` category. Source: PDF 2 Section 7 (CDI Completeness Rubric criterion 1).
- **Problem-to-plan linkage** — every active Dx must have a corresponding plan item OR a stated reason no action is needed. Missing → flag as `Linkage` category. Source: PDF 2 Section 7 criterion 2.
- **Medical necessity narrative** — the note should explain why THIS visit / test / procedure / therapy is reasonable and necessary. Missing or weak → drive `medical_necessity_status` summary field; raise `Audit-defense` flag if entirely absent. Source: PDF 2 Section 7 criterion 6 + PDF 3 "Big 3 gatekeepers" #1.

**Step 4: Run the analysis.** Use the prompt to produce CDI output as raw JSON. **Always output JSON only, no markdown fences, no preamble, no trailing prose.**

**Step 5: Validate the JSON.** Parse and validate:
- Required fields present
- `type` and `category` enum values valid
- `confidence` is integer 0-100
- `evidence_found` / `evidence_missing` arrays have 0-4 entries
- All `suggested_codes` have both `code` and `description`
- If validation fails, retry once with a corrective prompt. If still fails, save the raw output anyway in a `.cdi.raw.txt` file and produce a stub JSON with `parse_error: true`.

**Step 6: Apply mode filtering.**
- **Balanced:** include all flags. Cap at 6.
- **Compliance:** filter to `critical` + `warning` only. Drop `suggestion` and `opportunity`. Confidence threshold ≥70. Cap at 4.
- **Aggressive:** include all 4 types. Confidence threshold ≥30. Cap at 8.

**Step 7: Compute quality scores.**
- Overall = 100 − (critical × 15) − (warning × 5) − (suggestion × 1) − (opportunity × 0). Floor at 0.
- Specificity sub = function of flag categories where `category = "Specificity"`
- Evidence sub = average confidence × evidence-completeness factor
- Completeness sub = function of `category = "Completeness"` flag count
(Define the formulas in the skill; they don't have to be deep — just consistent and explainable.)

**Step 8: Write outputs.**
- `<case_stem>_cdi.json` (the canonical structured output)
- `<case_stem>_cdi.md` (the rendered markdown, deterministically produced from the JSON)

DOCX conversion is handled by an external Python step (Plan 2 wires it up). The skill should not call `md_to_docx.py` directly.

**Step 9: Confirm completion.** Print a final-line summary:
```
CDI_OK: <abs-path-to-json> · <flag-count> flags · quality <score>/100
```
Or on failure:
```
CDI_FAIL: <reason>
```
(This is what main.js will parse in Plan 2.)

#### Mode behaviors (detailed)

| Mode | Severity filter | Confidence threshold | Cap | Prompt directive |
|---|---|---|---|---|
| **balanced** | All severities; no `opportunity` | ≥50 | 6 | "Flag both under-documentation risks and over-coding risks equally. Surface evidence-based concerns the scribe can act on." |
| **compliance** | `critical` + `warning` only | ≥70 | 4 | "Flag only confirmed documentation risks supported by note evidence. Do not surface revenue opportunities or speculative gaps. Conservative audit-defense stance." |
| **aggressive** | All severities + `opportunity` tier (HCC hints, MDM upgrade paths, missed specificity) | ≥30 | 8 | "Find every legitimate revenue-lift documented enough to query — including HCC capture hints, MDM-upgrade paths, and missed specificity opportunities. Include speculative-but-supported flags as `opportunity` type." |

#### Important skill-level rules

- **No retries on transient failures** beyond the one JSON-validation retry. Fail loudly.
- **Non-blocking output:** if the skill exits non-zero, the calling pipeline must still ship the SOAP docx. The skill itself doesn't enforce this — main.js (Plan 2) does — but the skill should always *try* to write *something*, even on parse errors, so downstream code has a file to point to.
- **Do not call any external tools** (no ICD-10 MCP connector calls in v1). Use the loaded standards files as the source of truth for code suggestions. The MCP connector is a v1.1 enhancement — Plan 2 may explore it.
- **No file I/O outside `<case_dir>` and `<standards_dir>`.** Don't write to logs, scratch dirs, etc. Skill is pure: inputs in, outputs in case dir.

---

## Test scenarios — DOCUMENT, DO NOT EXECUTE

**⚠ IMPORTANT FOR THE IMPLEMENTING SESSION:** Do NOT actually invoke `claude -p` to test the skill yourself during implementation. Nested `claude -p` calls inside your session waste tokens, are slow, may fail on auth/model issues, and aren't your job. Test execution happens *after* this plan is merged — run by the human user against real cases.

**Your task here:** create a `TESTS.md` file alongside the skill (`notes-claude/skills/cdi-review/TESTS.md`) that documents the recommended test scenarios as a checklist for the human to run. Treat it as a regression-test specification, not as something to execute.

### Test scenarios to document in `TESTS.md`

**Scenario 1 — Spencer post-op note (the Cecil Daniels case):**
- Setup: a case folder containing a real Spencer post-op SOAP note like Cecil Daniels 3/11/2026 (short dictation style, missing primary Dx, no laterality, conservative-therapy lacking)
- Invocation: `claude -p "review cdi. Case: <path>. Specialty: orthopedics. Mode: balanced. Doctor: Spencer. Standards: <path>/standards"`
- Expected: ~6 flags including:
  - `critical` — Primary diagnosis missing
  - `warning` — Laterality not specified
  - `warning` — 7th character missing on post-op aftercare
  - `warning` — Medical necessity not documented
  - `suggestion` — Implied order not explicit ("consider hand therapy")
  - `suggestion` — Patient education not documented
- Verify: JSON validates, MD renders cleanly, summary `claim_defense_readiness` is `needs_edits` or `hold_for_review`

**Scenario 2 — Sabbag follow-up note (the James Marx EMG case):**
- Setup: a Sabbag note with EMG findings naming 3 conditions but only 1 in Assessment, blank PMH fields, surgery recommended without enumerated conservative therapy
- Invocation: same shape, Specialty `orthopedics`, Mode `balanced`, Doctor `Sabbag`
- Expected: ~5–6 flags including:
  - `critical` — Coexisting diagnoses not coded (the auto-critical condition: documented in note but missing from Assessment)
  - `warning` — Blank PMH/PSH affecting HCC capture
  - `warning` — Failed conservative therapy not enumerated before surgical recommendation
  - `suggestion` — High MDM but time not documented
- Verify: `clinician_approval_required: true` due to critical flag

**Scenario 3 — Mode comparison on same input:**
- Run scenarios 1 and 2 three times each (Compliance / Balanced / Aggressive)
- Verify:
  - Compliance has fewer total flags, no `suggestion` or `opportunity` types
  - Aggressive has more flags, includes `opportunity` tier with HCC hints
  - Balanced sits between, no `opportunity` tier

**Scenario 4 — Edge cases:**
- Specialty = `cardiology` → stub JSON with `error: "specialty not yet supported for CDI v1: cardiology"`, no crash
- Specialty = `null` or empty → same stub
- Missing SOAP file in case dir → clear error message, exit non-zero
- Missing transcript file but SOAP present → warning logged, analysis proceeds on SOAP alone
- Standards directory missing → clear error, exit non-zero

**Scenario 5 — JSON validation:**
- Run any scenario above
- Run `python3 -m json.tool <case>_cdi.json` to verify the file is valid JSON
- Spot-check that all required fields are present per the schema in this plan

**Scenario 6 — Markdown rendering:**
- Open the generated `.md` file
- Verify severity emoji + headings + ICD codes in code blocks + evidence found/missing sections all render
- Verify the docx converts cleanly via the existing `python/md_to_docx.py` (manual: `python3 python/md_to_docx.py <case>_cdi.md`)

Format `TESTS.md` as a checklist (one section per scenario, with checkboxes for sub-items). Future regressions can be caught by re-running these against new model versions or skill updates.

---

## Deliverables checklist (when this plan is complete)

**The implementing session is responsible for producing these artifacts. Test EXECUTION happens later — see the Test scenarios section.**

Files to create:
- [ ] `notes-claude/skills/cdi-review/SKILL.md` written; follows the structural conventions of existing skills (Step 0 parses arguments, numbered steps, explicit instructions, file reads)
- [ ] `notes-claude/skills/cdi-review/TESTS.md` written; documents the 6 test scenarios from this plan as a checklist for the human to run later
- [ ] `notes-claude/standards/README.md` written; explains the directory layout, update policy, and which engines consume which files
- [ ] `notes-claude/standards/icd10_fy2026.md` written; covers universal ICD-10 rules (specificity, laterality, 7th character, uncertain Dx, first-listed Dx, coexisting conditions, "with" convention, acute-before-chronic sequencing)
- [ ] `notes-claude/standards/ahima_acdis_2026.md` written; covers query compliance rules, non-leading format, multi-choice requirement, repeat-query rule
- [ ] `notes-claude/standards/specialties/orthopedics.md` written; covers Chapter 13 vs 19 decision, anatomy hierarchy, fracture coding, conservative-therapy documentation, payer-specific ortho add-ons (ROM in degrees, named tests, anatomical levels), and the common ortho specificity traps listed above

JSON schema correctness:
- [ ] Output JSON includes all summary-level fields: `medical_necessity_status` (enum), `claim_defense_readiness` (enum), `clinician_approval_required` (boolean)
- [ ] Output JSON `flags[].category` uses one of the 5 enum values (Specificity / Linkage / HCC / Completeness / Audit-defense)
- [ ] Output JSON `flags[].type` uses one of the 4 enum values; `opportunity` appears only in aggressive mode

Prompt content (verifiable by reading SKILL.md):
- [ ] Step 3's analysis prompt lists the 7 automatic-critical conditions from this plan
- [ ] Step 3 explicitly instructs Claude to extract diagnoses from the entire note + transcript before flagging (two-pass pattern)
- [ ] Step 3 includes the additional sub-features beyond 1.9–1.18: Clinical Validation, Problem-to-Plan Linkage, Medical Necessity Narrative
- [ ] Mode behaviors (Compliance / Balanced / Aggressive) implement the 3-axis differences: severity filter, confidence threshold, prompt directive

Documentation updates in the same PR:
- [ ] `CLAUDE.md` "Quick references" section adds the new skill + the `standards/` directory
- [ ] `CLAUDE.md` "Code map" section adds the `notes-claude/skills/cdi-review/` and `notes-claude/standards/` directories
- [ ] `CLAUDE.md` "Don't touch without thinking" — the new skill prompt signature (`review cdi. Case: X. Specialty: Y. ...`) joins the existing list of skill prompt formats
- [ ] `docs/DECISIONS.md` — append-only entry explaining: "CDI v1 ships as a standalone skill invocable via `claude -p`; rules live in markdown standards files under `notes-claude/standards/`; output is JSON-canonical, MD-rendered, DOCX-derived. Non-blocking — pipeline must complete even if the skill fails. The implementing session was instructed not to execute the test scenarios; those are run by the human after merge."

Out of scope (Plan 2):
- [ ] **No changes to** `main.js`, `preload.js`, `renderer/`, `python/*.py`, or `db/` — those are Plan 2
- [ ] **No actual test execution** — the implementing session documents test scenarios in TESTS.md but does not invoke `claude -p` to run them

---

## Open items the implementing session may surface

Things this plan deliberately doesn't fully specify — the implementing session has latitude here. If a real decision is made, document it in `docs/DECISIONS.md`.

- **Exact quality-score formula coefficients** — the plan gives a rough shape ("100 − critical×15 − warning×5 − suggestion×1"). The implementing session may adjust coefficients if testing shows scores collapse too easily or distribute weirdly.
- **Verbosity of the universal standards files** — Jayanth's universal sections are ~5 KB each. The implementing session may compress further if it helps the runtime LLM focus, or expand if more nuance is needed.
- **Whether to include specific example codes in `orthopedics.md`** — e.g., explicit listings like "M65.341 — Trigger finger, right ring finger." Claude's training covers FY2026 codes well enough that an exhaustive list isn't required, but a curated set of example codes for common ortho conditions is helpful. Implementing session calls it.
- **Two-pass extraction prompt design** — the plan specifies the *behavior* (extract first, then flag). The implementing session decides whether this is expressed as an explicit two-step prompt instruction or trusted as a single-shot LLM behavior. Both have tradeoffs.
- **How the `medical_necessity_status` enum is determined** — the plan defines the field but not the precise logic. Implementing session writes prompt guidance that maps note content → `supported / weak / missing`. E.g., explicit medical-necessity statement present → `supported`; mentioned but not justified → `weak`; not addressed at all → `missing`.

### Items NOT open — locked-in decisions

These were debated earlier and are settled. Don't relitigate:

- ✅ Output is JSON-canonical with MD rendered from JSON, DOCX from MD (3 files)
- ✅ Mode caps: Compliance 4, Balanced 6, Aggressive 8 flags max
- ✅ Specialty fallback: NULL or unknown → stub output with `error: "specialty not yet supported"`, no generic universal-only fallback
- ✅ Non-blocking: skill failure must not break Plan 2's pipeline (architectural — the skill should still try to write *something* even on parse errors)
- ✅ Skill content is portable to future deployment modes (Anthropic API / managed agents) — no MCP/API-specific assumptions in the skill itself
- ✅ ICD-10 markdown handoff: citation-verification reference, don't try to ingest 121 pages cover-to-cover

---

## Next plan (preview)

After this plan ships, Plan 2 (CDI v1 — App integration) will cover:
- `spawnCdiReview` in main.js (mirrors `spawnSoapGeneration` pattern, non-blocking)
- Pipeline order: SOAP → SOAP-docx (fast) → CDI (slow, parallel-safe)
- Status popup updates: per-case CDI progress indicator
- `processing_events` row per CDI invocation (uses new SQLite tables)
- Doctor settings UI: specialty dropdown, `enable_cdi` toggle, mode selector
- `md_to_docx.py` extension for CDI-specific styling (severity-coloured cells, ICD-code highlighting)
- IPC events for "CDI complete" notification
- Windows file hiding for `*_cdi.md` and `*_cdi.json`
- Open-button addition in status popup for the CDI docx

That plan is written *after* the skill from this plan is verified manually on real cases.

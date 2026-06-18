# Dr. Costigan Procedure-Checklist Skill — a CDI variant

**Date:** 2026-06-05 · **Owner:** rs · **Status:** Implemented (skill + standards only; UI/pipeline wiring deferred to the refactor)

---

## What this is

A new standalone skill — `cdi-costigan` — that checks a **complete** interventional-pain note against Medicare medical-necessity checklists, the same way `cdi-review` checks a note against CDI standards. It is a **CDI variant**: complete-note input, evidence extraction with verbatim quotes, ICD-10 MCP connector validation of every code, a single-line JSON manifest as the final response line plus a deterministically-rendered markdown report, parsed by the existing `parseSkillManifest()`. Its **output shape is checklist-style, not flag-style** — that divergence from `cdi-review` is expected and fine.

Scope of this deliverable: **skill + structured checklist rubric packs only.** No UI, no `main.js` pipeline wiring, no DB. Skills live in `notes-claude/`, which the refactor leaves untouched, so this is safe to build now. App integration is a later step that the refactor's engine framework will absorb.

## Who / why (the target)

Dr. William Costigan is a Cedars-Sinai spine / interventional-pain physician. His interventional-procedure claims were getting denied. Cedars went through a Medicare **Targeted Probe & Educate (TPE)** audit (MAC: **Noridian**, jurisdiction J-E, California) on **CPT 64483** (transforaminal epidural, single level): 30 claims pre-payment reviewed, **23.3% error rate**, 7 denied, 0 correctly coded, Corrective Action Plan required. Cedars' Compliance & Revenue Integrity (CRI) team then produced per-procedure medical-necessity checklists derived from the governing LCDs. This skill encodes those checklists and runs a complete Costigan note against them so the documentation survives audit.

This is **procedure-specific medical-necessity validation** — sharper and more measurable than general CDI, and it maps 1:1 to what a Noridian auditor checks.

## The input (learned from the real samples)

The 89 sample notes are **Workers' Comp clinic follow-up / consultation reports (PR-1 / PR-2)**, not procedure-day op-notes. The critical realization that shapes the whole design:

- **The "procedure in play" is usually a *requested / recommended* injection, not a performed one.** E.g. Cedillos: *"I recommended a lumbar facet block from L4 to S1 … Please accept this report as my formal request for authorization for: Lumbar facet block injection from L4 to S1."* So the skill is a **pre-authorization medical-necessity check**: *does this note carry the documentation that will make the requested (or performed) injection survive review?* That is exactly the TPE surface.
- **Longitudinal data is rich but messy.** Tenorio lists **8 prior LESIs with exact dates** in both HPI prose and a Past Surgical History table — but **no relief % for any of them**. That is a real audit gap (repeat ESI requires ≥50% relief sustained ≥3 mo on a *named* scale). The skill must extract prior-procedure dates and reason over the history, and surface the absence of relief data as a gap.
- **The named pain scale is present but minimal** — "VAS: 8/10" in the exam, "rates pain 6/10" in HPI — and the **same-scale follow-up comparison the LCD demands is usually absent.**
- **Notes are dense prose + a structured exam block.** The pain scale and provocative tests live in the PHYSICAL EXAM section; diagnoses in ASSESSMENT/PLAN; prior dates in HPI and the Past Surgical History table. Evidence extraction must read all of it.
- These are full EMR charts (HPI, exam, imaging impressions, A&P, diagnoses) — richer than the doctor's `MASTER_PROMPT` output (which generates only HPI + A&P). The `MASTER_PROMPT` is doctor-style hints only; it does **not** constrain this skill.

## Design

### Two-layer validation per procedure

**(A) Clinical medical-necessity** — the checklist criteria + documentation rules: named pain scale at baseline **and the same scale at follow-up**; functional / disability index (ODI / RDQ / etc.); enumerated conservative care with duration; concordant imaging; specific exam findings; for repeats: % relief with **specific dates** on the same scale; image-guidance + contrast.

**(B) Coding correctness** — does the documented diagnosis map to a **covered ICD-10** for that procedure's CPT; correct CPT + modifiers (**KX** on Facet/SI diagnostic — if omitted it silently counts against the therapeutic cap; **-50** bilateral); within **frequency caps** per rolling 12 months.

### Flow

1. **Detect** which procedure(s) are in play (performed or requested) from the note.
2. **Load** the matching rubric pack(s) from `standards/procedures/`.
3. **Evaluate** each checklist item against the note: **met / not-met / unclear**, each with a verbatim evidence quote and, when missing, the specific fix.
4. **Connector-validate** every ICD code touched (De Quervain discipline — connector is ground truth, never emit a non-existent code).
5. **Verdict** per procedure: audit-ready / N gaps → likely denied for X.
6. Emit the **JSON manifest** (last line) + render the **checklist markdown**.

Item wording mirrors the CRI checklists exactly, so the output maps 1:1 to what an auditor checks.

### Coverage

All 5 procedures, **ESI made rock-solid first** (his bread-and-butter + the audited procedure). PVA/VCF is the odd one out (one-time augmentation; inclusion/exclusion criteria, no repeat-relief thresholds).

## The rubric packs (the main substance)

`notes-claude/standards/procedures/{esi,facet,tpi,si,pva}.md` — one per procedure. Each carries, as structured data:

- The verbatim CRI checklist items (so output maps 1:1).
- Thresholds (relief %, durations) and frequency caps per rolling 12 months.
- CPT codes + modifiers.
- **Covered ICD-10 list** — connector-validated (see below).
- Exclusions / non-covered indications.
- A `procedures/README.md` explaining the pack shape + update policy.

### Connector validation done up front (this pass)

Every ICD code that went into a pack was validated against the live ICD-10 MCP connector before being written. Results:

- **Facet** covered ICD ranges all confirmed billable: M47.812–M47.817, M47.892–M47.897, M48.12–M48.17, and M53.82–M53.87 (facet cyst). The bare `M47.81` / `M47.89` / `M48.1` / `M53.8` are non-billable headers.
- **PVA Group 1** (osteoporotic): M80.08XA/XS, M80.88XA/XS — all billable. **Group 2** (malignant, requires 2 codes): C41.2, C79.51, C79.52, C90.00, C90.01, C90.02, plus M84.58XA/XS — all billable.
- **TPI**: G44.201, .209, .211, .219, .221, .229 (tension headache) + M79.10, .11, .12, .18 (myalgia) — all billable. (Verified `.211`/`.219` directly since they sit in a separate `G44.21` sub-branch.)
- **SI**: M43.28, M46.1, M47.818, M53.3 — all billable. Special case **M79.18** for SI injection **without** fluoro (use 20552, one unit). SI RFA (CPT 64625) is **non-covered**.
- **ESI**: the LCD/deck publishes **no closed ICD table** — coverage is narrative (radiculopathy / stenosis / post-laminectomy / acute zoster). The ESI pack therefore lists connector-validated *representative* codes per documented indication (M54.12–.17 radiculopathy, M48.061/.062 lumbar stenosis ±neurogenic claudication, M51.16 disc-with-radiculopathy lumbar, M96.1 post-laminectomy, B02.2x zoster) and explicitly does **not** assert a closed covered list.
- **Trap recorded**: `M51.36` (lumbar DDD) exists but is **a header only, not billable** — and DDD-without-radiculopathy is not an ESI indication anyway. The packs note this.

The connector **wins** over the prose packs whenever they disagree about code existence or available specificity — same rule as `cdi-review`.

## Skill output contract

Mirrors `cdi-review`'s reliability machinery exactly:

- Permissions pre-flight; argument parse with a clean **skip** path (no procedure detected → write a "no interventional procedure found" report, status `skipped`, no crash).
- Per-procedure checklist JSON written with the Write tool; validated with `python3 -m json.tool`; one regeneration retry; stub-on-failure so downstream always has a file.
- Deterministic markdown render from the JSON (embedded Python), so JSON and MD never drift.
- **Single-line JSON manifest** as the final response line (`schema_version:1`, `skill:"cdi-costigan"`), consumed by `parseSkillManifest()`; filesystem fallback to the on-disk `_costigan.json` if the manifest line is missing — the same load-bearing reliability layer `cdi-review` relies on.

Output files per case: `<case>_costigan.json` + `<case>_costigan.md` (naming parallels `_cdi.*`). The prompt signature the future app step will use:
`check costigan procedures. Case: <abs-case-dir>. Standards: <abs-standards-dir>.`

## Scope guards (followed)

- Skill + standards packs **only**. No UI. No edits to existing skills (`cdi-review` / `add-icd-codes` / `generate-note`) or `main.js`. Additive.
- No edits under `/Users/rish/Development/PA/` (external reference docs — read-only source).
- Plan written **and** implemented in the same pass; user reviews once it is all done.
- A dated `DECISIONS.md` entry records the connector-validated code findings and the ESI "no closed ICD list" asymmetry.

## Deliverables

1. This plan doc.
2. `notes-claude/standards/procedures/{esi,facet,tpi,si,pva}.md` + `procedures/README.md` — the structured rubric packs (ESI fullest), every code connector-validated.
3. `notes-claude/skills/cdi-costigan/SKILL.md` + `TESTS.md` — the standalone skill, JSON manifest + rendered checklist, connector-validated codes.

# Standards

Authoritative reference content consumed at runtime by the CDI Co-Pilot (`cdi-review` skill) and — in future iterations — by other review engines (SOAP Validator, E/M Scorer, Workers Comp, etc.).

Files here are **plain markdown by design**: a runtime LLM reads them as context, so they need to be human-readable and citation-dense rather than machine-parseable. Keep prose tight; lead with the rule, cite the section, give the failure mode.

---

## Directory layout

```
standards/
├── README.md                       this file
├── icd10_fy2026.md                 ICD-10-CM universal rules (every specialty)
├── ahima_acdis_2026.md             query-compliance + CDI conduct rules
└── specialties/
    └── orthopedics.md              ortho-specific specificity + payer rules
    # cardiology.md, family_medicine.md, etc. — drop in as we onboard those specialties
```

**Top-level files** = universal rules that apply to every encounter, regardless of doctor specialty. The CDI skill always loads these.

**`specialties/<name>.md`** = specialty-specific layered rules. The CDI skill loads the file matching the doctor's specialty (`<doctor.specialty>.lower() + ".md"`). If the file is missing, the skill bails with a "specialty not yet supported" stub output — no generic universal-only fallback (see [docs/pa-planning/04-open-questions.md](../../docs/pa-planning/04-open-questions.md), Round 2 question A).

---

## Naming convention

| Pattern | Use |
|---|---|
| `<source>_<year>.md` (top level) | Universal pack derived from a single authoritative source. Examples: `icd10_fy2026.md`, `ahima_acdis_2026.md`. |
| `specialties/<specialty>.md` | Specialty-specific layered rules. Lowercase, single word (`orthopedics.md`, `cardiology.md`). Match `doctor.specialty` exactly (lowercase). |

Add a new specialty by dropping a file into `specialties/`. No code change is required — the CDI skill discovers it at runtime.

---

## Update policy

1. **Bump the version header.** Every file leads with a small frontmatter-style block:
   ```
   **Standards version:** FY2026 (CMS / NCHS, effective 2025-10-01)
   **Last reviewed:** 2026-05-19
   **Source:** Official FY2026 ICD-10-CM Guidelines for Coding and Reporting
   **Used by:** CDI Co-Pilot, future SOAP Validator, future E/M Scorer
   ```
   When the source guideline ships a new fiscal year (FY2027 lands October 2026), replace the file content and bump the version header. The CDI skill propagates the version into every output's `meta.standards_versions` field.

2. **Replace, don't append.** Old rules should be deleted, not stacked. CMS supersedes prior years cleanly — don't carry historical guidance forward in the same file.

3. **Cite, don't paraphrase.** Each rule should point to a section reference (`Sec I.B.13`, `Sec IV.H`, etc.) the runtime LLM can quote in a CDI flag's `guideline_reference`. The official ICD-10-CM source markdown at `/Users/rish/Development/PA/Fahd doc/icd_10_cm_october_2025_guidelines_0.md` is the verification reference — when in doubt, grep it.

4. **Keep it short.** Aim for ~3–10 KB per file. The skill loads three of these into context per invocation. The orthopedics pack is the longest because it covers the most ground.

5. **Test after updating.** Run the documented test scenarios in [../skills/cdi-review/TESTS.md](../skills/cdi-review/TESTS.md) — at minimum scenario 1 and scenario 4 — against the updated standards. The CDI output should still validate and produce sensible flags.

---

## How the CDI skill consumes these files

The CDI skill ([../skills/cdi-review/SKILL.md](../skills/cdi-review/SKILL.md)) loads, in order:

1. **`icd10_fy2026.md`** — every invocation. Universal ICD-10 rules.
2. **`ahima_acdis_2026.md`** — every invocation. Query compliance + CDI conduct rules. Shapes flag wording.
3. **`specialties/<doctor.specialty>.md`** — every invocation. Specialty-specific rules layered on top of the universals.

Citation behavior: when a flag has a `guideline_reference`, it should cite the section that governs the rule (e.g., `ICD-10-CM Sec IV.H` for an uncertain-Dx flag, `AHIMA / ACDIS 2026 §2 (non-leading format)` for a query-wording flag, `Ortho pack §3 (fracture coding)` for a 7th-character flag).

---

## How a future engine should consume these files

The same files are designed to be reused by other review engines. The expected pattern:

| Future engine | Files it would load |
|---|---|
| **SOAP Validator** (structural completeness) | `ahima_acdis_2026.md` (for conduct rules around the structural-completeness checks) + a future `ambci_proof_map.md` (the 25-point billing evidence map) + specialty file. |
| **E/M MDM Scorer** | A future `ama_em_2023.md` (the MDM table + risk examples) + specialty file (for specialty-specific risk-level cues). |
| **Workers Comp Report Generator** | A future `ca_dwc_2026.md` (PR-1 / PR-2 / PR-4 requirements) + specialty file. |
| **Patient Summary Generator** | No standards file needed — the source is the SOAP note itself. |
| **Specificity Dictionary** (E3a) | A future `specificity_dictionary_v2026.md` (the curated 20–50 vague-Dx list with required modifiers). |

When you add an engine, decide which files it should consume and add a one-line note under §"Used by:" at the top of each file you read. That cross-reference is how a future Claude session traces the dependency graph.

---

## What's NOT in this directory

- **Doctor templates** (`<NOTES_DIR>/templates/`) — those are per-doctor profile content, not standards.
- **Skill code** (`../skills/<name>/SKILL.md`) — engines live next door, not in this folder.
- **Per-patient or per-case data** — case folders live under `<NOTES_DIR>/Cases/`.
- **Settings or runtime state** — `<NOTES_DIR>/settings.json`, `<NOTES_DIR>/app.db`, `<NOTES_DIR>/.template_job.json`.

If you find yourself wanting to put any of the above in `standards/`, it's a sign the engine should be reading them from their canonical location instead.

# PA Engines v0.2 — E/M Scorer, Provider Query, E/M Reimbursement Signal, Patient Summary

**Owner:** rs
**Status:** Implemented on branch `feature/pa-engines-v0.2` (off `develop`)
**Date:** 2026-06-11

> **Architecture note (decided 2026-06-11):** this batch ships the engines **integrated into the per-case pipeline, gated by per-engine toggles** — not the on-demand/ephemeral design an earlier draft of this plan described. Toggle ON ⇒ the engine runs on every case after CDI and persists; toggle OFF ⇒ skipped. The on-demand/manual-tab surface and the JSON→HTML→PDF presentation layer are a **separate next step** (see §8). The dev-only `feature/cdi-manual-tab` branch is unrelated and stays a reference.

---

## 0. What this is (and what it deliberately is not)

The next batch of PA capabilities on top of the shipped CDI work. **Four** deliverables — two new pipeline engines, two extensions to the existing `cdi-review` skill:

1. **E/M MDM Scorer** — NEW engine + skill `em-score`. Predicts the AMA 2021 Office/Outpatient E/M level (99202–99215) from a SOAP note and flags down-code risk. Connector-free (CPT/AMA rules).
2. **Provider Query Generator** — EXTEND `cdi-review`. Turn the CDI flags it already produces into compliant, non-leading provider queries (rides with `enableCdi`).
3. **Per-flag E/M reimbursement signal** — EXTEND `cdi-review`. Populate the existing (mostly-null) `reimbursement_impact` field with concrete E/M signals. Depends on #1's grid pack.
4. **Patient Summary** — NEW engine + skill `patient-summary`. A plain-language, patient-facing recap of the visit.

### Hard constraints (as finalized 2026-06-11)

- **Pipeline-integrated + toggle-gated.** `em-score` and `patient-summary` are real engine descriptors **registered in `src/engines/registry.js`**, run in the per-case chain after CDI. Each gates itself off when its toggle is off (`gates()` returns `[{reason:'disabled'}]`). Run **sequentially** (simple status; concurrency is a later change).
- **Save JSON + DB entries.** Each new engine writes its canonical JSON to the case folder **and** one row to a generic `engine_outputs` DB table (§5). No new per-`cases` columns (avoids the `cdi_*` splatter).
- **No MD for the two new engines.** `em-score` and `patient-summary` emit **JSON only** (no markdown render, no docx) — presentation is rendered from JSON in the next step (§8). **The SOAP note's `.md → .docx` stays; ICD still appends codes into the SOAP `.md`; CDI keeps its `_cdi.md` + docx — all unchanged.** (rish: "keep md for now" was specifically about not removing CDI's existing render.)
- **Provider query + reimbursement ride with CDI.** No own toggles — when `cdi-review` runs (gated by `enableCdi`), they're produced as additive output.
- **Connector discipline.** Any ICD code a skill emits MUST be ICD-10-MCP-validated before output — connector wins over the prose packs (De Quervain rule). em-score / patient-summary emit no ICD codes by design.
- **Out of scope this cycle:** Clinical Order Generation (**on hold** — see §8), SOAP validator, rules pre-filter, offline ICD, re-run-on-edit, more specialties, full HCC, and the on-demand/manual-tab UI + JSON→HTML→PDF presentation (next step).

### Sequencing

`#1 (em_mdm pack + em-score) → #3 (reimbursement, consumes the pack)`. #2 and #4 are independent. The em_mdm pack blocks both #1's skill and #3.

---

## 1. Grounding — current repo state (verified 2026-06-11)

### 1.1 Engine framework (`src/engines/`)
`runEngine(engine, ctx, caseCtx)` (`engineRunner.js`) drives every descriptor: **gates → reportStage(running) → startEvent(DB) → buildPrompt+runSkill → classify(rate-limit/MCP) → interpret → finishEvent(DB) → persist → service-warning → reportStage(complete)**. Descriptor shape (from `cdi.js`/`icd.js`): `id, skillId, label, jobKind, stage, completesCase, model(cfg), effort, gates, buildInput, interpret, persist, render`. `registry.js` is `[soap, icd, cdi]` (ordered); `chain.js runCaseChain` runs them then docx. `runMultiPatientChain` calls `runCaseChain` per child, so new engines apply to multi-patient automatically.

### 1.2 Skill contract
Skill ends its final assistant line with a single-line JSON manifest (`schema_version:1`, `skill`, `status`, paths); `parseSkillManifest()` reads it; engine `interpret()` falls back to the on-disk JSON if the line is missing (rate-limit truncation) — `synthesizeManifestFromDisk` in `cdi.js` is the template. Pre-flight permission block + JSON-validate-with-one-retry + stub-on-fail — mirror `cdi-costigan`.

### 1.3 DB (`db/`)
Numbered migrations `NNN_*.sql` (runner globs `^\d{3}`, strips the trailing `PRAGMA user_version`, applies in a transaction, sets the version itself). Latest is `004`. `cdi_flags.reimbursement_impact` column **exists** (004) and `db/cdi_flags.js insertFlags()` **already writes it**; `cdi.persist()` calls it (live since `7c39e13`). So **#3 needs zero DB work**. `db/cases.js` has `createCase/updateCasePaths/updateCaseCdi/...`; `db/init.js` has `getDb`. The `cdi_*` columns on `cases` are the splatter pattern we do **not** repeat.

### 1.4 Standards packs
`ahima_acdis_2026.md` already holds the provider-query rules (§1–6: when-appropriate, two-indicator threshold, non-leading format, mandatory "Clinically undetermined" option, required query elements) — #2 consumes it, no new pack. **No E/M MDM grid pack exists** — #1 authors `em_mdm_2021.md`.

---

## 2. Deliverable #1 — E/M MDM Scorer (`em-score`)

### 2.1 Standards pack — `notes-claude/standards/em_mdm_2021.md` *(dependency for #3)*
Authored this batch. Encode the **AMA 2021 Office/Outpatient E/M MDM framework**: the 3 elements (Problems Addressed / Data Reviewed & Analyzed / Risk) with the 4 level definitions each; the 2-of-3 rule; the level↔CPT mapping (99202–99205 new, 99212–99215 established; 99201 deleted, 99211 nurse-visit); the time-based alternative + 2021 time thresholds; worked examples + down-code drivers. Header with provenance + `**Standards version:** em_mdm 2021 v1`; note it's connector-free.

**Validation (source of truth):** source-check every CPT code/descriptor/time-threshold against AMA CPT 2021 / CMS — **the ICD-10 connector cannot validate CPT** (ICD-only). Connector-validate any ICD reference (prefer none; keep the pack connector-clean).

### 2.2 Skill — `notes-claude/skills/em-score/{SKILL.md,TESTS.md}`
Mirror `cdi-costigan` (pre-flight, arg parse, JSON-validate+retry+stub, manifest-as-final-line). **JSON only — no MD render, no docx.**
- Prompt: `score em. Case: <abs-case-dir>. Specialty: <name>. Standards: <abs-standards-dir>`.
- Inputs: `<stem>_soap_note.md` + `em_mdm_2021.md`. **Visit type parsed from the note** (new/established/follow-up/post-op); if absent → infer + set `visit_type_assumed:true` + flag in `headline`. No dropdown (no UI).
- Output `<stem>_em.json`: `predicted_em_level`, `predicted_complexity`, `downcode_risk`, `mdm_elements{problems_addressed,data_reviewed,risk}{score,drivers[],documentation_gap}`, `final_level_basis`, `upgrade_path`, `time_alternative{documented_minutes,level_if_time}`, `headline`, `visit_type`, `visit_type_assumed`, `meta`.
- Manifest (final line): `{schema_version:1, skill:'em-score', status, json_path, predicted_em_level, predicted_complexity, downcode_risk, error, skipped_reason}`.
- Connector-free at run time. Skip path: non-E/M encounter (pure op-note) → `skipped`.

### 2.3 Engine descriptor — `src/engines/emScore.js` (REGISTERED)
`id:'em-score'`, `skillId:'em-score'`, `jobKind:'em_score'`, `stage:'scoring_em'`, `completesCase:false`, `model:(cfg)=>cfg.soapModel||'claude-sonnet-4-6'`, `effort:'high'`. `gates`: skip if `!enableEmScore`. `buildInput`: `{caseDir, specialty, standardsDir}`. `interpret`: manifest + on-disk `<stem>_em.json` fallback (`synthesizeEmFromDisk`). `persist`: one `engine_outputs` row (`engine:'em-score'`, status, json_path, `summaryJson:{predicted_em_level,predicted_complexity,downcode_risk}`, eventId). Registered in `registry.js`, run in `chain.js` after CDI.

---

## 3. Deliverables #2 & #3 — extend `cdi-review`

### 3.1 #2 Provider Query Generator
Extend the per-flag schema (Step 3) with an **optional** `provider_query{query_type:multiple_choice|open_ended, question, clinical_indicators[], options[]}` on flags warranting clarification, plus a top-level `queries[]` convenience array. Enforce AHIMA §1–6: non-leading; ≥2 indicators for a new-Dx query (else no query); MC needs ≥3 mutually-exclusive options incl. **"Clinically undetermined"** last; no single-option; indicators verbatim from `evidence_found`; never introduce an unvalidated ICD code. Queries follow the parent flag's mode filter. Step 8 MD render: add a "Provider queries" section (CDI keeps its MD). Step 9 manifest: add `query_count`. **Rides with `enableCdi`** — no own toggle. Persistence: queries live in the on-disk `<case>_cdi.json` (already read by `cdi.persist()`); no DB column.

### 3.2 #3 Per-flag E/M reimbursement signal
Step 2: load `em_mdm_2021.md`. Step 3 field/behavior rules: populate the existing `reimbursement_impact` field with a concrete E/M signal when a flag's fix raises an MDM element and changes the 2-of-3 outcome (e.g. *"Documenting independent test interpretation moves Data to Moderate → supports 99214 over 99213"*). Keep **default-null, never-fabricate**. **No DB work** — the column + `insertFlags` write + `persist()` call already exist (§1.3). Depends on #1's pack.

---

## 4. Deliverable #4 — Patient Summary (`patient-summary`)

### 4.1 Skill — `notes-claude/skills/patient-summary/{SKILL.md,TESTS.md}`
Mirror `cdi-costigan`. **JSON only, connector-free, no standards pack.**
- Prompt: `summarize for patient. Case: <abs-case-dir>`.
- Input: `<stem>_soap_note.md`. Output `<stem>_patient_summary.json`: `reading_level` (~grade 6), `sections{whats_going_on, your_plan, medications, follow_up, when_to_seek_help}`, `headline`, `meta`.
- Plain language, second person, no codes/jargon. **Restates the note — never invents meds/doses/instructions**; says so plainly when a section is empty.
- Manifest: `{schema_version:1, skill:'patient-summary', status, json_path, reading_level, error, skipped_reason}`.

### 4.2 Engine descriptor — `src/engines/patientSummary.js` (REGISTERED)
`id:'patient-summary'`, `skillId:'patient-summary'`, `jobKind:'patient_summary'`, `stage:'patient_summary'`. `gates`: skip if `!enablePatientSummary`. `buildInput`: `{caseDir}`. `interpret`: manifest + on-disk fallback. `persist`: one `engine_outputs` row (`summaryJson:{reading_level}`). Registered, run after em-score.

---

## 5. DB — generic `engine_outputs` table

New migration `db/migrations/005_add_engine_outputs.sql` + `db/engine_outputs.js`:

```sql
CREATE TABLE IF NOT EXISTS engine_outputs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      TEXT,
  engine       TEXT NOT NULL,        -- 'em-score' | 'patient-summary'
  status       TEXT NOT NULL,        -- 'ok' | 'skipped' | 'failed'
  json_path    TEXT,
  summary_json TEXT,                 -- compact headline fields for list views
  event_id     INTEGER,              -- processing_events.id (nullable)
  created_at   TEXT NOT NULL,
  FOREIGN KEY (case_id)  REFERENCES cases(id)             ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES processing_events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_engine_outputs_case ON engine_outputs (case_id, engine, created_at DESC);
PRAGMA user_version = 5;
```
`db/engine_outputs.js`: `insertOutput({caseId, engine, status, jsonPath, summaryJson, eventId})` — best-effort, `JSON.stringify(summaryJson)`, ISO `created_at`, returns row id or 0; mirrors `db/cdi_flags.js` style. **One row per (case, engine) run. No new `cases` columns.** CDI/ICD keep their existing storage untouched. This is the anti-splatter pattern — every future engine routes through this table, never new columns.

---

## 6. Settings / toggles

`config/settings.js DEFAULT_SETTINGS`: add `enableEmScore:false`, `enablePatientSummary:false` (opt-in, no invariant coupling). Surfaced as two Settings-view checkboxes (`renderer/index.html` `#chk-enable-em-score` / `#chk-enable-patient-summary`, mirroring the CDI checkbox markup; wired in `renderer/views/settingsView.js` following the `chkAutoRecord` pattern — save via `ipc.saveSettings`, no coupling). #2/#3 have no toggles (ride with `enableCdi`). No new IPC channel (generic `save-settings`/`get-settings` suffice).

---

## 7. File-by-file change list

**#1 E/M:** `notes-claude/standards/em_mdm_2021.md` (new) · `notes-claude/skills/em-score/{SKILL.md,TESTS.md}` (new) · `src/llm/skill-io/prompts.js` (+builder) · `src/engines/emScore.js` (new, registered).
**#2/#3 CDI:** `notes-claude/skills/cdi-review/SKILL.md` (extend: provider_query + queries[] + query_count; load em_mdm pack; reimbursement guidance — additive, keep MD render).
**#4 Summary:** `notes-claude/skills/patient-summary/{SKILL.md,TESTS.md}` (new) · `src/llm/skill-io/prompts.js` (+builder) · `src/engines/patientSummary.js` (new, registered).
**DB:** `db/migrations/005_add_engine_outputs.sql` (new) · `db/engine_outputs.js` (new).
**Chain/registry:** `src/engines/registry.js` (`[soap,icd,cdi,emScore,patientSummary]`) · `src/pipeline/chain.js` (`runCaseChain`: run em-score + patient-summary sequentially after CDI, before docx; no docx for them).
**Settings/UI:** `config/settings.js` · `renderer/index.html` · `renderer/views/settingsView.js`.
**Docs (same PR):** CLAUDE.md, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

---

## 8. Next step (explicitly deferred — not this batch)

- **Presentation:** move review-output rendering to **JSON → HTML → PDF** (richer cards for CDI/E·M/summary). The new engines emit JSON precisely so this layer can be built fresh from sample JSON (e.g. via Claude Artifacts / the `frontend-design` skill) rather than inheriting legacy CSS. This is the immediate next action rish flagged — *that's* when MD/presentation for the review engines gets reworked.
- **On-demand / manual-tab surface:** invoking these engines outside the pipeline (the `feature/cdi-manual-tab` pattern) — separate, after presentation lands.
- **Clinical Order Generation (`orders` engine):** ON HOLD. Reads the Assessment/Plan, drafts EHR-pasteable orders (labs/imaging/referrals/meds/follow-ups, each with indication + prior-auth hint) and surfaces *implied-but-unwritten* orders. Same engine+JSON+`engine_outputs` pattern when picked up. Deferred this cycle.

---

## 9. Decisions (2026-06-11)

- **Run mode:** toggle ON ⇒ runs in the pipeline on every case; OFF ⇒ skipped. The toggle *is* the gate (like `enableCdi`). (Superseded the earlier on-demand draft.)
- **DB:** generic `engine_outputs` table, no per-`cases` columns; CDI/ICD untouched.
- **MD:** new engines JSON-only; CDI/ICD/SOAP MD+docx unchanged; presentation reworked next step.
- **#3 persistence:** zero DB work — `cdi_flags.reimbursement_impact` already wired end-to-end.
- **#2:** rides with `enableCdi`, no toggle.
- **#5 visit type:** parsed from note, inferred + flagged if absent.
- **em_mdm pack:** authored here, CPT source-checked (connector can't validate CPT), connector-clean.
- **Clinical orders:** on hold (§8).
- **Branch:** `feature/pa-engines-v0.2` off develop, standalone.

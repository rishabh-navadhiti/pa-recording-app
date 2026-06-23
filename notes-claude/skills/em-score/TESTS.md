# `em-score` — Test scenarios

**For the human user to run manually.** The implementing session did NOT execute these via `claude -p`. Treat this as a regression-test specification — re-run after model upgrades, prompt edits, standards-pack changes, or whenever the skill is touched.

Each scenario is a checklist. Tick boxes as you go; flag any that fail.

> Scenarios are grounded in the kinds of office/outpatient notes this app produces (HPI / exam / assessment / plan with a `*_soap_note.md`). To run a scenario, drop the named note into a case folder as `<stem>_soap_note.md` (the skill anchors on a `*_soap_note.md`; transcript optional). Scoring is against `em_mdm_2021.md`.

---

## How to invoke the skill

Invoked via the local `claude` CLI from any directory:

```bash
claude -p "score em. Case: <ABS_CASE_DIR>. Specialty: <name>. Standards: <ABS_STANDARDS_DIR>"
```

Where:
- `<ABS_CASE_DIR>` — absolute path to a folder containing at least a `*_soap_note.md` (transcript optional).
- `<name>` — the doctor's specialty (context only; the 2021 MDM framework is specialty-agnostic). May be empty.
- `<ABS_STANDARDS_DIR>` — absolute path to `<NOTES_DIR>/.claude/standards/` (synced from `notes-claude/standards/` on launch). On a dev machine running source you can point it at `notes-claude/standards/` directly. The skill reads the MDM pack from `<STANDARDS_DIR>/em_mdm_2021.md`.

After a run, **one** file should appear in the case folder:
- `<stem>_em.json` — the single canonical structured output.

There is **no** `_em.md` and **no** `_em.docx` — this engine is **JSON-only by design** (presentation renders from the JSON in a later pipeline step). A run that writes a `.md` is a bug.

The skill's **final assistant text** ends with a single-line JSON manifest (SKILL.md Step 6), `status` ∈ `"ok"`/`"skipped"`/`"failed"`. `parseSkillManifest` reads it; if missing/malformed, the app falls back to reading `<stem>_em.json` from disk.

### Connector dependency

This skill is **connector-free** — it scores CPT / AMA rules and emits **no ICD codes** in the normal path, so it does **not** require the ICD-10 MCP connector. (CPT codes and time thresholds cannot be connector-validated anyway — the connector is ICD-only.) If a run ever emits a Dx code, that code must be connector-validated, but the expected default is that none appear.

---

## Scenario 1 — Moderate established follow-up → 99214 (the classic)

**Setup:** An **established-patient follow-up** note. One chronic illness with a mild exacerbation (e.g. worsening asthma, or HTN now uncontrolled). The provider reviews one prior result and orders one new lab (Category 1 = 2 items → Low data) and **starts or adjusts a prescription** (Risk = Moderate via prescription drug management). No total time documented.

**Expected output (something like):**
- [ ] `visit_type: "established"`, `visit_type_assumed: false` (the note says "follow-up").
- [ ] `mdm_elements.problems_addressed.score: "moderate"` — chronic illness with exacerbation; `drivers` names it.
- [ ] `mdm_elements.data_reviewed.score: "low"` — Category 1 = 2 items (one review + one order); `drivers` lists them.
- [ ] `mdm_elements.risk.score: "moderate"` — **prescription drug management**; `drivers` names the medication started/changed.
- [ ] `predicted_complexity: "moderate"` via 2-of-3 (Problems + Risk at Moderate, Data only Low).
- [ ] `predicted_em_level: "99214"`.
- [ ] `final_level_basis` states Problems + Risk carry it even though Data is only Low. (This mirrors the pack's worked 99214 example.)
- [ ] `time_alternative.documented_minutes: null`, `level_if_time: null` (no total documented → MDM path).
- [ ] `upgrade_path` names what would reach 99215 (a second High element).
- [ ] `headline` states "Predicted 99214" + the key caveat (level rests on the documented prescription).

**Validation:**
- [ ] `_em.json` is valid JSON (`python3 -m json.tool <path>`).
- [ ] No `_em.md` / `_em.docx` produced.
- [ ] Manifest `status: "ok"`, `predicted_em_level: "99214"`, `predicted_complexity: "moderate"`.

---

## Scenario 2 — Straightforward / low established recheck → 99212 / 99213

**Setup:** An **established-patient recheck** with a single minor or one stable, well-controlled chronic problem.
- **2a (straightforward):** single minor problem (e.g. uncomplicated insect bite / stable benign skin lesion), no data ordered or reviewed, reassurance + OTC only, no prescription.
- **2b (low):** one stable chronic illness (well-controlled HTN) reviewed, one prior lab result reviewed (Category 1 = 1 item), continue current meds, no change.

**Expected:**
- [ ] **2a:** Problems SF, Data SF, Risk SF → 3-of-3 SF → `predicted_complexity: "straightforward"`, `predicted_em_level: "99212"`. `downcode_risk: "low"`.
- [ ] **2b:** Problems Low, Data Low, Risk Low → ≥2 at Low → `predicted_complexity: "low"`, `predicted_em_level: "99213"`.
- [ ] In **2b** the skill does **not** inflate to 99214: with no prescription started/changed and no procedure decision, Risk stays **Low** (the pack's "Risk asserted without the management decision" down-code driver). `mdm_elements.risk.documentation_gap` names that a prescription/management decision would raise Risk to Moderate.
- [ ] `visit_type: "established"` in both.
- [ ] Manifest `status: "ok"`; `predicted_em_level` is `99212` (2a) / `99213` (2b).

---

## Scenario 3 — No E/M to score: a procedure op-note → skipped

**Setup:** A note that is a **pure procedure / operative note** — technique, "prepped and draped," the injection/procedure body — with **no separately documented office evaluation** (no HPI/assessment/plan E/M).

**Expected output:**
- [ ] `predicted_em_level: null`, `predicted_complexity: null`, `downcode_risk: null`.
- [ ] A top-level `skipped_reason` ≈ `"note is a procedure op-note, not an office/outpatient E/M encounter"`.
- [ ] Manifest `status: "skipped"`, matching `skipped_reason`, `predicted_em_level: null`.
- [ ] The skill did **not** force an E/M level onto a procedure-only note.
- [ ] `_em.json` is still written (downstream needs a file); no `.md`.

---

## Scenario 4 — Visit type not stated → inferred + assumed flag

**Setup:** A note with clear MDM content but **no explicit "new patient" / "established" / "follow-up" label** (the scribe omitted it). The body reads like a recheck of an ongoing problem.

**Expected:**
- [ ] `visit_type: "established"` (the follow-up-style default), `visit_type_assumed: true`.
- [ ] `headline` **flags the assumption** (e.g. "Visit type not stated — scored as established; confirm new vs. established before billing.").
- [ ] The CPT band reflects the assumed established type (`9921x`, not `9920x`).
- [ ] If instead the note has new-patient cues without the explicit label, `visit_type: "new"`, `visit_type_assumed: true`, and the band is `9920x`.
- [ ] Manifest `status: "ok"`.

---

## Scenario 5 — Time path beats MDM

**Setup:** An established-patient note whose MDM scores **Low** (→ 99213 on MDM) but documents a **total time of 32 minutes** on the date of the encounter (counseling/coordination heavy visit).

**Expected:**
- [ ] `predicted_complexity: "low"` (the MDM result is unchanged — complexity reflects MDM).
- [ ] `time_alternative.documented_minutes: 32`, `level_if_time: "99214"` (32 min falls in the established 30–39 band).
- [ ] `predicted_em_level: "99214"` — the **higher** of MDM (99213) and time (99214).
- [ ] `final_level_basis` states the **time path** won and names the documented total.
- [ ] Manifest `status: "ok"`, `predicted_em_level: "99214"`.
- [ ] Contrast: if the same note documented time as a bare "spent time with patient" with **no total minutes**, `documented_minutes: null`, `level_if_time: null`, and the level falls back to the MDM 99213.

---

## Scenario 6 — High-complexity new patient → 99205

**Setup:** A **new-patient** note with an acute illness posing a threat to bodily function (e.g. suspected acute limb ischemia): independent interpretation of an outside imaging study **and** discussion with a specialist (Category 2 + Category 3 → two categories → High data), and a decision for emergency surgery / hospitalization (Risk High).

**Expected:**
- [ ] `visit_type: "new"`, `visit_type_assumed: false`.
- [ ] Problems High, Data High, Risk High → 3-of-3 High → `predicted_complexity: "high"`, `predicted_em_level: "99205"`.
- [ ] `mdm_elements.data_reviewed.drivers` distinguishes the **independent interpretation** (Category 2) from the **external discussion** (Category 3) — two categories, not double-counted Category 1 review items.
- [ ] `upgrade_path` notes there is no higher office E/M level (prolonged-services add-ons are out of scope), since 99205 is the top of the new-patient band.
- [ ] Manifest `status: "ok"`, `predicted_em_level: "99205"`, `predicted_complexity: "high"`.

---

## Scenario 7 — Down-code risk: a thinly-supported 99214

**Setup:** A note that **claims** a moderate visit but where the moderate driver is asserted as prose without the substantiating decision — e.g. "high-risk patient, will manage medications" but no specific medication started/changed/continued-with-rationale, and Problems/Data both only Low.

**Expected:**
- [ ] The skill scores Risk on the **decision documented**, not the prose: if no prescription/procedure/admission decision is actually documented, Risk is **Low**, so `predicted_complexity` falls to **Low** (→ 99213), NOT 99214.
- [ ] If the skill does read a borderline prescription-management signal and lands at 99214, `downcode_risk: "high"` and `mdm_elements.risk.documentation_gap` names exactly what to document (the medication + rationale) to defend the level.
- [ ] `upgrade_path` / `documentation_gap` strings are **specific** ("document the medication started and the management rationale"), not "improve documentation."
- [ ] Never emits `99201` or `99211`.

---

## Scenario 8 — Edge cases

### 8a — Missing note file
**Setup:** Case folder exists, no `*_soap_note.md` (and no other `.md` clinical note).
**Expected:**
- [ ] Manifest `status: "failed"`, `error` containing `note_not_found`.
- [ ] A stub `_em.json` is still written (downstream needs a file).

### 8b — Standards pack missing
**Setup:** Point `Standards:` at a path with no `em_mdm_2021.md`.
**Expected:**
- [ ] Manifest `status: "failed"`, `error` containing `em_mdm_2021.md standards pack not found`.

### 8c — Missing transcript, note present
**Expected:**
- [ ] `WARN: transcript not found...` printed; the level is scored on the note alone.
- [ ] Manifest `status` `"ok"` (or `"skipped"` if the note is not an office E/M).

### 8d — Non-office E/M family (inpatient / ED / observation)
**Setup:** A note clearly framed as an inpatient, ED, or observation encounter (different 2021/2023 MDM tables apply).
**Expected:**
- [ ] `predicted_em_level: null`; manifest `status: "skipped"`, `skipped_reason` naming that the note is not an office/outpatient E/M (99202–99215) encounter.
- [ ] The skill does **not** force an office code onto a non-office encounter.

---

## Scenario 9 — JSON validation (independent)

**Pick any successful run. Verify:**
```bash
python3 -m json.tool <case>_em.json > /dev/null && echo OK || echo FAIL
```
- [ ] Output is `OK`.

**Schema spot-check:**
- [ ] `meta` has `case_dir`, `patient`, `doctor`, `date_of_service`, `specialty`, `generated_at`, `standards_version`.
- [ ] Top-level has `visit_type` ∈ `new`/`established`, `visit_type_assumed` (bool), `predicted_em_level`, `predicted_complexity`, `downcode_risk`, `mdm_elements`, `final_level_basis`, `upgrade_path`, `time_alternative`, `headline`.
- [ ] `predicted_complexity` ∈ `straightforward`/`low`/`moderate`/`high` (or `null` on skip), and is the **2-of-3** result of the three `mdm_elements.*.score` values.
- [ ] `predicted_em_level` ∈ {99202, 99203, 99204, 99205, 99212, 99213, 99214, 99215} (or `null` on skip), with the band matching `visit_type`, and is the **higher** of the MDM-mapped code and `time_alternative.level_if_time`.
- [ ] **No `99201` and no `99211` anywhere.**
- [ ] Each `mdm_elements.*` has `score`, `drivers` (array), `documentation_gap` (string or `null`).
- [ ] `time_alternative.level_if_time` is `null` whenever `documented_minutes` is `null`.
- [ ] No ICD-10 code appears anywhere (connector-free engine). If one does, it must be connector-billable.

---

## Scenario 10 — JSON-only discipline (no MD / no docx)

**Pick any successful run. Verify:**
- [ ] Exactly one new artifact in the case folder: `<stem>_em.json`.
- [ ] **No** `<stem>_em.md` and **no** `<stem>_em.docx` — this engine renders nothing (unlike `cdi-costigan` / `cdi-review`, which keep their MD + docx).
- [ ] The skill's final assistant text ends with the single-line manifest and **no prose after it**.

---

## Regression checklist — after any change to the skill or the pack

When `SKILL.md` or `standards/em_mdm_2021.md` changes:
- [ ] Re-run Scenario 1 (Moderate 99214) — the classic Problems+Risk-carry-it 2-of-3 must still land 99214.
- [ ] Re-run Scenario 2b (stable chronic) — must NOT inflate to 99214 without a documented Risk driver.
- [ ] Re-run Scenario 3 (procedure op-note) — must `skip` with `predicted_em_level: null` (no forced E/M).
- [ ] Re-run Scenario 4 (visit type absent) — must infer + set `visit_type_assumed: true` and flag it in the headline.
- [ ] Re-run Scenario 5 (time path) — the higher-of-MDM-or-time selection must still fire when a total is documented.
- [ ] Re-run Scenario 9 — JSON still validates; never emits 99201/99211.
- [ ] Re-run Scenario 10 — still JSON-only; no `.md`/`.docx`.

If any regress: revert, investigate. Don't ship a change that breaks the no-E/M skip, the 2-of-3 leveling, the visit-type inference, the JSON-only discipline, or the JSON schema.

---

## What to eyeball for "demo-ready" quality

Beyond pass/fail, the output should *read* like something a coding auditor would hand a physician:
- [ ] The `headline` states the predicted level + the single most important caveat/action in one plain sentence.
- [ ] Each `documentation_gap` and the `upgrade_path` are **specific, actionable** ("document the medication started + rationale"), not "improve documentation."
- [ ] `final_level_basis` names which two elements carried the level (or that time won) — defensible against the pack.
- [ ] `downcode_risk` maps to audit reality: `high` when the level leans on one thinly-documented element; `low` when 2+ elements are solidly documented.
- [ ] The new-vs-established choice is correct (or, when assumed, loudly flagged) — it shifts the whole CPT band.

# `cdi-costigan` — Test scenarios

**For the human user to run manually.** The implementing session did NOT execute these via `claude -p`. Treat this as a regression-test specification — re-run after model upgrades, prompt edits, rubric-pack changes, or whenever the skill is touched.

Each scenario is a checklist. Tick boxes as you go; flag any that fail.

> Scenarios are grounded in the real Dr. Costigan sample notes (the 89 notes in `Samples July 29/31, 2025.docx`). To run a scenario, drop the named note into a case folder as `<stem>_soap_note.md` (the skill anchors on a `*_soap_note.md`; transcript optional).

---

## How to invoke the skill

Invoked via the local `claude` CLI from any directory:

```bash
claude -p "check costigan procedures. Case: <ABS_CASE_DIR>. Standards: <ABS_STANDARDS_DIR>"
```

Where:
- `<ABS_CASE_DIR>` — absolute path to a folder containing at least a `*_soap_note.md` (transcript optional).
- `<ABS_STANDARDS_DIR>` — absolute path to `<NOTES_DIR>/.claude/standards/` (synced from `notes-claude/standards/` on launch). On a dev machine running source you can point it at `notes-claude/standards/` directly. The skill reads the procedure packs from `<STANDARDS_DIR>/procedures/`.

After a run, two files should appear in the case folder:
- `<stem>_costigan.json` — canonical structured output
- `<stem>_costigan.md`   — human-readable rendering
  (`<stem>_costigan.docx` would be produced later by the app's md→docx step; not this skill's job.)

The skill's **final assistant text** ends with a single-line JSON manifest (SKILL.md Step 8), `status` ∈ `"ok"`/`"skipped"`/`"failed"`. `parseSkillManifest` reads it; if missing/malformed, the app falls back to reading `<stem>_costigan.json` from disk.

### Connector dependency

This skill **requires the ICD-10 MCP connector** (it validates every code). Run it with cwd at `<NOTES_DIR>` so `.mcp.json` is loaded (the app does this automatically). When testing on source, ensure the connector is registered in your session. If the connector is unreachable, code validation can't happen — the skill should still produce the medical-necessity checklist, but `icd_validated` behavior and the `code_validation` block depend on connector access.

---

## Scenario 1 — Repeat ESI with the signature relief-% gap (Tenorio, Miguel · 7/29/2025)

**Setup:** The real Tenorio note — a lumbar follow-up listing **8 prior LESIs with exact dates** (10/2/2019 … 10/24/2024) in HPI prose *and* a Past Surgical History table, but **no relief % for any of them**. The visit recommends PT (no new injection ordered this visit), but the prior ESI history is the longitudinal payload. *(If you want ESI to be "in play" as a request, use a Tenorio-like note where a repeat ESI is actually recommended/requested.)*

**Expected output (something like):**
- [ ] If a repeat ESI is requested: one `ESI` procedure, `rung: "repeat"`, `verdict: "needs_edits"`.
- [ ] **`ESI-R1` → `not_met`** — prior ESI dates documented but no relief %; `fix` says to document the % relief + duration of the most recent (10/24/2024) ESI on the same scale used at baseline. **This is the single most important catch** — it's exactly what fails the repeat-ESI necessity test.
- [ ] **`ESI-2` → `unclear` or `not_met`** — a baseline VAS (5/10) is present but the same-scale follow-up is absent.
- [ ] `frequency.prior_dates` lists the prior lumbar ESI date(s) within the trailing 12 months from 7/29/2025; `within_cap: true` (≤ 4/region/12mo).
- [ ] `summary.headline` names the missing relief % as the key action.
- [ ] **If NO new injection is requested this visit** (pure PT-recommendation follow-up): the correct behavior is `status: "skipped"`, `overall_status: "no_procedure"` — the prior ESIs are history, not a procedure-in-play. Both readings are defensible depending on the note; the skill should not invent a request that isn't there.

**Validation:**
- [ ] `_costigan.json` is valid JSON (`python3 -m json.tool <path>`).
- [ ] Every code in `icd_suggested` / `icd_observed` is connector-valid and billable (no header-only codes).
- [ ] `_costigan.md` renders the checklist with ✅/⚠️/❌ and `→ fix` lines.
- [ ] Manifest `status` is `"ok"` (procedure in play) or `"skipped"` (no procedure) — matching the note.

---

## Scenario 2 — Facet block requested without prior diagnostic blocks (Cedillos, Pamela · 7/29/2025)

**Setup:** The real Cedillos note — recommends *"a lumbar facet block from L4 to S1"* and formally requests authorization for it. She has prior LESIs + SI fusions, FABER/Fortin's/Gaenslen's positive on exam, VAS 8/10. **No prior diagnostic MBB with ≥80% relief is documented.**

**Expected output:**
- [ ] One `Facet` procedure, `intent: "requested"`, `site` ≈ "lumbar L4-S1".
- [ ] The skill must decide the **rung**: a first facet block on a patient with no prior facet diagnostics is a **diagnostic** procedure → evaluate against `FACET-D1` (meets indications) not the therapeutic criteria.
- [ ] **`FACET-1` (axial pain + scale)** — check whether the pain is documented as *axial* vs *radicular*. Cedillos has radicular features (left LE radiculopathy) — this should surface a **`FACET-3`** consideration (untreated radiculopathy argues against facet coverage) as `unclear`/`not_met` with a note about the conflict.
- [ ] **Coding issue** — a diagnostic facet line should carry the **KX modifier**; if there's no indication KX applies, `coding.coding_issues` notes that its omission would erode the therapeutic cap.
- [ ] `icd_suggested` maps to a **spondylosis** code (M47.81x / M47.89x for the documented lumbar level) — **not** a radiculopathy code (facet coverage requires spondylosis, not M54.1x). Connector-validate the suggested code.
- [ ] `verdict` is `needs_edits` or `likely_denied` depending on how load-bearing the radiculopathy conflict is.

**Validation:**
- [ ] `_costigan.json` valid; suggested facet ICD is a billable region-specific spondylosis code (not the header `M47.81`/`M47.89`).
- [ ] Manifest `status` `"ok"`.

---

## Scenario 3 — No procedure in play (Balian, Antoinette · 7/29/2025)

**Setup:** The real Balian note — a **surgical pre-operative** visit (ELIF/PSF/laminectomy at L4-L5 scheduled). Mentions a single old LESI (06/07/2023) in history, but **no interventional injection is performed or requested this visit.**

**Expected output:**
- [ ] `procedures_detected: []`, `summary.overall_status: "no_procedure"`.
- [ ] `_costigan.md` says no interventional procedure was performed or requested.
- [ ] Manifest `status: "skipped"`, `skipped_reason` ≈ "no interventional procedure performed or requested in this note", `procedures_in_play: 0`.
- [ ] The skill did **not** invent an ESI/facet check off the historical LESI mention or the "facet arthropathy" diagnosis. (Detection discipline: history ≠ in-play; a bare diagnosis ≠ a procedure.)

---

## Scenario 4 — SI joint injection and the 3-provocative-test rule

**Setup:** A note requesting a **sacroiliac joint injection** with SI-region pain below L5. Vary the exam:
- **4a:** exam documents **≥ 3** of the named six (FABER, Gaenslen, Thigh Thrust/Posterior Shear, SI Compression, SI Distraction, Yeoman) positive.
- **4b:** exam documents only **2** of the six positive (plus Fortin's, which is *not* one of the six).

**Expected:**
- [ ] **4a:** `SI-5` → `met`, evidence lists the ≥3 positive named tests.
- [ ] **4b:** `SI-5` → `not_met`, `fix` states ≥3 of the six named provocative maneuvers are required and Fortin's doesn't count toward the three; `verdict` reflects the load-bearing failure (`likely_denied` if SI-5 is the gating gap).
- [ ] If no fluoroscopy is documented and the patient has no contrast contraindication: the skill flags the image-guidance requirement, OR recognizes the **20552 + M79.18** no-imaging path if that's what's coded — and validates M79.18 (billable) while noting it's only correct for the no-imaging path (mismatch if paired with 27096).
- [ ] If **SI RFA / 64625** is requested: `verdict: "likely_denied"`, denial reason = SI denervation is non-covered.

---

## Scenario 5 — Likely-denied coverage mismatch (TPI for low back pain)

**Setup:** A note requesting a **trigger point injection** documented for **low back pain** (CPT 20552, ICD e.g. M54.5), with no documented trigger points / taut band.

**Expected:**
- [ ] One `TPI` procedure, `verdict: "likely_denied"`.
- [ ] `denial_reason` names that low back pain is **not** a covered TPI indication (covered = tension headache G44.2xx + myalgia M79.1x only) and/or no documented trigger points.
- [ ] **`TPI-2` → `not_met`** (no documented trigger-point findings).
- [ ] `coding.coding_issues` notes M54.5 is not in the covered TPI ICD list.
- [ ] `code_validation.flagged` includes M54.5 with issue "exists/billable but NOT a covered diagnosis for TPI" — the subtle, high-value distinction between *invalid code* and *valid-but-not-covered-for-this-procedure*.
- [ ] If the note documents TPI **"under fluoroscopy"**: also flagged — image guidance makes a TPI non-covered (opposite of ESI/facet/SI).

---

## Scenario 6 — PVA / VCF inclusion-vs-exclusion (one-time procedure)

**Setup:** A note for **kyphoplasty** of a vertebral compression fracture. Vary acuity + symptomatic criteria:
- **6a (qualifying):** acute (< 6 wk) osteoporotic VCF at L1, MRI marrow edema, NRS 8/10, osteoporosis referral documented; coded M80.08XA.
- **6b (non-qualifying):** chronic/old fracture, no marrow edema imaging, pain not clearly attributable to the target fracture.

**Expected:**
- [ ] **6a:** `verdict: "audit_ready"`; `PVA-1`/`PVA-2`/`PVA-3` all `met`; no absolute exclusion; M80.08XA connector-valid with **XA** (initial-encounter) acuity matching the acute fracture.
- [ ] **6b:** `verdict: "likely_denied"`; denial reason = exclusion `PVA-X1` (pain not from the VCF) and/or no acuity imaging; the skill does **not** look for repeat-relief thresholds or session caps (PVA is one-time).
- [ ] If a **Group 2 (malignant)** fracture: the skill checks the **two-code rule** (a CXX.XX neoplasm code **plus** M84.58XA/XS) and flags if only one is present.

---

## Scenario 7 — Connector validation guard (the De Quervain discipline)

**Setup:** Use any procedure note that already contains ICD codes in a table (production notes often do, appended by `add-icd-codes`). Include one **header-only** code (e.g. `M51.36` lumbar DDD, or a bare `M47.81`) and one already-correct billable code (e.g. `M47.816` lumbar spondylosis).

**Expected:**
- [ ] The skill calls the connector and recognizes `M51.36` / `M47.81` as **non-billable headers** — it does **not** emit them as suggestions; `code_validation.flagged` notes the header-only status with the billable child as the fix.
- [ ] For the already-correct `M47.816`: the skill does **NOT** raise a spurious specificity flag — it confirms via `search_codes` that `.816` is the billable lumbar member and leaves it alone. (This is the De Quervain guard: never flag "needs more specificity" on a code that is already the complete billable code for the documented axis.)
- [ ] `icd_validated: true` in the manifest (codes were present and validated).
- [ ] No emitted code anywhere in the JSON fails a connector existence check.

---

## Scenario 8 — Edge cases

### 8a — Missing note file
**Setup:** Case folder exists, no `*_soap_note.md` (and no other `.md` clinical note).
**Expected:**
- [ ] Manifest `status: "failed"`, `error` containing `note_not_found`.
- [ ] A stub `_costigan.json` is still written (downstream needs a file).

### 8b — Procedures standards dir missing
**Setup:** Point `Standards:` at a path with no `procedures/` subdir.
**Expected:**
- [ ] Manifest `status: "failed"`, `error` containing `procedures standards dir not found`.

### 8c — Missing transcript, note present
**Expected:**
- [ ] `WARN: transcript not found...` printed; the checklist is produced on the note alone.
- [ ] Manifest `status` `"ok"` (or `"skipped"` if no procedure in play).

### 8d — Multiple procedures in one note
**Setup:** A note that both performs an ESI and requests a facet block (some Costigan notes discuss several).
**Expected:**
- [ ] `procedures_detected` has **two** entries, each with its own checklist + verdict.
- [ ] `summary.overall_status` is the **worst** of the two verdicts.
- [ ] One entry per distinct procedure — the same injection mentioned in HPI and Plan is **not** double-counted.

---

## Scenario 9 — JSON validation (independent)

**Pick any successful run. Verify:**
```bash
python3 -m json.tool <case>_costigan.json > /dev/null && echo OK || echo FAIL
```
- [ ] Output is `OK`.

**Schema spot-check:**
- [ ] `meta` has `case_dir`, `patient`, `doctor`, `date_of_service`, `generated_at`, `standards_versions`.
- [ ] `summary` has `procedures_in_play`, `overall_status`, the three `*_count` fields, `headline`.
- [ ] `overall_status` ∈ `audit_ready`/`needs_edits`/`likely_denied`/`no_procedure`, and equals the **worst** verdict in `procedures_detected` (or `no_procedure` if empty).
- [ ] Every `procedures_detected[]` entry has `id`, `procedure`, `intent`, `verdict`, `checklist`, `coding`, `frequency`.
- [ ] Every `checklist[]` item has `id`, `criterion`, `status` ∈ `met`/`not_met`/`unclear`, and a `fix` string when `status` is `not_met`/`unclear` (null when `met`).
- [ ] `code_validation` is present **only** when the note had ICD codes; omitted otherwise.
- [ ] Every emitted code is connector-billable; no header-only codes appear as suggestions.

---

## Scenario 10 — Markdown rendering

**Pick any successful run. Visual inspection of `_costigan.md`:**
- [ ] Title `# Procedure Checklist — <Patient Name>`.
- [ ] Overall verdict heading uses the right emoji: 🟢 audit-ready, 🟡 needs edits, 🔴 likely denied, ⚪ no procedure.
- [ ] `headline` rendered in bold under the overall heading.
- [ ] Each procedure block: verdict emoji + procedure title; intent/stage/site line; a 🔴 denial-risk callout when likely-denied.
- [ ] Checklist items render with ✅/❌/⚠️, indented `*evidence:*` lines, and `**→ fix:**` lines.
- [ ] Coding section shows CPT / ICD in `` `backticks` `` and coding issues.
- [ ] Frequency section shows cap, prior dates, within-cap.
- [ ] Code-validation summary appears only when codes were in the note.
- [ ] Footer line includes the rubric versions.

---

## Regression checklist — after any change to the skill or packs

When `SKILL.md` or any `standards/procedures/*.md` changes:
- [ ] Re-run Scenario 1 (Tenorio repeat-ESI) — the missing-relief-% `ESI-R1` catch must still fire when an ESI is in play.
- [ ] Re-run Scenario 3 (Balian) — a pure surgical/PT follow-up must still `skip` with `no_procedure` (no false-positive procedure detection).
- [ ] Re-run Scenario 5 (TPI low-back) — the coverage-mismatch `likely_denied` must still fire.
- [ ] Re-run Scenario 7 (connector guard) — header-only codes still rejected; already-correct codes not spuriously flagged.
- [ ] Re-run Scenario 9 — JSON still validates and no header-only code is emitted.

If any regress: revert, investigate. Don't ship a change that breaks the no-procedure skip, the connector guard, or the JSON schema.

---

## What to eyeball for "demo-ready" quality

Beyond pass/fail, the report should *read* like something a compliance analyst would hand a physician:
- [ ] The `headline` states the bottom line + the single most important action in one plain sentence.
- [ ] Every `not_met` has a **specific, actionable** fix (a concrete "document X" — not "improve documentation").
- [ ] Evidence quotes are **verbatim** fragments, so the physician can see exactly what the note does/doesn't say.
- [ ] The verdict maps cleanly to audit reality: `audit_ready` = would survive a Noridian TPE review; `likely_denied` names the denial reason the way the MAC would.

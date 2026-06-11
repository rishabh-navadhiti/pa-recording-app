# `patient-summary` — Test scenarios

**For the human user to run manually.** The implementing session did NOT execute these via `claude -p`. Treat this as a regression-test specification — re-run after model upgrades, prompt edits, or whenever the skill is touched.

Each scenario is a checklist. Tick boxes as you go; flag any that fail.

> Scenarios are grounded in real sample notes. To run a scenario, drop the named note into a case folder as `<stem>_soap_note.md` (the skill anchors on a `*_soap_note.md`). No transcript, standards pack, or connector is needed — this skill is connector-free and reads the note alone.

---

## How to invoke the skill

Invoked via the local `claude` CLI from any directory:

```bash
claude -p "summarize for patient. Case: <ABS_CASE_DIR>"
```

Where:
- `<ABS_CASE_DIR>` — absolute path to a folder containing a `*_soap_note.md`.

After a run, one file should appear in the case folder:
- `<stem>_patient_summary.json` — canonical structured output (JSON only; no markdown, no docx — presentation is rendered from the JSON in a later app step).

The skill's **final assistant text** ends with a single-line JSON manifest (SKILL.md Step 5), `status` ∈ `"ok"`/`"failed"`. `parseSkillManifest` reads it; if missing/malformed, the app falls back to reading `<stem>_patient_summary.json` from disk.

### No connector dependency

Unlike `cdi-review` / `cdi-costigan` / `add-icd-codes`, this skill **does not use the ICD-10 MCP connector** and emits **no codes at all**. It can be run with or without the connector registered; the connector must never be touched. If you see any ICD-10 / CPT code in the output, that is a failure (see Scenario 2).

---

## Scenario 1 — Normal visit, all five sections in plain language

**Setup:** Any complete, ordinary SOAP note — a chief complaint, an assessment, a plan, and at least one medication mentioned (started, changed, or continued). E.g. a follow-up for knee osteoarthritis with an NSAID continued, PT referral, and a 6-week recheck.

**Expected output:**
- [ ] Manifest `status: "ok"`, `json_path` points at `<stem>_patient_summary.json`, `reading_level: "grade 6"`.
- [ ] `sections` has **all five** keys present and non-empty: `whats_going_on`, `your_plan`, `medications`, `follow_up`, `when_to_seek_help`.
- [ ] `headline` is one plain sentence stating the bottom line of the visit in patient language.
- [ ] Every section is written in the **second person** ("you" / "your"), not "the patient."
- [ ] Reading level is ~grade 6: short sentences, common words, no abbreviations (`f/u`, `r/o`, `WNL`, `prn`, lab shorthand all absent).
- [ ] `whats_going_on` names the condition in everyday words (e.g. "wear-and-tear arthritis"), not the clinical term alone or a code.
- [ ] `your_plan` states what *you* need to do (tests, referrals, therapy) as documented.
- [ ] `medications` names the medication(s) **that are in the note**, in plain terms with a plain-language reason.
- [ ] `follow_up` states when to come back / with whom, as documented.
- [ ] `when_to_seek_help` lists the warning signs the note documents.

**Validation:**
- [ ] `_patient_summary.json` is valid JSON (`python3 -m json.tool <path>`).
- [ ] Top-level keys are exactly `meta`, `reading_level`, `headline`, `sections` (plus `parse_error`/`raw_output_path` only on the stub path).
- [ ] `meta` has `case_dir`, `patient`, `doctor`, `generated_at`.

---

## Scenario 2 — No codes or jargon leak (the core discipline)

**Setup:** Use a note that is **code-heavy and jargon-heavy** — e.g. a production note that already has an `## ICD-10-CM Codes` table appended by `add-icd-codes`, plus clinical shorthand in the HPI/Plan (MDM, r/o, f/u, WNL, abbreviated drug names, ICD/CPT references).

**Expected:**
- [ ] **No ICD-10 code** (e.g. `M17.11`, `E11.9`) appears anywhere in the JSON.
- [ ] **No CPT code** (e.g. `99213`, `20610`) appears anywhere in the JSON.
- [ ] No billing/coding language ("E/M level," "MDM," "medical necessity").
- [ ] No provider-facing shorthand: `f/u`, `r/o`, `WNL`, `prn`, `bid`/`tid`, `pt.`/"the patient."
- [ ] Any medical term that must appear is translated to plain words (the clinical term may appear once in parentheses for recognition, e.g. "high blood pressure (hypertension)" — but never a code).
- [ ] Manifest `status: "ok"`.

**Grep check (any hit on the code patterns is a fail):**
```bash
# ICD-10-CM pattern (letter + 2 digits + optional .x) and common CPT (5 digits)
grep -E '\b[A-TV-Z][0-9][0-9AB](\.[0-9A-Z]{1,4})?\b|\b9[0-9]{4}\b' <stem>_patient_summary.json && echo "FAIL: code-like token present" || echo "OK: no codes"
```
- [ ] Output is `OK: no codes`. (Eyeball any hit — a year like `2026` or a date is fine; an ICD/CPT code is not.)

---

## Scenario 3 — Does not invent medications or instructions

**Setup:** A note where **no medication is prescribed or changed** this visit (e.g. a visit that recommends only PT and a recheck, or a purely diagnostic/imaging-ordering visit), and where the Plan documents **no specific return-precautions / warning signs**.

**Expected:**
- [ ] `medications` does **not** name any drug, dose, or regimen. It states plainly that no new medicines were prescribed (e.g. "No new medicines were prescribed today. Keep taking any medicines you already take, the same way as before.").
- [ ] The skill did **not** fabricate a dose, frequency, or a medication that isn't in the note.
- [ ] `when_to_seek_help` does **not** invent generic ER red-flags. It states plainly that the note didn't list specific warning signs and to call the clinic if you feel worse.
- [ ] `your_plan` reflects only what the note documents (PT / imaging / recheck) — no invented referrals or tests.
- [ ] Every sentence in every section is traceable to content in the note.
- [ ] Manifest `status: "ok"`.

---

## Scenario 4 — Empty sections stated plainly, not padded

**Setup:** A thin but valid note — e.g. a quick acute visit with an assessment and a one-line plan, but no medications, no scheduled follow-up, and no warning signs.

**Expected:**
- [ ] All five `sections` keys are present and are **non-empty strings** (never `null`, never `""`).
- [ ] The sections with no source content carry the plain "no content" sentence (e.g. no new medicines; no follow-up scheduled; call the clinic if you feel worse) rather than fabricated content.
- [ ] `whats_going_on` and `your_plan` still reflect the note's actual content.
- [ ] Manifest `status: "ok"`.

---

## Scenario 5 — Edge cases

### 5a — Missing note file
**Setup:** Case folder exists, no `*_soap_note.md` (and no other `.md` clinical note).
**Expected:**
- [ ] Manifest `status: "failed"`, `error` containing `note_not_found`, `json_path: null`.
- [ ] A stub `_patient_summary.json` is still written (downstream needs a file), with `parse_error`/the failure shape so the renderer can show "summary unavailable."

### 5b — Empty / unparseable note
**Setup:** A `*_soap_note.md` that is empty or has no readable clinical content.
**Expected:**
- [ ] Manifest `status: "failed"`, `error` describing the empty/unparseable note.
- [ ] No invented summary — the skill does not hallucinate a visit.

### 5c — No doctor line in the note
**Setup:** A valid note with no `**Doctor:**` line / provider attestation.
**Expected:**
- [ ] `meta.doctor` is an empty string (not invented).
- [ ] The summary is still produced normally; manifest `status: "ok"`.

---

## Scenario 6 — JSON validation (independent)

**Pick any successful run. Verify:**
```bash
python3 -m json.tool <stem>_patient_summary.json > /dev/null && echo OK || echo FAIL
```
- [ ] Output is `OK`.

**Schema spot-check:**
- [ ] Top-level keys are exactly `meta`, `reading_level`, `headline`, `sections`.
- [ ] `meta` has `case_dir`, `patient`, `doctor`, `generated_at`.
- [ ] `reading_level` is the string `"grade 6"`.
- [ ] `headline` is a non-empty string.
- [ ] `sections` has all five keys (`whats_going_on`, `your_plan`, `medications`, `follow_up`, `when_to_seek_help`), each a non-empty string.

---

## Regression checklist — after any change to the skill

When `SKILL.md` changes:
- [ ] Re-run Scenario 1 (normal visit) — all five sections present, plain second-person language.
- [ ] Re-run Scenario 2 (no codes/jargon) — the grep check still returns `OK: no codes`.
- [ ] Re-run Scenario 3 (no invented meds) — a no-med visit must not name any drug.
- [ ] Re-run Scenario 5a (missing note) — must `fail` with `note_not_found` and still write a stub.
- [ ] Re-run Scenario 6 — JSON still validates against the schema.

If any regress: revert, investigate. Don't ship a change that lets codes/jargon leak, invents medications, or breaks the JSON schema.

---

## What to eyeball for "demo-ready" quality

Beyond pass/fail, the summary should *read* like something you'd actually hand a patient:
- [ ] The `headline` states the bottom line of the visit in one warm, plain sentence.
- [ ] A non-medical reader (a family member) could read every section and understand it without looking anything up.
- [ ] Nothing in the summary is something the doctor didn't say — no new advice, no invented meds, no invented warning signs.
- [ ] The tone is reassuring and direct, written *to* the patient ("you"), not *about* them.

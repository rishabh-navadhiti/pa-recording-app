# `cdi-review` — Test scenarios

**For the human user to run manually after this plan ships.** The implementing session did NOT execute these. Treat this as a regression-test specification — re-run after model upgrades, prompt edits, standards-pack changes, or whenever the skill is touched.

Each scenario is a checklist. Tick boxes as you go; flag any that fail in a follow-up issue.

---

## How to invoke the skill

The skill is invoked via the local `claude` CLI from any directory:

```bash
claude -p "review cdi. Case: <ABS_CASE_DIR>. Specialty: orthopedics. Mode: balanced. Doctor: <DOCTOR_NAME>. Standards: <ABS_STANDARDS_DIR>"
```

Where:
- `<ABS_CASE_DIR>` is an absolute path to a folder under `<NOTES_DIR>/Cases/` containing at least a `*_soap_note.md` (transcript optional).
- `<ABS_STANDARDS_DIR>` is the absolute path to `<NOTES_DIR>/.claude/standards/` (synced from `notes-claude/standards/` on app launch). On a dev machine running source, you can also point this at `notes-claude/standards/` directly.

After the run, three files should appear in the case folder:
- `<stem>_cdi.json` — canonical structured output
- `<stem>_cdi.md`   — human-readable rendering
- `<stem>_cdi.docx` — produced later by the existing `python/md_to_docx.py`; not part of this skill's responsibility

The terminal output's **last line** should match one of:
- `CDI_OK: <path> · <N> flags · quality <X>/100`
- `CDI_SKIPPED: unsupported specialty '<name>'`
- `CDI_FAIL: <reason>`

---

## Scenario 1 — Spencer post-op note (Cecil Daniels 3/11/2026)

**Setup:** A real Spencer post-op SOAP note. Spencer's dictation style is short and often omits the primary diagnosis and laterality on post-op follow-ups. Expected pattern: critical primary-Dx flag + multiple warnings.

**Required case folder contents:**
- [ ] `Cecil Daniels_soap_note.md` — a Spencer post-op short-form follow-up note for Cecil Daniels with carpal tunnel + elbow incisions, no explicit primary Dx, no laterality, no enumerated conservative therapy.
- [ ] `transcript.md` — optional but preferred; the original dictation.

**Invocation:**
```bash
claude -p "review cdi. Case: <NOTES_DIR>/Cases/Cecil Daniels_2026-03-11. Specialty: orthopedics. Mode: balanced. Doctor: Spencer. Standards: <NOTES_DIR>/.claude/standards"
```

**Expected output (the engine should produce something like):**
- [ ] ~6 flags total (balanced mode cap)
- [ ] **`critical` — Primary diagnosis missing** (post-op follow-up doesn't state procedure or original Dx)
- [ ] **`warning` — Laterality not specified** (elbow + wrist findings without right / left)
- [ ] **`warning` — 7th character missing** on the post-op aftercare or injury code
- [ ] **`warning` — Medical necessity narrative absent**
- [ ] **`suggestion` — Implied order not explicit** (e.g., "consider hand therapy")
- [ ] **`suggestion` — Patient education not documented**

**Validation:**
- [ ] `_cdi.json` is valid JSON (run `python3 -m json.tool <path>`)
- [ ] `summary.claim_defense_readiness` is `needs_edits` or `hold_for_review`
- [ ] `summary.clinician_approval_required` is `true` (critical flag fires)
- [ ] `summary.medical_necessity_status` is `weak` or `missing`
- [ ] `_cdi.md` renders cleanly with severity emoji, headings, code blocks for ICD codes
- [ ] Last terminal line starts with `CDI_OK:`

---

## Scenario 2 — Sabbag follow-up note (James Marx EMG case)

**Setup:** A real Sabbag follow-up note where the EMG names 3 conditions but Assessment lists only 1, PMH / PSH fields blank, surgical recommendation present but no enumerated conservative therapy.

**Required case folder contents:**
- [ ] `James Marx_soap_note.md` — Sabbag note with EMG documenting 3 conditions (e.g., carpal tunnel, cubital tunnel, cervical radiculopathy) but Assessment listing only carpal tunnel; surgery recommended; PMH / PSH blank.
- [ ] `transcript.md` — preferred; the original dictation including the EMG interpretation.

**Invocation:**
```bash
claude -p "review cdi. Case: <NOTES_DIR>/Cases/James Marx_2025-03-13. Specialty: orthopedics. Mode: balanced. Doctor: Sabbag. Standards: <NOTES_DIR>/.claude/standards"
```

**Expected output:**
- [ ] ~5–6 flags total
- [ ] **`critical` — Coexisting diagnoses not coded** (EMG documents 3 conditions, Assessment lists 1 — auto-critical, condition #1 + #6 of the hold-trigger table)
- [ ] **`warning` — Blank PMH / PSH affecting HCC capture and surgical clearance**
- [ ] **`warning` — Failed conservative therapy not enumerated** before surgical recommendation (auto-critical condition #7 — may rise to critical)
- [ ] **`suggestion` — High MDM but time not documented** (E/M billing optimization)
- [ ] `flags[].category` includes at least one `Completeness` and one `Linkage` (or `Audit-defense`)

**Validation:**
- [ ] `_cdi.json` is valid JSON
- [ ] `summary.clinician_approval_required` is `true`
- [ ] `summary.claim_defense_readiness` is `hold_for_review`
- [ ] Evidence in the critical flag mentions the EMG findings verbatim (or near-verbatim)
- [ ] Last terminal line starts with `CDI_OK:`

---

## Scenario 3 — Mode comparison on same input

**Setup:** Re-run Scenario 1 and Scenario 2 three times each, varying only `Mode:`. The case folder doesn't change between runs (CDI output overwrites in place).

**Tip:** before each run, move or rename the prior `_cdi.json` / `_cdi.md` to compare side-by-side:
```bash
mv "<case>/<stem>_cdi.json" "<case>/<stem>_cdi_balanced.json"
```

**Expected behavior:**

**Compliance mode** (`Mode: compliance`):
- [ ] Total flags ≤ 4
- [ ] **No** `type: "suggestion"` flags
- [ ] **No** `type: "opportunity"` flags
- [ ] All flag confidences ≥ 70
- [ ] Tone is conservative / audit-defense-focused

**Balanced mode** (`Mode: balanced`):
- [ ] Total flags ≤ 6
- [ ] **No** `type: "opportunity"` flags
- [ ] Flag confidences ≥ 50
- [ ] Includes both under-doc and over-doc risks

**Aggressive mode** (`Mode: aggressive`):
- [ ] Total flags ≤ 8
- [ ] **Includes** at least one `type: "opportunity"` flag (HCC hint, MDM upgrade path, or missed specificity)
- [ ] Flag confidences ≥ 30
- [ ] Surfaces revenue-lift / HCC-capture hints

**Cross-mode validation:**
- [ ] Compliance flag count ≤ Balanced flag count ≤ Aggressive flag count (monotonic)
- [ ] Compliance is a strict subset behavior-wise (no flag types missing from balanced)
- [ ] Aggressive surfaces categories balanced doesn't

---

## Scenario 4 — Edge cases

### 4a — Unsupported specialty

**Invocation:**
```bash
claude -p "review cdi. Case: <any case>. Specialty: cardiology. Mode: balanced. Doctor: Park. Standards: <NOTES_DIR>/.claude/standards"
```

**Expected:**
- [ ] `_cdi.json` is written and contains `"error": "specialty not yet supported for CDI v1: cardiology"`
- [ ] `_cdi.md` is written and explains why CDI was not performed
- [ ] `summary.flag_counts` are all 0
- [ ] Terminal line is `CDI_SKIPPED: unsupported specialty 'cardiology'`
- [ ] Skill exits 0 (not a failure)

### 4b — Null / empty specialty

**Invocation:**
```bash
claude -p "review cdi. Case: <any case>. Specialty: . Mode: balanced. Doctor: . Standards: <NOTES_DIR>/.claude/standards"
```

**Expected:**
- [ ] Same as 4a — stub JSON, MD, `CDI_SKIPPED` terminal line, exit 0

### 4c — Missing SOAP file in case dir

**Setup:** Case folder exists but has no `*_soap_note.md`.

**Expected:**
- [ ] Terminal line is `CDI_FAIL: soap_note_not_found in <case_dir>`
- [ ] Stub `_cdi.json` is still written (with `"error"` field) — downstream code needs a file
- [ ] Skill exits non-zero

### 4d — Missing transcript, SOAP present

**Setup:** Case folder has `*_soap_note.md` but no `transcript.md` / `*_transcript.md`.

**Expected:**
- [ ] Skill prints `WARN: transcript not found...` and proceeds
- [ ] Full CDI review is produced on the SOAP note alone
- [ ] `CDI_OK:` terminal line

### 4e — Standards directory missing

**Invocation:** Point `Standards:` at a non-existent path.

**Expected:**
- [ ] Skill prints `CDI_FAIL: standards_missing: <which file>`
- [ ] Stub `_cdi.json` is written if possible
- [ ] Skill exits non-zero

---

## Scenario 5 — JSON validation (independent)

**Pick any successful run from Scenarios 1–3. Verify:**

```bash
python3 -m json.tool <case>_cdi.json > /dev/null && echo OK || echo FAIL
```

- [ ] Output is `OK`

**Schema spot-check:**
- [ ] `meta` has all 6 fields: `case_dir`, `patient`, `doctor`, `specialty`, `mode`, `generated_at`, `standards_versions`
- [ ] `meta.standards_versions` has `icd10_cm`, `ahima_acdis`, `specialty_pack`
- [ ] `summary` has all 8 fields including `medical_necessity_status`, `claim_defense_readiness`, `clinician_approval_required`
- [ ] Every `flags[]` entry has `id`, `type`, `category`, `title`, `body`, `guideline_reference`, `drg_impact` (= null), `current_code`, `suggested_codes`, `confidence`, `evidence_found`, `evidence_missing`
- [ ] Every `flags[].type` is one of `critical` / `warning` / `suggestion` / `opportunity`
- [ ] Every `flags[].category` is one of `Specificity` / `Linkage` / `HCC` / `Completeness` / `Audit-defense`
- [ ] Every `flags[].confidence` is an integer 0–100
- [ ] Every `flags[].suggested_codes` entry has both `code` and `description`
- [ ] `flags[].evidence_found` and `evidence_missing` arrays each have ≤ 4 entries

---

## Scenario 6 — Markdown rendering and DOCX conversion

**Pick any successful run. Visual inspection of `_cdi.md`:**

- [ ] Title is `# CDI Review — <Patient Name>`
- [ ] Severity headings use the right emoji: 🔴 Critical, 🟡 Warning, 🟢 Suggestion, 🔵 Opportunity
- [ ] Each flag block has Title with confidence percentage in the heading
- [ ] Each flag block has `**Category:**`, `**Guideline:**` lines
- [ ] ICD-10 codes appear in `` `backtick` `` blocks
- [ ] Evidence-found and Evidence-missing lists render as markdown bullet lists
- [ ] Summary block contains `**Medical necessity:**`, `**Claim defense readiness:**`, `**Clinician approval required:**`
- [ ] Footer line includes standards versions

**DOCX conversion (manual, until Plan 2 wires it):**

```bash
python3 python/md_to_docx.py <case>/<stem>_cdi.md
```

- [ ] `_cdi.docx` is produced
- [ ] Open in Word / LibreOffice — severity emoji render, heading levels are right, bullets render

---

## Scenario 7 — Same case run twice

**Setup:** Pick any successful case. Run the skill **twice** in succession with the same inputs.

**Expected:**
- [ ] Both runs succeed
- [ ] Second run **overwrites** the JSON and MD in place (no `_cdi_2.json` appears)
- [ ] No backup of the prior CDI output is created (CDI is non-canonical; the SOAP note is the patient record)
- [ ] Flag content may differ slightly between runs (LLM nondeterminism) but the **shape** is identical (same fields, same enum values)

---

## Regression checklist — after any change to the skill or standards

When `SKILL.md`, `standards/icd10_fy2026.md`, `standards/ahima_acdis_2026.md`, or `standards/specialties/orthopedics.md` changes:

- [ ] Re-run Scenario 1 (Spencer post-op) — flag set should be substantially the same
- [ ] Re-run Scenario 2 (Sabbag EMG) — the critical-coexisting-Dx flag must still fire
- [ ] Re-run Scenario 4a — unsupported specialty still skips cleanly
- [ ] Re-run Scenario 5 — JSON still validates

If any of these regress: revert the change, file an issue, investigate. Don't ship a change that breaks the auto-critical conditions or the JSON schema.

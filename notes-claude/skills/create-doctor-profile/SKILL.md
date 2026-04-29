---
name: create-doctor-profile
description: >
  Analyse a set of real SOAP notes from one doctor and generate a doctor profile template for the generate-note skill.
  TRIGGER when: the user asks you to "create a doctor profile", "build a profile for doctor X", or provides a folder of sample notes to analyse.
  DO NOT TRIGGER when: the user is generating a SOAP note from a transcript or evaluating an existing note.
---

# Doctor Profile Builder

You are a medical documentation analyst. Your job is to study a set of real, human-written or human-edited SOAP notes (and any supporting documents) from one doctor and produce a detailed profile that captures their exact writing preferences, style, and field-level patterns.

The output is saved as a template file used later by the `generate-note` skill to produce new notes for this doctor.

**This skill runs unattended as a background job from the AI Medical Scribe app.** There is no interactive user to confirm judgment calls — when multiple paths are plausible, pick the best-supported one, state what you chose and why, and proceed. Do not stop to ask questions.

---

## Step 0: Parse the Job Inputs

The app invokes this skill with a prompt of the form:

```
create a doctor profile for "<doctor-name>" from source folder "<relative-staging-path>"
```

Extract:

- **DOCTOR_NAME** — the doctor's name. Normalise to lowercase last name for filenames (e.g. "chen"). Preserve the original for the profile header ("Dr. Chen").
- **STAGING_REL** — the relative path of the staging folder containing the source files (relative to the current working directory, which is the workspace root `AI Medical Notes/`).

If either field is missing or malformed, log the problem to stdout, exit with a non-zero shell command, and stop.

---

## Step 1: Resolve Paths

```bash
# The app spawns us with cwd = <AI Medical Notes workspace root>
WORKSPACE="$(pwd)"
STAGING_DIR="${WORKSPACE}/${STAGING_REL}"
TEMPLATES_DIR="${WORKSPACE}/templates"
mkdir -p "${TEMPLATES_DIR}"

echo "WORKSPACE=${WORKSPACE}"
echo "STAGING_DIR=${STAGING_DIR}"
echo "TEMPLATES_DIR=${TEMPLATES_DIR}"

ls -la "${STAGING_DIR}"
```

If `STAGING_DIR` is empty or missing, fail fast — the app is expected to have staged the files before spawning this skill.

---

## Step 2: Inventory the Source Files

Classify each file in `STAGING_DIR` into one of two buckets:

| Bucket | Extensions / heuristics |
|---|---|
| **Sample notes** | The bulk of the files (typically 50–200). Usually `.md`, `.docx`, `.json`, or `.txt`. Often share a naming pattern (dates, patient IDs, numbered). |
| **Supporting documents** | A small number of files (typically 1–5) with names like `cheatsheet*`, `guide*`, `rules*`, `template*`, `instructions*`, `readme*`, or visibly different content (shorter / non-note / structured reference). |

If it's ambiguous — e.g. one large `.docx` alongside a few small `.docx` — treat the large one as a concatenated-notes export and the small ones as supporting docs.

Report the classification once:

> "Found [N] sample notes and [M] supporting document(s). Proceeding."

---

## Step 3: Load Supporting Documents (if any)

For each supporting document, read full text:

- `.md`, `.txt`, `.json` → read directly via the Read tool
- `.docx` → extract with python-docx:

```bash
python3 -c "
from docx import Document
doc = Document('<FILE_PATH>')
print('\n'.join(p.text for p in doc.paragraphs))
"
```

Combine all extracted text into `SUPPORTING_TEXT`. These documents may contain:

- Rules about how templates or boilerplate should be used, retained, edited, or removed
- Inference restrictions ("do not invent", "do not expand")
- Default/placeholder language that is meant to be edited per visit rather than used verbatim
- SmartPhrase instructions, EMR shortcuts, cheatsheets

Capture any "do / do not" instructions explicitly — they will become the `Template Usage Rules` section in the generated profile (Step 9).

---

## Step 4: Detect Input Format and Load Notes

Inspect the sample-notes bucket:

| What you find | Format |
|---|---|
| Directory of `.md` files | One note per file — read each |
| Directory of `.docx` files | One note per file — extract text per file |
| Directory of `.json` files | One note per file — inspect schema of one file, then map fields |
| Single `.docx` / `.md` / `.txt` | All notes concatenated — extract text then split on boundaries |

Report:

> "Input format: [description]. Proceeding with extraction."

### Extracting `.docx` text

```bash
python3 -c "
from docx import Document
doc = Document('<FILE_PATH>')
print('\n'.join(p.text for p in doc.paragraphs))
"
```

### EMR export vs clean notes

Scan the first ~50 lines of the extracted text plus a middle sample. Classify:

**EMR/EHR concatenated export** — signals:
- Lines like `Date of Service:` immediately followed by `Patient Name:` (private notes)
- `PRIMARY TREATING PHYSICIAN'S PROGRESS REPORT` headers (WC notes)
- Bracketed EMR placeholders like `[Past Medical History ]`, `[Current Medications]`
- Billing code lines (`99214 - This visit evaluated...`)
- Stacked `[INTERVAL date]:` entries inside the HPI field
- Scribe/provider attestation blocks

**Clean standalone notes** — signals:
- Consistent heading structure throughout, no system-generated placeholders
- Each note clearly separated, one patient per section
- No billing codes or legal/regulatory blocks

State the detected type briefly:

> "Detected: EMR/EHR concatenated export. Running adaptive boundary detection."

### Splitting a single concatenated file into individual notes

Use adaptive boundary detection — do **not** assume specific text.

**Step A — Estimate note count:** Count total lines. A typical clinical note is 30–150 lines. 3,000 lines ≈ ~50 notes.

**Step B — Scan for candidate anchor patterns:**

| Category | What to look for |
|---|---|
| **ALL-CAPS headers** | Entire line uppercase and ≥3 words |
| **Date + Patient pairs** | A date-like line (`MM/DD/YYYY`, month-name year, etc.) within 3 lines of a patient-name line |
| **Letter/salutation openers** | Lines starting with `Dear `, `To Whom`, `RE:`, `ATTN:`, `TO:` |
| **Credential signature lines** | Lines ending with medical credentials: `M.D.`, `D.O.`, `N.P.`, `PA-C`, `M.D., F.A.C.S.` |
| **Hard dividers** | Lines composed entirely of dashes/equals/asterisks (≥10 characters) |

**Step C — Find the repeating pattern:** Count each candidate's occurrences. The pattern that repeats ~N times (matching your estimate ± 30%) is the boundary. Compound boundaries (two patterns co-occurring within 3 lines) count as one.

**Step D — Pick and proceed (no user confirmation available):**
State what you chose and why, then split:

> "Splitting on: [pattern description]. Found [N] notes."

If no repeating structural pattern can be identified, state that clearly, process whatever structure you *can* identify, and flag this in Step 11.

---

## Step 5: Strip EMR Noise and Load All Notes

**For EMR/EHR exports**, before using each note for analysis, remove:

- **Bracketed EMR placeholders** matching `[Field Name]` or `[Field Name ]` (e.g. `[Past Medical History ]`, `[Current Medications]`, `[Family History ]`, `[Past Surgical History ]`)
- **Procedure form blocks** — structured injection/splinting/casting data, Universal Protocol consent text, Timeout attestation, Needle size / Steroid / Approach fields, Pre/Post-Procedure Assessment tables, anything following "Performed by:" / "Authorized by:"
- **Billing code lines** — lines beginning with CPT codes `99201`–`99215`, `99080`, or `ML 100`, plus their attached explanation
- **WC regulatory sections** — DISCLOSURE, EXCESS OF FEE SCHEDULE, AFFIDAVIT OF COMPLIANCE
- **Scribe and provider attestation blocks** — "I, [Name], am acting as scribe..." / "I, Dr. [Name], performed the services described..."
- **Empty ROS placeholder** — a lone `ROS` or `Review of Systems` line with nothing following

**Keep for analysis:** HPI / History of Present Illness / SUBJECTIVE COMPLAINTS, Musculoskeletal Note, Physical Examination narrative, Assessment & Plan, TREATMENT PLAN, WORK RESTRICTIONS, Radiograph / Imaging interpretations, Chief Complaint, Current Complaints.

Number notes internally (Note 1 … Note N). Flag any note that is malformed, incomplete, or structurally very different — keep it in the sample but call it out in Step 11.

---

## Step 6: Detect Note Types

Classify each note:

| Type | Signals |
|---|---|
| **WC follow-up** | Letter format, "PR-2", adjuster/carrier address, "TREATMENT PLAN:", "WORK RESTRICTIONS:" |
| **WC initial** | "PR-1", "CHIEF COMPLAINT:", "JOB DESCRIPTION:", "PRIOR INDUSTRIAL INJURIES:" |
| **Private follow-up** | EMR/SOAP format, Title Case headings, "History of Present Illness", "Assessment & Plan" |
| **Private initial** | Similar to private follow-up with first-visit language ("initial consultation", demographics line) |
| **Telehealth** | "telehealth", "virtual visit", "per last in-person exam" |

Report:

> "Note type breakdown: 32 WC follow-up, 11 WC initial, 7 private follow-up. Running separate analysis per type."

**If multiple note types** are present, analyse each type independently in Steps 7–9 and produce a separate section per type. Do not mix WC and private notes — the doctor likely writes them very differently.

---

## Step 7: Boilerplate Detection

Scan all notes for text that appears verbatim (or near-verbatim) across **3 or more notes**. For each block:
- Quote the text exactly
- Record frequency (e.g. "found in 41/50 notes")
- Give it a short name (`biopsychosocial_paragraph`, `ros_default`, `xray_closing`, `plan_closer`, `scribe_attestation`)

Also scan `SUPPORTING_TEXT` for additional boilerplate language not well-represented in the note sample. Tag those with `[from supporting docs]`.

---

## Step 8: Field Inventory + Per-Field Deep Analysis

For each note type, build a field inventory:

| Field | Heading Level | Present In | Content Type |
|---|---|---|---|
| Patient Name | #### | 50/50 | Single line |
| Chief Complaint | ### | 50/50 | Prose, 1 sentence |
| History of Present Illness | ### | 50/50 | Prose, paragraph |
| Musculoskeletal | ### | 38/50 | Mixed |
| Assessment | ### | 50/50 | Bullet list |
| Plan | ### | 50/50 | Bullet list |

Flag fields present in fewer than 70% of notes — they are likely conditional.

Then, for each field, extract and record:

### 8a. Structure & Length
Prose vs bullets vs single line; typical word count or sentence/bullet count; internal ordering. Include evidence counts (e.g. "prose in 47/50 notes, bullets in 3/50").

### 8b. Opening Patterns
How content begins; recurring sentence starters. Quote 2–3 real opening lines verbatim. Include counts.

### Special handling: Cumulative HPI in EMR exports

EMR private notes stack visit summaries inside HPI chronologically:

```
[INTERVAL 8/11/2025]: most recent visit — use this for analysis
[INTERVAL 7/18/2025]: older — ignore
[INTERVAL 6/23/2025]: older — ignore
...
[INITIAL 11/4/2024]: first visit — ignore
```

**Use only the most recent `[INTERVAL date]:` entry for style analysis.** Older entries may have been written by different scribes at different times. Discard them. If the most recent is `[INITIAL date]:`, use it.

### 8c. Always Included
Explicit rules with counts: e.g. "Onset and duration always stated (50/50)".

### 8d. Never Included
Explicit "do not include" rules with counts: e.g. "Pain scale numbers never used (0/50)".

### 8d-diagnosis. Diagnosis Location and Format
*Apply when analysing Assessment, Diagnosis, Treatment Plan, or A&P fields — and once globally: where do diagnoses actually live in this doctor's notes?*

Answer explicitly in the profile:
- **Which section contains diagnosis content?**
- **Is any section heading intentionally left blank?** (e.g. "DIAGNOSES always blank in WC notes — content appears in TREATMENT PLAN opening sentence")
- **Exact opening sentence pattern** — quote 2+ verbatim examples
- **How are multiple diagnoses listed?** (numbered, comma-separated inline, bullets, prose)

### 8e. Normal Exam Templates and Measurement Blocks
*Apply to physical exam, objective findings, any field with structured measurements.*

**Normal exam templates:** Near-identical language in 3+ notes → extract as named template with `[placeholder]` syntax for variable parts. Name by body region (e.g. `cervical_spine_normal`).

**Measurement blocks:** If any numeric measurements (grip strength, JAMAR, ROM in degrees, nerve conduction, strength scales):
- Quote a full verbatim example
- Document heading/label style
- Document units, precision, layout
- Note whether both sides or only affected
- If only narrative descriptions, state so explicitly.

### 8f. Vocabulary & Terminology
Consistent terms, avoided words, abbreviation preferences with counts (e.g. "'range of motion' spelled out in 44/50, 'ROM' in 6/50").

### 8g. Edge Case Handling and Conditional Triggers
What happens when info is missing — blank, "not reported", section removed? For any section present in <90% of notes, document:
- The trigger that causes it to appear
- What happens when the trigger is absent (omit / blank / placeholder)
- Example when present vs absent

### 8h. Representative Examples
2 real examples per field — one typical, one showing an interesting pattern. Quote verbatim (truncate long ones with "...").

### 8i. Cross-reference supporting documents
Check `SUPPORTING_TEXT` for additional terminology, exam language, or field-specific phrasing. Incorporate anything useful, marked `[from supporting docs]`.

---

## Step 9: Cross-Cutting Style Analysis

Global patterns, with counts:

### Attribution Verbs
Count frequency across all notes:

| Verb | Count | % of attributions |
|---|---|---|
| reports | | |
| states | | |
| denies | | |
| complains | | |
| endorses | | |
| describes | | |

State primary (most-used), secondary, and any notably-absent verbs.

### Other Style Patterns
- **Pronoun usage:** "she/he", "they", "the patient"? e.g. "gendered in 48/50 notes"
- **Voice:** active vs passive ratio
- **Tense:** present vs past tense per section type
- **Abbreviations:** for each common one (pt/patient, ROM/range of motion, hx/history, dx/diagnosis), full vs abbreviated counts. Flag strong preferences (>85%)
- **Capitalisation:** heading style — ALL CAPS / Title Case / sentence case
- **Numbers:** numerals vs words
- **Uncertainty language:** how unconfirmed info is expressed
- **Empty sections:** deleted / blank / default-filled — with counts
- **Overall tone:** clinical-formal / conversational

---

## Step 10: Generate the Profile

Output format — **plain markdown**, no XML tags (the `generate-note` skill reads this directly with Sonnet and has been reliable with plain markdown).

**Header:**

```markdown
# Dr. [Lastname] — SOAP Note Profile

**Created from:** [N] sample notes
**Note types analysed:** [list, e.g. "WC follow-up (32), WC initial (11), private follow-up (7)"]
**Date:** [Today's date, YYYY-MM-DD]

---

## Global Style

[3–5 sentences summarising overall writing style]

**Primary attribution verb:** [e.g. "reports" (~65% of attributions)]
**Secondary attribution verb:** [e.g. "states" (~25%), "denies" for negatives]
**Avoided:** [e.g. "endorses" — not observed in sample]
**Pronouns:** [e.g. "Gendered (she/he/her/his) — 48/50 notes. Infer from context."]
**Voice:** [e.g. "Active — 'she reports' not 'it was reported'"]
**Abbreviations:** [e.g. "Spells out 'range of motion' (44/50), 'patient' (50/50). Uses FDS, FDP, CMC, ROM for joint terms only."]
**Empty sections:** [e.g. "Deleted when no data — never left blank (observed in 18 instances)"]

---
```

**Template Usage Rules** — include only if `SUPPORTING_TEXT` had rules/guidelines:

```markdown
## Template Usage Rules

[Rules from supporting documents about how to use templates, boilerplate, SmartPhrases. When to retain vs edit vs remove; inference restrictions; default language meant to be edited per visit. Tag each: [from supporting docs] or [observed in notes].]
```

**Boilerplate Blocks** — include if any were found:

```markdown
## Boilerplate Blocks

Verbatim blocks that appear consistently. Use them exactly as written — do not paraphrase.

### [block_name]
*Found in [N/total] notes*
> "[exact text]"
```

**Note Type Sections** — one per note type (or single unified section if only one type):

```markdown
## [Note Type Name, e.g. "WC Follow-Up Notes"]

### [Field Name]

**Format:** [Narrative prose / Bullet list / Single line]
**Typical length:** [e.g. 3–5 sentences / 2–4 bullets]

**Always include:** *(X/N notes)*
- [Rule]

**Never include:** *(absent in X/N notes)*
- [Rule]

**Style notes:**
- [Vocabulary/voice/formatting preference with counts]

**Normal templates:** *(if exam field)*
- `[template_name]` — found in [N/total]:
  > "[verbatim template with [placeholders]]"

**Examples from sample notes:**
> "[Verbatim example 1]"

> "[Verbatim example 2]"

**Edge cases:**
- [Missing info handling, conditional content, etc.]
```

Save the profile to:

```
${TEMPLATES_DIR}/<lastname>.md
```

Use the Write tool. If the file already exists, overwrite it — the app manages versioning externally.

Confirm on stdout:

> "Profile saved to `templates/<lastname>.md`"

---

## Step 11: Report Inconsistencies

After saving, print a short bulleted list of anything a human should review:

- Fields present in <70% of notes (flagged as conditional)
- Patterns where meaningful variation was observed and a judgment call was made
- Notes that were structurally unusual or partially excluded
- Abbreviation splits that were close (e.g. 60/40) — could go either way
- Boilerplate blocks with minor wording variation — flag intentional vs transcription drift

Example:

> **A few things to review:**
> - "Musculoskeletal" absent in 12/50 notes — treated as conditional
> - HPI length varied from 2 to 8 sentences — profiled as 4–5
> - "range of motion" vs "ROM": 44 vs 6 — profiled as "spell out", weaker preference than most
> - Biopsychosocial paragraph had minor variation across 8 notes — used most common

If nothing meaningful, say so in one sentence.

---

## Important Reminders

- **No user prompts mid-run.** This skill runs as a background job. Make decisions, state them, continue.
- **Write the final profile with the Write tool**, not bash heredocs — the Write tool handles UTF-8 properly.
- **Every rule must carry an evidence count** — the profile's value is that it's grounded in observed frequencies, not vibes.
- **Do not invent fields or rules** the sample doesn't support. Absence of evidence is a valid observation.

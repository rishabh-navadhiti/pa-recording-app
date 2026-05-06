---
name: update-doctor-profile
description: >
  Update or correct an existing doctor profile template.
  Triggered when the user says "update template for doctor X",
  "correct the [doctor] profile", "modify sabbag template", etc.
  The prompt is pre-framed by the app and always contains: doctor name,
  template path, and the user's correction instructions.
---

# Doctor Profile Template Updater

You are a medical documentation specialist maintaining doctor profile templates.
Follow these steps exactly to apply corrections to an existing template.

---

## Step 0: Extract Pre-Framed Inputs

The prompt sent to you is always structured by the app in this exact format:

```
update doctor profile. Doctor: <lastname>. Template: <absolute/path/to/lastname.md>. Corrections: <user corrections text>. CorrectionsFile: <absolute/path/to/file or empty>. Samples: <absolute/path/to/staging/folder or empty>
```

Extract these five fields directly:

- **DOCTOR_NAME** — the value after `Doctor:` (lowercase lastname, e.g. `sabbag`)
- **TEMPLATE_PATH** — the value after `Template:` (absolute path to the `.md` file, e.g. `C:/Users/you/Documents/AI Medical Notes/templates/sabbag.md`)
- **CORRECTIONS** — the value after `Corrections:` and before `CorrectionsFile:` (inline text; may use ` | ` as a line separator; may be empty)
- **CORRECTIONS_FILE** — the value after `CorrectionsFile:` and before `Samples:` (absolute path to a `.txt`, `.md`, or `.docx` file; may be empty)
- **SAMPLES_DIR** — the value after `Samples:` (absolute path to a folder of staged sample note files; may be empty)

At least one of CORRECTIONS / CORRECTIONS_FILE / SAMPLES_DIR will be non-empty.

Parse all inline corrections into individual edit units. Each distinct instruction (separated by ` | ` or natural sentence boundaries) is one unit. Additional units from CORRECTIONS_FILE and SAMPLES_DIR are loaded in later steps.

---

## Step 1: Verify Template Exists

```bash
TEMPLATE_PATH="<TEMPLATE_PATH from Step 0>"
DOCTOR_NAME="<DOCTOR_NAME from Step 0>"

if [ ! -f "${TEMPLATE_PATH}" ]; then
  echo "TEMPLATE_NOT_FOUND: ${TEMPLATE_PATH}"
  exit 1
fi

TEMPLATES_DIR=$(dirname "${TEMPLATE_PATH}")
BACKUPS_DIR="${TEMPLATES_DIR}/backups"
mkdir -p "${BACKUPS_DIR}"

echo "TEMPLATE_OK"
echo "TEMPLATES_DIR=${TEMPLATES_DIR}"
echo "BACKUPS_DIR=${BACKUPS_DIR}"
```

- If output is `TEMPLATE_NOT_FOUND` → log the attempted path, show the user:
  > ⚠️ Template not found at `<TEMPLATE_PATH>`. Please check the doctor name and try again.

  Then stop. Do not search for an alternative path.

- If output is `TEMPLATE_OK` → proceed.

---

## Step 2: Create Timestamped Backup

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="${BACKUPS_DIR}/${DOCTOR_NAME}_backup_${TIMESTAMP}.md"
cp "${TEMPLATE_PATH}" "${BACKUP_PATH}"

if [ -f "${BACKUP_PATH}" ]; then
  echo "BACKUP_OK: ${BACKUP_PATH}"
else
  echo "BACKUP_FAILED"
  exit 1
fi
```

If `BACKUP_FAILED` → stop and inform the user. Do not modify the original template without a confirmed backup.

The current template is your baseline. You will produce a **new** updated template and write it back to `${TEMPLATE_PATH}`. The original is preserved untouched as the backup above. This backup-then-overwrite model applies whether changes come from inline text, a corrections file, or sample analysis.

---

## Step 3: Load Existing Template

Read the full template file at `${TEMPLATE_PATH}` using the Read tool.

Confirm it is non-empty. If empty → stop and inform the user.

**Read the entire template before proceeding to Step 4.** The template content is your primary source of context for interpreting the user's corrections. A correction like "change attribution verb" only makes sense after you have seen the current attribution verb in the template's Global Style section.

---

## Step 4: Load All Corrections and Classify

Before making any changes, collect all correction units from every source.

### 4a — Inline text corrections (CORRECTIONS field from Step 0)

Parse the inline text into individual units separated by ` | ` or natural sentence boundaries.

### 4b — Corrections file (CORRECTIONS_FILE from Step 0; skip if empty)

Read the file at CORRECTIONS_FILE:

- `.txt` or `.md` → read directly with the Read tool
- `.docx` → extract text:

```bash
python3 -c "
from docx import Document
doc = Document('<CORRECTIONS_FILE>')
print('\n'.join(p.text for p in doc.paragraphs))
"
```

Parse the extracted text as additional correction units exactly as you would inline text.

### 4c — Classify every correction unit

For each correction from 4a and 4b, identify:

| Dimension | What to determine |
|-----------|-------------------|
| **Target section** | `Global Style` / `Boilerplate Blocks` → block name / Note Type section → field subsection |
| **Action** | Replace (old value → new value) / Add (new block, rule, or section) / Remove / Amend (extend or refine existing content) |
| **Scope** | Global (applies to all note types) or scoped to a specific note type |
| **Propagation** | Style and global rule changes must be updated in every location they appear — Global Style section AND any per-note-type style notes or cross-references |

### Ambiguity rule

Use the template you loaded in Step 3 as context before declaring a correction ambiguous. Most corrections that seem vague in isolation become clear once you know the template's current content — for example, "change the attribution verb" is unambiguous once you have read the Global Style section.

If a correction is **still** unclear after reading the template — do not guess and do not ask mid-run. Stop and show the user:

> ⚠️ Could not apply the following correction(s) — more context needed:
>
> - `<quote the ambiguous text>` — <one sentence explaining what is unclear even after reading the template>
>
> Please retry with more specific instructions.

Do not apply any corrections (even the unambiguous ones) in the same run.

---

## Step 4.5: Sample Analysis (only if SAMPLES_DIR is non-empty)

This step runs the `create-doctor-profile` analysis pipeline on the new samples to discover findings, then adds those findings to the correction units list.

### Phase A — Run `create-doctor-profile` on the new samples

1. Read the `create-doctor-profile` skill at `.claude/skills/create-doctor-profile/SKILL.md` to load the exact methodology.

2. Execute its **Steps 2 through 9** on the files in `SAMPLES_DIR`:
   - **Step 2**: Inventory files (sample notes vs supporting docs)
   - **Step 3**: Load supporting documents
   - **Step 4**: Detect input format and load notes
   - **Step 5**: Strip EMR noise
   - **Step 6**: Detect note types
   - **Step 7**: Boilerplate detection
   - **Step 8**: Field inventory + per-field deep analysis
   - **Step 9**: Cross-cutting style analysis

3. The result is a **temporary new profile** built solely from the new samples. Do **not** write it to `templates/<lastname>.md` — the existing template must not be overwritten at this stage.

### Phase B — Compare temporary profile to existing template and produce findings

Walk through the temporary profile section by section and compare against the loaded existing template (from Step 3):

| Finding type | Rule |
|---|---|
| **New note type** | Present in temporary profile, absent from existing template → add as a new note type section |
| **New boilerplate block** | Block in temporary profile not in existing template's Boilerplate Blocks → add it |
| **Refined frequency evidence** | Temporary profile has stronger sample count for an existing rule → update the count; change the rule only if the direction changes (e.g. primary attribution verb switches) |
| **Style rule divergence** | Temporary profile diverges on an existing Global Style rule → apply only if decisive (>85% in new samples); otherwise log under "Inferences made" in the report |
| **New field / subsection** | Field in temporary profile not captured in an existing note type section → add it |

Each finding becomes an additional correction unit, processed in Step 5 alongside the text/file corrections from Step 4.

---

## Step 5: Apply Changes — Surgical Edits Only

Work through each classified correction. Touch only the targeted content; leave everything else intact.

### Style rule changes
*(attribution verbs, pronouns, abbreviations, tense, voice, heading format, number style)*

1. Find and update the rule in `## Global Style`.
2. Scan the entire template for per-note-type "Style Notes" sections and any cross-reference lines that repeat the same rule.
3. Update every instance consistently. Do not alter content that is not related to the changed rule.

### Boilerplate block changes
*(add, edit, or remove a named verbatim text block)*

- **Edit:** locate the block by its heading name under `## Boilerplate Blocks`. Replace the body text. Preserve the heading, trigger condition line, and frequency count unless the correction explicitly changes those.
- **Add:** append a new block at the end of `## Boilerplate Blocks` following this format:
  ```
  ### <Block Name>
  **Trigger:** <condition when this block is used>
  **Frequency:** <N/total if known, or "as needed">

  <exact verbatim text>
  ```
- **Remove:** delete the entire named block (heading + body).

### Field / section content changes
*(always/never rules, opening patterns, normal exam templates, edge-case handling, examples)*

1. Navigate to the correct Note Type section (e.g. `## WC Follow-Up Notes`).
2. Navigate to the correct field subsection (e.g. `### Physical Examination`).
3. Apply the targeted edit. Leave all other subsections in that Note Type untouched.

### Structural changes
*(add a new note type section, reorder sections)*

- **Add new note type:** append a new section at the end of the file. Mirror the heading hierarchy and subsection structure used by existing note type sections in this template.
- **Reorder:** move sections to the requested order. Do not alter any content within the sections.

---

## Step 6: Save Updated Template

At the top of the template, find the header metadata block (lines beginning with `**Doctor:**`, `**Notes analyzed:**`, `**Date:**`). Add or update a revision line immediately below it:

```
**Last Updated:** <YYYY-MM-DD> — <N> correction(s), <M> finding(s) from <K> new samples
```

Omit the samples clause if no samples were analysed.

Write the complete modified template back to `${TEMPLATE_PATH}` using the Write tool.

---

## Step 7: Report to User

Always begin the report with exactly `Updated: <TEMPLATE_PATH>` on its own line — this is the marker `main.js` uses to locate the report in stdout.

```
Updated: <TEMPLATE_PATH>
Backup:  <BACKUP_PATH>

Changes from text/file corrections (<N>):
1. [<Section>] <What changed> (propagated to: <other locations if any>)
2. [<Section> → <Subsection>] <What changed>
...

Changes from sample analysis (<M> findings from <K> samples):
1. [<Section>] <What changed>
...

Inferences made (please review):
- <Any place where the instruction was interpreted rather than literal — what was assumed and why>
```

Omit any section that is empty (no text corrections, no sample findings, no inferences).

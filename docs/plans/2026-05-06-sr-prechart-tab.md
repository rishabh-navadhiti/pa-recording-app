# Pre-chart tab for the edit-note skill

## Context

The `edit-note` skill ([notes-claude/skills/edit-note/SKILL.md](../../../notes-claude/skills/edit-note/SKILL.md)) regenerates an existing SOAP note by integrating new clinical info and/or scribe corrections. Its prompt contract is fixed and takes one attachment path:

```
edit note. Case: <abs-case-dir>. Template: <abs-template-path>. Attachment: <path-or-empty>. Instructions: <text-or-empty>
```

The app adds a dedicated **Pre-chart** tab (third tab, alongside Record and Templates). The scribe picks a doctor, picks a patient case, types instructions, optionally attaches multiple files, and starts a background job. The skill is not touched.

---

## Multi-file attachment flow

The skill accepts exactly **one** attachment path (a single `.md` file). The Pre-chart UI lets the scribe pick multiple files of mixed formats (`.md`, `.txt`, `.docx`, `.pdf`).

**App-side bridge — `python/extract_attachments.py`:**

1. Reads the **contents** of every selected file, converting each to plain text:
   - `.md` / `.txt` → read as UTF-8
   - `.docx` → python-docx paragraphs
   - `.pdf` → pdfplumber, fallback to pypdf
2. Writes all content into **one combined `.md`** in OS temp:
   ```
   <contents of file 1 — verbatim>

   --- file2.pdf ---

   <contents of file 2 — verbatim>

   --- file3.docx ---

   <contents of file 3 — verbatim>
   ```
   First file gets no header. Subsequent files are separated by `--- <basename> ---` so Claude can attribute content to its source.
3. That combined `.md` path is passed as `Attachment:` to the skill.
4. Temp `.md` is deleted after the job exits (success or failure).

**Why this approach:** Claude receives ready-to-read plain text. The skill's Step 5 already reads `.md` natively — no extra extraction step needed inside the skill. The Python helper is the only place that handles binary format conversion.

---

## Pre-chart tab — field order

```
[Doctor dropdown    ▼]              ← 1st: required; template resolved from settings.json
[Patient case  ▼] [Browse…]         ← 2nd: required
[Instructions textarea]             ← 3rd: optional (required if no files)
[Attachments list] [+ Add files]    ← 4th: optional (required if no instructions)
[Start]                             ← disabled until doctor + case + (instructions OR files)
[error area]
```

No auto-preselect on any field. User makes all selections manually.

---

## Full job flow

```
Scribe selects:
  Doctor        →  doctorId  (resolved to templatePath via settings.json)
  Patient case  →  caseDir   (existing case folder with *_soap_note.md)
  Instructions  →  free text (optional)
  Files         →  [file1.docx, file2.pdf, ...]  (optional)

main.js:
  1. Looks up doctor by doctorId in settings.json → templatePath
  2. Validates caseDir has a *_soap_note.md
  3. If files provided:
       python extract_attachments.py --output /tmp/prechart_<ts>.md --inputs file1.docx file2.pdf ...
       → combined .md written to OS temp
  4. Spawns:
       claude -p "edit note. Case: <caseDir>. Template: <templatePath>. Attachment: /tmp/prechart_<ts>.md. Instructions: <text>"
       --model <soapModel>  CLAUDE_CODE_EFFORT_LEVEL=high
  5. On job exit (any outcome) → delete /tmp/prechart_<ts>.md
  6. On exit code 0 → spawnDocxConversion on the updated soap note

Skill (edit-note):
  Backs up existing soap note → regenerates with new content → overwrites in place
```

---

## IPC contract

| Method | Signature | Purpose |
|---|---|---|
| `browsePrechartFiles` | `()` | Multi-select picker for `.md/.txt/.docx/.pdf` |
| `listRecentPatientCases` | `()` | Returns 30 most-recent case entries `{caseDir, patient, date, mtime}` |
| `browsePatientCaseFolder` | `()` | Folder picker scoped to Cases dir; validates soap note exists |
| `startPrechartJob` | `(doctorId, caseDir, instructions, attachmentPaths)` | Resolves template, builds combined attachment, spawns job |

Shared with template jobs: `getTemplateJobStatus`, `cancelTemplateCreation`, `dismissTemplateJob`, `onTemplateJobStatus`.

---

## Files changed

| File | Change |
|---|---|
| [renderer/index.html](../../../renderer/index.html) | `#tab-prechart` with doctor select, case picker, instructions, attachments, start, error |
| [renderer/renderer.js](../../../renderer/renderer.js) | `refreshPrechartTab()`, `updatePrechartStartEnabled()`, event wiring, job banner for `type === 'prechart'` |
| [renderer/styles.css](../../../renderer/styles.css) | Pre-chart layout styles |
| [preload.js](../../../preload.js) | 4 new IPC methods; `startPrechartJob(doctorId, caseDir, instructions, attachmentPaths)` |
| [main.js](../../../main.js) | 4 IPC handlers, `spawnPrechartJob`, `buildCombinedAttachment`, `findRecentPatientCases`, `safeWriteFile` |
| [python/extract_attachments.py](../../../python/extract_attachments.py) (new) | Multi-file → single combined `.md` |
| [CLAUDE.md](../../../CLAUDE.md) | Pre-chart pipeline + IPC table |
| [docs/ARCHITECTURE.md](../ARCHITECTURE.md) | Pipeline diagram + IPC table |

**`notes-claude/skills/edit-note/SKILL.md` is NOT modified.**

---

## Verification

1. `npm start` → open Pre-chart tab.
2. Doctor dropdown populated with doctors that have templates; no pre-selection.
3. Select doctor → select patient case → type instructions → attach a `.docx` and `.pdf` → Start.
4. Banner shows "Pre-charting `<patient>`…".
5. While running: confirm `/tmp/prechart_<ts>.md` exists and contains both files' text with `--- <basename> ---` separator.
6. After completion: `<case>_soap_note.md` updated, backup created, `.docx` regenerated, temp `.md` deleted.
7. **Instructions-only**: no files attached → `Attachment:` field is empty, skill runs on instructions only.
8. **Single file**: attach one `.pdf` → combined `.md` contains just the PDF text, no separator.
9. **Validation**: Start disabled if doctor not selected.
10. **Validation**: Start disabled if case selected but no instructions and no files.
11. **Busy lock**: starting while a template job runs → error area shows "another job is running".
12. `app.log` has `[prechart][<patient>]` lines for the run.

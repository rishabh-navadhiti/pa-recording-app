# Skill manifest contract + DOCX unification + multi-patient app split

**Status:** Planned. Single PR — skill change + main.js change land together.

**Scope:** Three changes that share the same skill↔app contract, so they ship together:

1. **`generate-note` skill emits a structured JSON manifest** as its final line of output, declaring patient(s), file paths, and a multi-patient flag.
2. **DOCX generation moves entirely out of the skill** — `main.js` calls `python/md_to_docx.py` after parsing the manifest.
3. **Multi-patient folder creation moves entirely out of the skill** — for multi-patient runs, the skill writes all `.md` outputs into the original recording folder; main.js reads the manifest and creates the per-patient case folders, copies files into them (the recording folder retains everything as the audit trail), converts to docx, hides `.md`, and inserts the child `cases` rows.

**Out of scope:**

- Touching `cdi-review`, `edit-note`, `create-doctor-profile`, `update-doctor-profile`, or the new `icd` skill on the `icd10-coding` branch. They already either produce only `.md` (app converts) or use their own terminal-line contract. Adopting this JSON manifest format across all skills is a future follow-up — listed in "Future work" below.
- Adding new columns to `app.db`. All manifest data the app writes to the DB lands in existing columns; everything else lives in the manifest in memory and gets logged to `app.log`.
- Touching `python/md_to_docx.py` internals — it already converts one file at a time and is called per-file.
- Changing how the recording folder itself is named or where the audio + transcript land. Only the post-SOAP behaviour changes.

---

## Context

### The two problems being fixed

**Problem A — Skill owns folder creation in multi-patient runs.**
Today the `generate-note` skill (Step 4 in `SKILL.md`) handles multi-patient cases by:

- Detecting multiple patients in the transcript
- Creating per-patient sub-folders next to the recording folder
- Copying the MP3 and full transcript into each sub-folder
- Writing each patient's SOAP note into its own sub-folder
- Calling pandoc / `python-docx` inline to generate the docx for each

This works but moves filesystem manipulation, file copying, and docx orchestration inside a Claude invocation. It costs context tokens, can fail in subtle ways across platforms (Windows vs macOS bash differences), and `main.js` has no clean way to know which sub-folders the skill created — so DB writes, file hiding, status reporting, and any downstream skill chaining (`icd`, `cdi-review`) become best-effort discovery.

**Problem B — Skill owns docx generation in `generate-note` only.**
Every other skill produces `.md` and relies on `main.js → spawnDocxConversion → python/md_to_docx.py`. Only `generate-note` runs docx inline. Two code paths for the same operation: any future docx-styling change (CDI severity-coloured cells, etc.) has to be implemented twice.

### The fix in one sentence

The skill becomes a pure note generator: it reads inputs, writes `.md` files into the folder it was given, and emits a JSON manifest declaring what it wrote. The app does everything else — folder splits, file copies, docx, hiding, DB writes.

### Why this is one plan and not two

Both changes touch the same place in the skill (Steps 4 and 6) and the same place in `main.js` (`spawnSoapGeneration`'s close handler). Splitting them would mean two rounds of `SKILL.md` edits and two rounds of close-handler edits. One PR with both is cleaner.

---

## Target state

### Single-patient run (unchanged user-visible behaviour)

1. Scribe records, types patient name → app creates `<NOTES_DIR>/Cases/<session_date>/<patient_name>/`, drops MP3 + transcript there.
2. `spawnSoapGeneration` invokes the skill with `cwd = <NOTES_DIR>`, pointing at the transcript.
3. Skill detects single patient. Writes `<patient_name>_soap_note.md` into the case folder.
4. Skill emits JSON manifest as last line: `multi_patient: false`, one entry in `cases[]`, paths declared.
5. `main.js` parses the manifest. Single-patient branch:
   - Verifies the `soap_note_md` exists on disk.
   - Calls `spawnDocxConversion(soap_note_md)`.
   - Hides `.md` on Windows.
   - Updates the existing `cases` row (`status='completed'`, `soap_note_path=...`, `soap_docx_path=...`, `completed_at=...`).

End result identical to today, minus the inline docx step.

### Multi-patient run (new behaviour)

1. Scribe records, **leaves patient name blank or types something generic like "multiple patients"**. App creates `<NOTES_DIR>/Cases/<session_date>/recording_<ts>/` and drops MP3 + transcript there. DB row inserted with `patient_name=NULL` (or the generic literal the scribe typed).
2. `spawnSoapGeneration` invokes the skill with `cwd = <NOTES_DIR>`, pointing at the transcript.
3. Skill detects multiple patients. **For each patient, writes `<sanitised_patient_name>_soap_note.md` directly into the recording folder.** No sub-folders, no copies.
4. Skill emits JSON manifest: `multi_patient: true`, `recording_folder = <abs path>`, N entries in `cases[]` with each patient's name + `.md` path.
5. `main.js` parses the manifest. Multi-patient branch:
   - For each entry in `cases[]`:
     a. Sanitise `patient_name` → folder slug (existing convention).
     b. Resolve target folder `<session_folder>/<patient_slug>/`. Handle duplicates by appending `_2`, `_3`, etc.
     c. `mkdir` the new patient folder.
     d. Copy MP3 + transcript.md (+ transcript.docx if present) from recording_folder → new patient folder.
     e. **Copy** the `.md` SOAP note from recording_folder → new patient folder. The original stays in the recording folder as part of the audit trail.
     f. Call `spawnDocxConversion` on the copied `.md` in the patient folder.
     g. Hide `.md` files on Windows (both in the new patient folder and, if not already, in the recording folder).
     h. Insert a new child row in `cases` table — same `session_id`, same `doctor_id`, own paths, `status='completed'`.
   - Update the parent (recording) `cases` row: `status='completed'`, `soap_note_path` stays NULL. The parent row remains as the audit record for "this audio came in and was split into N patients." The recording folder retains the original MP3, transcript, and **all N SOAP `.md` files** the skill wrote — nothing is removed.

End result: each patient gets a proper case folder next to the recording folder, identical in shape to a single-patient case. The recording folder stays put as a complete audit artefact (audio, transcript, all SOAP markdowns the skill produced). Nothing auto-deletes, nothing gets moved out.

### File layout after a 3-patient split

```
Cases/2026-05-22/
  recording_2026-05-22_14-33-10/      ← parent, audit only — retains EVERYTHING the skill wrote
    recording.mp3
    transcript.md
    transcript.docx
    jane_doe_soap_note.md              ← retained (audit copy)
    john_smith_soap_note.md            ← retained (audit copy)
    maria_garcia_soap_note.md          ← retained (audit copy)
    (no .docx for SOAP notes here — docx only lives in the patient folders)
  jane_doe/                            ← child 1
    recording.mp3                      ← copy
    transcript.md                      ← copy
    transcript.docx                    ← copy
    jane_doe_soap_note.md              ← copy of the file from the recording folder
    jane_doe_soap_note.docx            ← generated by app from the copy
  john_smith/                          ← child 2
    ...
  maria_garcia/                        ← child 3
    ...
```

The four sibling folders all share the same `session_id` in the DB. The recording folder is preserved as a complete audit record — no files are moved out of it, and the SOAP `.md` files the skill wrote stay there alongside copies in each patient folder. On Windows, all `.md` files (in both the recording folder and the patient folders) are `attrib +h`-hidden; the user only sees `.mp3`, `transcript.docx`, and per-patient SOAP `.docx`.

---

## The JSON manifest contract

### Schema

```json
{
  "schema_version": 1,
  "skill": "generate-note",
  "status": "ok|partial|failed",
  "multi_patient": false,
  "summary": "<one-line human summary of what was produced>",
  "recording_folder": "<absolute path to the folder containing the audio, transcript, and all SOAP .md files>",
  "cases": [
    {
      "patient_name": "<patient name parsed from dictation, or null if unknown>",
      "doctor_lastname": "<lowercase lastname slug used for the template lookup>",
      "visit_type": "<exact label from the template's note type list, or null if the template only defines one type>",
      "chief_complaint": "<one-line chief complaint, or null>",
      "soap_note_md": "<absolute path to the .md file the skill wrote inside recording_folder>",
      "placeholders": [
        { "field": "<short snake_case name>", "reason": "<one-line why this couldn't be filled>" }
      ],
      "warnings": [
        { "code": "<snake_case_code>", "message": "<one-line message>", "severity": "info|warning|error" }
      ],
      "status": "ok|partial|failed"
    }
  ],
  "warnings": []
}
```

### Field semantics

| Field | Purpose | Notes |
|---|---|---|
| `schema_version` | Future-proofing | Always `1` in this PR. App tolerates only the version it knows. |
| `skill` | Which skill emitted this | Always `"generate-note"` for this skill. |
| `status` (top-level) | Worst case across `cases[]` + top-level `warnings[]` | `ok` = every case ok, no warnings; `partial` = some cases ok but at least one issue; `failed` = no usable output. |
| `multi_patient` | Explicit flag for the app to branch on | Could be inferred from `cases.length > 1`, but explicit reads cleanly in the skill prompt and the app. |
| `summary` | One-line human description for logs | Free string. Not parsed. |
| `recording_folder` | Where the audio + transcript live | Used by the app's multi-patient branch to know what to copy from. Single-patient: same as the parent case folder. |
| `cases[].patient_name` | Patient name | `null` if the skill genuinely couldn't extract one. The app's multi-patient branch falls back to `unknown_1`, `unknown_2`, etc. for folder names. |
| `cases[].doctor_lastname` | Echo of the lastname used for template lookup | Pure echo — the app already knows this from `start-session`. Included for traceability in logs. |
| `cases[].visit_type` | Template-defined note type | E.g. `pr2_follow_up`, `new_patient`, `private_followup`. Free string matching whatever the doctor's template defines. `null` if the template only has one type. Logged only — not written to DB. |
| `cases[].chief_complaint` | One-line CC | Useful in logs for grep + future UI. Not written to DB. |
| `cases[].soap_note_md` | Absolute path to the SOAP `.md` file the skill wrote inside the recording folder | App leaves it in place (single-patient: it's already in the patient's case folder). For multi-patient: app **copies** it into the new per-patient folder, then converts the copy to docx; the original stays in the recording folder as audit. |
| `cases[].placeholders` | Missing fields the skill could not fill | Structured array. Logged only; not written to DB. Future UI may use this. |
| `cases[].warnings` | Skill-emitted issues with this case | Structured array. Logged only. |
| `cases[].status` | Per-case status | `ok` / `partial` / `failed`. App skips post-processing for `failed` cases. |
| `warnings` (top-level) | Run-level issues not tied to a single case | E.g. "transcript truncated", "doctor template was missing optional section". Logged only. |

### Output rules (in `SKILL.md`)

The skill instruction must explicitly state:

1. Emit valid JSON matching this schema on **a single line** as the **last line** of output.
2. No markdown code fences (no ` ```json ` ... ` ``` `).
3. No prose after the JSON line.
4. All paths absolute, using the OS path separator the skill is running on.
5. If something goes wrong such that no SOAP could be written: emit a JSON manifest with `status: "failed"`, empty `cases[]`, and a top-level `warnings[]` describing the failure. **Never** silently exit without a manifest.

All friendly prose (chief complaint summary, placeholders to fill in, narrative confirmation of what was generated) can still be emitted — but **before** the manifest line, not after. That prose lands in `app.log` via the existing stdout pipe.

---

## Changes per file

### `notes-claude/skills/generate-note/SKILL.md`

**Step 4 — Detect Multiple Patients:** rewrite.

- Keep the detection logic (look for multiple patients in the transcript).
- **Remove** the sub-folder creation block.
- **Remove** the MP3/transcript copy logic.
- Replace with: "If multiple patients detected, write one `.md` file per patient into `${CASE_DIR}` using the pattern `<sanitised_patient_name>_soap_note.md`. Do not create sub-folders. The app handles per-patient folder creation."

**Step 6 — Save the SOAP Note:** rewrite.

- Keep: writing `.md` files into `${CASE_DIR}`.
- **Remove** the entire "Generate DOCX" sub-section (the `pandoc` / `python-docx` block in lines ~253–293 of current `SKILL.md`).
- The skill no longer touches `.docx` at all.

**Step 7 — Confirm Completion:** rewrite.

- Keep the human-readable summary prose for the operator (chief complaint, primary assessment, etc.) — that's useful in logs.
- **Add** at the very end: emit the JSON manifest as the final line. Specify the full schema inline so the model has it in context. Include 2–3 worked examples (single-patient ok, multi-patient ok, single-patient partial with placeholders).

**Filename convention for multi-patient SOAPs:**

Use the same `sanitise(patient_name)` pattern the app uses for folders (replace spaces with underscores, strip `/\:`, lowercase). Skill emits the exact path it wrote so the app doesn't have to re-derive — but consistency helps debuggability.

If two patients in one transcript have the same name, the skill appends `_2`, `_3`, etc. to the filename. The app sees these in `cases[]` and handles them as-is — no folder duplicate logic needed beyond what's already there for cross-session conflicts.

### `main.js`

**`spawnSoapGeneration` close handler:**

1. Capture stdout, scan for the last non-empty line.
2. Parse that line as JSON via a defensive helper (see `parseSkillManifest()` below).
3. If parse fails or `status: "failed"`:
   - Log the failure.
   - Update the existing `cases` row to `status='failed'`, write error to `processing_events`.
   - Surface the existing setup/service-warning IPC if the error pattern matches a known one (Claude usage limit, etc.).
   - Stop — no docx, no splitting.
4. If `multi_patient: false`:
   - Verify `cases[0].soap_note_md` exists on disk.
   - Call `spawnDocxConversion(soap_note_md)`.
   - On docx success: hide `.md` (Windows), update the existing `cases` row with `soap_note_path`, `soap_docx_path`, `status='completed'`, `completed_at`.
5. If `multi_patient: true`:
   - For each entry in `cases[]` with `status: "ok"` or `"partial"`:
     a. `slug = sanitisePatientName(patient_name) || 'unknown_' + (index + 1)`
     b. Resolve target folder `<session_folder>/<slug>/`. If it exists, append `_2`, `_3`, ... until free.
     c. `mkdirSync(target)`.
     d. Copy MP3, `transcript.md`, `transcript.docx` from `recording_folder` → target. Use `fs.copyFileSync`; tolerate missing transcript.docx (may not have been generated yet — but at this point it should exist since the docx-of-transcript step runs after transcription).
     e. **Copy** `soap_note_md` from recording_folder → target. Use `fs.copyFileSync` — do **not** move/rename. The original `.md` stays in the recording folder as part of the audit trail.
     f. Call `spawnDocxConversion(target/<basename of copied .md>)`.
     g. On docx success: hide `.md` files in target (Windows). Also ensure the original `.md` in the recording folder is hidden — if `hideExistingCaseMdFiles` already ran on the recording folder, this is a no-op; if not, call `hideFileFromUser` on each `cases[].soap_note_md` path explicitly.
     h. Insert a new row in `cases` table:
        - `id` = new UUID
        - `session_id` = parent's session_id
        - `doctor_id` = parent's doctor_id
        - `case_dir` = absolute path to target
        - `source` = `'recording'`
        - `mp3_path` = target/recording.mp3
        - `transcript_path` = target/transcript.md
        - `transcript_docx_path` = target/transcript.docx
        - `soap_note_path` = target/...soap_note.md
        - `soap_docx_path` = target/...soap_note.docx
        - `status` = `'completed'`
        - `recorded_at` = parent's recorded_at (same audio source)
        - `completed_at` = now
   - For entries with `status: "failed"`: log + skip + no folder created.
   - After loop: update the parent (recording) `cases` row to `status='completed'`. Leave `soap_note_path=NULL` on the parent — it's an audit row, not a real chart.
6. Status-window updates (`recording-status-update` IPC):
   - Single-patient: same as today, just no fan-out.
   - Multi-patient: emit one "converting" stage that completes when all per-patient docx + DB writes are done. Don't enumerate per-patient sub-events — keeps the UI simple.

**New helper: `parseSkillManifest(stdout)`** (top of main.js or its own small module):

Layered defensive parser. Order:

1. Take the last non-empty trimmed line of stdout.
2. Direct `JSON.parse` — succeeds 95%+ of the time with Claude 4.6/4.7.
3. Strip ```` ```json ```` / ```` ``` ```` fences if present, retry parse.
4. Brace-balance scan from the rightmost `}` walking left looking for a balanced `{...}` block; try parsing each candidate.
5. If all fail: return `null` and log a warning.

Caller treats `null` as "parse failed → fall back to status='failed' behaviour."

Direct port of the Python pattern the user already uses for Gemini outputs (`extract_json_from_response`).

**File hiding:**

Existing `hideExistingCaseMdFiles()` walks case folders recursively. Verify it walks into newly-created patient folders too. If not, call it explicitly after each new folder's files are in place.

**`spawnDocxConversion`:** no changes. Already takes one `.md` path, returns when done.

### `notes-claude/skills/generate-note/SKILL.md` — manifest examples in-skill

Embed three worked examples directly in the skill so the model has them in context:

**Example 1 — single patient, all good:**
```json
{"schema_version":1,"skill":"generate-note","status":"ok","multi_patient":false,"summary":"Generated SOAP note for Jane Doe (Dr. Sabbag PR-2 follow-up).","recording_folder":"/abs/path/Cases/2026-05-22/jane_doe","cases":[{"patient_name":"Jane Doe","doctor_lastname":"sabbag","visit_type":"pr2_follow_up","chief_complaint":"Left wrist pain s/p ORIF","soap_note_md":"/abs/path/Cases/2026-05-22/jane_doe/jane_doe_soap_note.md","placeholders":[],"warnings":[],"status":"ok"}],"warnings":[]}
```

**Example 2 — multi-patient:**
```json
{"schema_version":1,"skill":"generate-note","status":"ok","multi_patient":true,"summary":"Generated 3 SOAP notes from a multi-patient recording.","recording_folder":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10","cases":[{"patient_name":"Jane Doe","doctor_lastname":"spencer","visit_type":"follow_up","chief_complaint":"...","soap_note_md":"/abs/path/.../jane_doe_soap_note.md","placeholders":[],"warnings":[],"status":"ok"},{"patient_name":"John Smith","doctor_lastname":"spencer","visit_type":"new_patient","chief_complaint":"...","soap_note_md":"/abs/path/.../john_smith_soap_note.md","placeholders":[],"warnings":[],"status":"ok"},{"patient_name":"Maria Garcia","doctor_lastname":"spencer","visit_type":"follow_up","chief_complaint":"...","soap_note_md":"/abs/path/.../maria_garcia_soap_note.md","placeholders":[],"warnings":[],"status":"ok"}],"warnings":[]}
```

**Example 3 — single patient, partial (placeholders + warning):**
```json
{"schema_version":1,"skill":"generate-note","status":"partial","multi_patient":false,"summary":"Generated SOAP note with 4 placeholders pending scribe fill-in.","recording_folder":"/abs/path/Cases/2026-05-22/jane_doe","cases":[{"patient_name":"Jane Doe","doctor_lastname":"sabbag","visit_type":"pr2_follow_up","chief_complaint":"Left wrist pain s/p ORIF","soap_note_md":"/abs/path/.../jane_doe_soap_note.md","placeholders":[{"field":"carrier_name_and_address","reason":"WC carrier info missing from transcript"},{"field":"prior_visit_date","reason":"PMHx reference"},{"field":"scribe_name","reason":"boilerplate"},{"field":"los_billing_paragraph","reason":"99215 dot phrase .KS15 — not dictated"}],"warnings":[],"status":"partial"}],"warnings":[]}
```

### `python/md_to_docx.py`

No changes anticipated. The app calls it once per `.md` file.

### Other skills

No changes in this PR. Listed in "Future work" below.

---

## Database integration

**No schema changes.** All manifest data the app writes to the DB lands in columns that already exist per the SQLite plan (`docs/archive/plans/2026-05-15-rs-sqlite-state-store.md`).

### Single-patient flow — existing row update

The `cases` row was inserted by `buildCaseFolder()` at recording stop. The SOAP step updates:
- `status` → `completed` (or `failed`)
- `soap_note_path` → `cases[0].soap_note_md`
- `soap_docx_path` → after docx conversion
- `completed_at` → after docx

Nothing new.

### Multi-patient flow — parent + N child rows

Parent row (recording folder) was inserted at recording stop with `patient_name=NULL` or whatever the scribe typed. After the skill emits the manifest, the multi-patient branch:

- Inserts N new child rows, one per `cases[]` entry. Each child:
  - Own UUID
  - `session_id` = parent's session_id
  - `doctor_id` = parent's doctor_id
  - `case_dir` = newly created patient folder absolute path
  - `mp3_path`, `transcript_path`, `transcript_docx_path`, `soap_note_path`, `soap_docx_path` all pointing into the new patient folder
  - `source` = `'recording'`
  - `recorded_at` = parent's `recorded_at` (same audio source)
  - `revision` = 1
  - `completed_at` = now
  - `patient_name` = the skill-extracted name (sanitised version of the slug, or the raw name with whatever sanitisation rules the app already uses for display)
- Updates the parent row: `status='completed'`, `soap_note_path` stays NULL, `completed_at` set.

The DB plan's note on this pattern (line 129):

> When the soap step produces multiple patient subfolders, each subfolder becomes its own row in `cases`, sharing the parent's `session_id`. The parent recording case can be marked `status='completed'` with `soap_note_path=null`; the children carry the actual note paths.

This plan implements exactly that.

### `processing_events`

The single `processing_events` row for the SOAP `spawnSoapGeneration` job stays attached to the parent (recording) `cases.id` — there's only one Claude invocation, one set of token costs. Don't create separate event rows per child case for the same skill run.

If a future per-child docx conversion is also tracked as a processing event, it gets its own row with `case_id` pointing to the child. Today docx is its own event row already; keeping that pattern means each child gets one `docx` event row.

### Fields NOT written to the DB

Logged to `app.log` only, never persisted in DB:
- `visit_type`
- `chief_complaint`
- `placeholders[]`
- `warnings[]` (top-level + per-case)
- `summary`

These all flow through the parsed-manifest JS object in memory and end up in `app.log` (the full manifest is logged once after parsing). Adding columns for these later if and when UI surfaces are built is a one-line migration; removing columns is hard. We don't pre-allocate space we won't use today.

---

## Edge cases + safety

| Case | Behaviour |
|---|---|
| Skill emits no JSON line | `parseSkillManifest` returns `null`. App treats as `status='failed'`, logs, updates `cases` row to failed, no docx, no splitting. |
| Skill emits malformed JSON (extra prose after, fences, etc.) | Defensive parser strips fences, brace-balance scan picks out the JSON block. If still fails: treat as no JSON. |
| Manifest claims a file path that doesn't exist | App logs the discrepancy, treats that case as failed, skips it. Other cases in the manifest still process. |
| Skill detects multi-patient but only one is real (false positive) | `cases[]` has 1 entry, `multi_patient: true`. App can run the multi-patient branch with N=1 — creates one new folder and copies the file. Cosmetically suboptimal but functional. Alternatively the app can short-circuit if `cases.length === 1 && multi_patient` — treat as single-patient. Recommend: trust the flag. If the skill said multi, do the split. |
| Skill detects single-patient but transcript was actually multi (false negative) | One `.md` gets written for one patient, app processes normally. The lost patients are a content problem, not a structural one. Same failure mode as today. |
| Patient name has characters that break the filename | Skill is responsible for sanitising before writing. App also re-sanitises on its side when creating folders, so a stricter sanitiser on the app side wins. Match the existing app sanitisation conventions. |
| Duplicate patient names in one transcript | Skill appends `_2`, `_3` to the `.md` filename. App sees those exact paths in `cases[]` and uses them. Folder naming on the app side handles its own duplicate suffix independently (so if `jane_doe` already exists under this session for unrelated reasons, the app makes `jane_doe_2`). |
| Recording folder is gone when app tries to copy files (extreme edge) | Log + skip + mark cases failed. Shouldn't happen — the app holds onto that path through the whole pipeline. |
| App is killed mid-split | Recording folder still has all SOAP `.md` files. On next launch, no auto-recovery in v1 — the user sees the recording folder with the SOAPs in it and can rerun the post-process manually (future "resume failed split" feature). Out of scope for this PR. |
| Skill writes a `.md` with `status='failed'` but writes a partial file anyway | App skips that case (does not docx, does not create folder, does not insert row). The orphan `.md` stays in the recording folder for debugging. Manual cleanup. |
| Docx conversion fails for one of N patients | That child's row is inserted with `soap_docx_path=NULL`, status stays `completed` (the SOAP `.md` is there). User sees the `.md` but no docx. Same as today's single-patient docx failure behaviour. |
| Pre-chart edit run on a multi-patient child case | Already supported — pre-chart points at a case folder; the child folder looks identical to a single-patient case folder. No new behaviour needed. |

---

## Documentation updates (in the implementation PR, not this plan)

- **`CLAUDE.md` "Don't touch" §4 — Skill prompt signatures**:
  - Update `generate-note` entry to specify the JSON manifest output contract on the last line of output.
  - Note that pre-final-line stdout can be free prose (logged to `app.log`).

- **`CLAUDE.md` "Recording pipeline" section**:
  - Step 7 currently says "On SOAP write: `spawnDocxConversion` → `.docx` of both transcript and SOAP note." Expand to describe: SOAP skill emits manifest; if multi-patient, app splits before docx; docx runs per resulting `.md`.

- **`docs/ARCHITECTURE.md`**:
  - Update the recording pipeline diagram/sequence.
  - Add a "Multi-patient split" subsection explaining the recording folder → child folders flow.
  - Add a "Skill manifest contract" subsection describing the JSON shape and parser helper.

- **`docs/DECISIONS.md`** — append entry, dated, initials:
  > **`generate-note` skill emits structured JSON manifest; app owns multi-patient folder splits + all docx.** Skill writes all `.md` outputs into the recording folder it was given and declares them in a JSON manifest as its final stdout line. App parses the manifest, then for multi-patient runs creates per-patient folders, copies files into them (recording folder retains everything as audit trail), converts docx, hides `.md`, inserts child `cases` rows. Removes folder manipulation, file copying, and inline docx from the skill. No DB schema changes — uses existing columns; non-DB manifest fields (visit_type, chief_complaint, placeholders, warnings, summary) live in the parsed object and are logged to `app.log`.

---

## Rollout

Single PR. Skill change + main.js change land together. No feature flag.

Reason: the current skill's inline docx step and sub-folder creation only fire on multi-patient runs. If main.js shipped the manifest parser first without the skill change, single-patient runs would still work; multi-patient runs would crash trying to parse a `NOTES_OK:`-style line as JSON. If the skill shipped first without main.js, multi-patient runs would leave `.md` files in the recording folder with no docx and no DB rows.

So: one PR, dev-tested (per the "Dev test checklist" section) before merging into `develop`. The implementation chat ships the PR with the checklist embedded in the PR description; the dev works through it on macOS and (where the item requires it) Windows.

### Auto-update consideration

User installs auto-update via `git pull` (per `CLAUDE.md` "Auto-update" section). Both files (`SKILL.md` and `main.js`) are in the same repo, same commit. They land together on the user's machine in one update cycle. No version skew.

---

## Dev test checklist

This is an Electron app with audio recording, Claude Code subprocess invocation, and a system tray — it cannot be tested in a headless agent environment. **The implementation chat does not run these tests.** It writes the code, the docs, and pastes this checklist into the PR description so the dev (running on a real desktop session) can work through it after the PR is open.

The dev primarily runs macOS; Windows-specific items (file hiding) need a Windows install to verify and should be flagged in the PR description as "awaiting Windows pass."

- [ ] **Single-patient happy path** *(macOS or Windows)*. Start session, record short clip, type patient name, wait for pipeline. Verify: one `.md` and one `.docx` in the case folder. `app.log` shows the JSON manifest line at the end of the skill output. DB `cases` row has `status='completed'`, all paths set. No regression vs today.

- [ ] **Multi-patient happy path** *(macOS or Windows)*. Use a known multi-patient transcript (Spencer 5-patient recording in test fixtures, or record one). Start session, record, leave patient name blank. Verify:
  - **Recording folder retains EVERYTHING the skill wrote** — MP3, transcript.md, transcript.docx, and N SOAP `.md` files (one per detected patient). Nothing is moved out.
  - N new patient folders exist next to the recording folder under the same session date folder.
  - Each patient folder has: MP3 copy, transcript.md copy, transcript.docx copy, `<patient>_soap_note.md` (copy of the one from the recording folder), `<patient>_soap_note.docx` (generated by the app).
  - DB shows 1 parent row (recording) + N child rows. All share the same `session_id`.
  - Parent row `status='completed'`, `soap_note_path=NULL`.
  - Each child row has all paths populated, `status='completed'`.

- [ ] **Windows file hiding** *(Windows only)*. After both single- and multi-patient runs, browse the folders in Explorer:
  - In every case folder and the recording folder: `.md` files are hidden (only `.docx` and `.mp3` are visible to default Explorer settings).
  - `<NOTES_DIR>` shows only `Cases/` and no `app.db`, `.template_job.json`, or other internals.

- [ ] **Skill manifest parsing — direct invocation** *(macOS or Windows)*. Run `claude -p "generate a note using template X and transcript Y"` manually from the workspace, capture stdout. Verify: last line is valid JSON matching the schema. Prior lines can be any prose. Run the JSON through `python3 -m json.tool` to confirm validity.

- [ ] **Manifest parser defence** *(automatable by implementation chat with a unit-style script)*. Confirm `parseSkillManifest` handles: clean JSON, JSON wrapped in ```` ```json ``` ```` fences, JSON with trailing prose, malformed input (returns null without throwing). This one is the only test the implementation chat CAN run statically; everything else needs the real pipeline.

- [ ] **Failure path — no JSON** *(macOS or Windows)*. Modify the skill prompt temporarily to suppress the manifest line (or rename `SKILL.md` to break it). Run pipeline. Verify: app logs the parse failure, `cases` row goes to `status='failed'`, no docx attempted, no crash.

- [ ] **Failure path — `status: "failed"` manifest** *(macOS or Windows)*. Force the skill to emit a failed manifest (e.g. corrupt the transcript file so the skill can't generate). Verify: app marks the case failed, no docx, no splitting, no orphan files except the recording folder contents.

- [ ] **Multi-patient with one failed sub-case** *(macOS or Windows)*. Edit the skill output (or use a hand-crafted manifest fixture) so one of N cases has `status: "failed"`. Verify: N-1 patient folders created, 1 skipped, the orphan `.md` for the failed case stays in the recording folder for debugging, DB has N-1 child rows + 1 parent row.

- [ ] **Duplicate patient name across two multi-patient transcripts in same session** *(macOS or Windows)*. Run two multi-patient sessions on the same day, both containing a "Jane Doe". Verify second `jane_doe_2/` folder created cleanly, DB has both as separate rows.

- [ ] **Pre-chart on a multi-patient child** *(macOS or Windows)*. Pick one of the child cases in pre-chart, type instructions, run. Verify: that child's SOAP is regenerated and docx-converted; other children's folders untouched. The recording folder's audit `.md` for that patient stays as the *original* skill output (not the edited version) — pre-chart edits the child folder's copy, not the recording folder's copy.

- [ ] **App log content** *(macOS or Windows)*. After a multi-patient run, grep `app.log` for the manifest line. Verify: the full JSON is logged, including `placeholders`, `warnings`, `visit_type`, `chief_complaint`. (Smoke test that the non-DB fields aren't dropped.)

---

## Risks

1. **Defensive parser brittleness.** If Claude emits truly malformed JSON (rare with 4.6+ but not impossible), the parser layers handle most cases. If it still fails, the case goes to `failed` and the SOAP `.md` is still on disk in the recording folder. User can rename/move manually. **Mitigation:** ship the parser with the four layers from the start. Log raw stdout on parse failure for debugging.

2. **Sanitisation mismatch between skill and app.** Skill sanitises the patient name for the `.md` filename; app sanitises for the folder name. If the two differ, the app could end up creating `jane_doe/` while the skill wrote `Jane Doe_soap_note.md` — the copy still works because the manifest declares the exact path, but the filename inside the folder won't match the folder name. **Mitigation:** match the sanitisation rules. Document the rule in `SKILL.md` and apply the same in `main.js`. Test with a name containing spaces, apostrophes, hyphens.

3. **Recording folder still holds SOAPs after a crash.** If the app dies between skill completion and split, the recording folder has all the SOAP `.md` files but no patient folders. **Mitigation:** the `.md` files are durable; no data loss. Add a future "resume split" feature if this becomes a real ask. v1 ships without it.

4. **Disk usage of multi-patient case = 4× audio + 4× transcript.** For a 5-patient run, the app copies the audio + transcript into 5 sub-folders. Audio is the heavy part. **Mitigation:** acceptable for v1 — keeps each case folder self-contained (matches single-patient layout). Future option: hardlink instead of copy on filesystems that support it. Not in scope.

5. **Skill version skew on user installs.** Auto-update pulls both `SKILL.md` and `main.js` in one cycle, so the two are always in sync after restart. Until restart, the running app uses the old in-memory `main.js` against the old `SKILL.md` from the synced `.claude/`. Both old → works. After restart, both new → works. **No mitigation needed.**

6. **Test fixture availability.** Confirm a real multi-patient transcript fixture exists in the repo or test cases folder before the implementation PR starts. If not, the implementation chat needs to create one (use the Spencer 5-patient transcript previously discussed).

---

## Future work (NOT this PR)

Listed so the implementation chat knows what's queued:

- **Roll the JSON manifest format to other skills.** `cdi-review` already has a primitive `CDI_OK:` terminal line — upgrade to the same JSON schema (with `skill: "cdi-review"`). `edit-note` already emits `BACKUP_OK:` — same upgrade. `create-doctor-profile` and `update-doctor-profile` would emit JSON declaring template paths and backup paths. The `icd` skill on the `icd10-coding` branch should adopt this format before merging.

- **Surface placeholders in the UI.** Once placeholders are reliably structured in the manifest, the UI could show a "needs completion" badge on a case with `placeholders.length > 0`, or a side panel listing them. Not v1.

- **Resume failed split.** If the app crashes after skill completion but before all children are processed, a "resume" button on the recording folder could re-trigger the post-process from the existing manifest. Requires the manifest to be persisted somewhere (today it's only in `app.log`).

- **Hardlink instead of copy** for MP3 + transcript across sibling folders, on platforms that support it.

---

## Deliverables checklist

When implementing this plan, the PR must include:

- [ ] `notes-claude/skills/generate-note/SKILL.md` — Step 4 rewritten (no sub-folder creation), Step 6 rewritten (no inline docx), Step 7 rewritten (JSON manifest as last line, with full schema + 3 worked examples).
- [ ] `main.js` — `parseSkillManifest(stdout)` helper with layered defensive parsing.
- [ ] `main.js` — `spawnSoapGeneration` close handler rewritten: parse manifest, branch on `multi_patient`, single-patient path unchanged behaviour, multi-patient path creates folders + copies files into them (originals stay in recording folder) + spawns docx per copied `.md` + inserts child `cases` rows.
- [ ] `main.js` — verify `hideExistingCaseMdFiles()` walks into newly created patient folders, or call it explicitly per new folder.
- [ ] `main.js` — verify `spawnDocxConversion` handles being called multiple times in sequence without state collisions (it should — each call is independent).
- [ ] `CLAUDE.md` — update "Don't touch" §4 (generate-note signature + manifest contract) and the "Recording pipeline" section.
- [ ] `docs/ARCHITECTURE.md` — update recording pipeline sequence, add "Multi-patient split" + "Skill manifest contract" subsections.
- [ ] `docs/DECISIONS.md` — append entry per "Documentation updates" section above.
- [ ] PR description includes the full "Dev test checklist" section copy-pasted from above so the dev can work through it.
- [ ] PR description flags any items the implementation chat could not verify statically — call them out explicitly so the dev knows where to focus attention.
- [ ] PR description lists any assumptions the implementation chat had to make that aren't pinned in this plan.
- [ ] After dev sign-off + merge: `git mv` this plan into `docs/archive/plans/` and remove from `docs/plans/README.md` per the documentation conventions.

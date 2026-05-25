# Architecture

Pipeline, processes, and file flow for AI Medical Scribe. Sister doc to [CLAUDE.md](../CLAUDE.md) — this is the deeper view; CLAUDE.md is the quick reference.

---

## Process model

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron main process (main.js)                                 │
│   • Tray icon (left-click toggles main window)                  │
│   • Main window (full taskbar entry, close-to-minimize)         │
│   • Optional floating status window (multi-case progress)       │
│   • State machine                                               │
│   • IPC handlers                                                │
│   • Spawns and supervises all child processes                   │
│   • Single-instance lock                                        │
└────────────┬───────────────────────────────────┬────────────────┘
             │ contextBridge                     │ child_process.spawn
             │ (preload.js)                      │
             ▼                                   ▼
┌────────────────────────────┐    ┌─────────────────────────────────┐
│ Renderer (2 windows)       │    │ Children (one per task)         │
│   • renderer.js (main UI)  │    │   • python record.py            │
│   • status.js (mini status │    │   • python transcribe.py        │
│      window, opt-in)       │    │   • python md_to_docx.py        │
│   • Listens for state +    │    │   • python extract_attachments  │
│      event broadcasts      │    │   • claude -p (SOAP)            │
│                            │    │   • claude -p (template/update) │
│                            │    │   • claude -p (edit-note)       │
│                            │    │   • claude -p (add-icd-codes)   │
│                            │    │   • git pull (auto-update)      │
└────────────────────────────┘    └─────────────────────────────────┘
```

The renderer cannot touch Node, fs, or `child_process` — it must go through `window.api` (`preload.js`). Children are short-lived and unsupervised after spawn except `record.py`, which is held in `recordingProcess` and stopped via stdin.

Two BrowserWindows exist: the **main window** (`win`, 280×420, framed false, alwaysOnTop, full taskbar entry) and an optional **status window** (`statusWin`, 300×380, framed false, alwaysOnTop, `skipTaskbar: true`) the user can open to see per-case progress while the main window is closed/minimized. The status window receives a separate `recording-status-update` channel driven by `getSessionRecordings()`.

---

## Recording-pipeline sequence

```
User           Renderer            Main                Python              ElevenLabs       Claude CLI
 │               │                  │                   │                       │              │
 │ Start Rec ──▶ │ startRecording() │                   │                       │              │
 │               │ ──IPC──────────▶ │ spawn record.py ─▶│ open WAV in tmpdir    │              │
 │               │                  │ setState RECORDING│ stream audio frames   │              │
 │               │ ◀─state-change── │                   │                       │              │
 │               │ render timer     │                   │                       │              │
 │ Stop ───────▶ │ stopRecording()  │                   │                       │              │
 │               │ ──IPC──────────▶ │ stdin "stop\n" ──▶│ flush WAV, MP3 export │              │
 │               │                  │ await exit        │ exit 0                │              │
 │               │                  │ setState PROCESSING                       │              │
 │               │ ◀─show-patient-form                  │                       │              │
 │               │ open form        │                   │                       │              │
 │ Save name ──▶ │ submitPatientName│                   │                       │              │
 │               │ ──IPC──────────▶ │ resolve promise   │                       │              │
 │               │                  │ build case dir    │                       │              │
 │               │                  │ rename MP3 in     │                       │              │
 │               │                  │ spawn transcribe.py──▶ POST /v1/speech ──▶│              │
 │               │                  │ setState SESSION_ACTIVE  (UI freed!)      │              │
 │               │ ◀─state-change── │                                           │              │
 │               │                  │              ◀──── transcript JSON ───────│              │
 │               │                  │                   │ write transcript.md   │              │
 │               │                  │                   │ exit 0                │              │
 │               │                  │ on transcribe close: spawn claude -p ────────────────────▶│
 │               │                  │                   │                       │  generate-note
 │               │                  │                   │                       │  reads template
 │               │                  │                   │                       │  + transcript
 │               │                  │                   │                       │  writes one or more
 │               │                  │                   │                       │  _soap_note.md into
 │               │                  │                   │                       │  the case folder
 │               │                  │                   │                       │  ends response with
 │               │                  │                   │                       │  JSON manifest line
 │               │                  │ on claude close:                                          │
 │               │                  │   parseSkillManifest(resultText)                          │
 │               │                  │   per case folder (single=parent; multi=each child):      │
 │               │                  │     spawn claude -p "add ICD codes..." (add-icd-codes)    │
 │               │                  │       → appends ## ICD-10-CM Codes table to <case>.md     │
 │               │                  │       → best-effort; failure falls through to next step   │
 │               │                  │     spawn claude -p "review cdi..." (cdi-review)          │
 │               │                  │       → produces <case>_cdi.json + <case>_cdi.md          │
 │               │                  │       → writes cdi_* columns + cdi_flags rows             │
 │               │                  │       → SKIPPED if enableCdi=false (no spawn) or no       │
 │               │                  │         specialty (skill emits CDI_SKIPPED cleanly)       │
 │               │                  │       → best-effort; failure falls through to docx        │
 │               │                  │     spawn md_to_docx.py on the now-coded soap .md         │
 │               │                  │     spawn md_to_docx.py on cdi .md (if CDI succeeded)     │
 │               │                  │   if  multi_patient: per cases[] entry —                  │
 │               │                  │     mkdir <slug>_<YYYY-MM-DD>/,                           │
 │               │                  │     copy mp3 + transcript + transcript.docx + soap.md in, │
 │               │                  │     insert child cases row,                               │
 │               │                  │     await ICD then CDI on child (sequential across kids), │
 │               │                  │     spawn md_to_docx.py on the now-coded child soap .md,  │
 │               │                  │     spawn md_to_docx.py on cdi .md (if CDI succeeded),    │
 │               │                  │     hide audit .md in recording folder (Windows)          │
 │               │                  │   mark parent row completed (soap_note_path=NULL on multi)│
 │               │                  │   (audit folder is never ICD-coded, CDI-reviewed, or      │
 │               │                  │    docx-converted)                                        │
```

Key properties:
- **Non-blocking**: state returns to `SESSION_ACTIVE` *before* transcription completes. The scribe can start the next case while the pipeline runs.
- **Detached subtree**: transcribe → soap → docx is a chain, not a supervisor tree. Each child only listens for its predecessor's `close` event.
- **Single log stream**: every child's stdout/stderr is captured by the main process and written to `<NOTES_DIR>/app.log` with a `[<case>]` tag, so the whole pipeline is reconstructable from one file.
- **Skill is a pure note generator.** The `generate-note` skill writes `.md` files and declares them in a JSON manifest; it does not create sub-folders, copy files, or convert DOCX. All file shuffling and DOCX is owned by `main.js` after the manifest is parsed. See *Skill manifest contract* and *Multi-patient split* below.

### Skill manifest contract

The `generate-note` skill ends its final assistant response with a **single line of valid JSON** describing what it produced. The line is the **last** thing in the response — any chief-complaint prose, narrative confirmation, etc. appears before it. `main.js` consumes the manifest via `parseSkillManifest()` (in [parseSkillManifest.js](../parseSkillManifest.js)). Schema lives in [notes-claude/skills/generate-note/SKILL.md](../notes-claude/skills/generate-note/SKILL.md) Step 7; the load-bearing fields are:

| Field | Used by app for |
|---|---|
| `schema_version` | Version gate. v1 only; future versions fail closed until app catches up. |
| `status` | `failed` → mark case failed, no docx, no split. |
| `multi_patient` | Branch decision: single vs multi-patient post-processing. |
| `recording_folder` | Diagnostic only — the app uses `dirname(soap_note_md)` as authoritative. |
| `cases[].soap_note_md` | Absolute path the skill claims to have written. App verifies on disk before docx/copy. |
| `cases[].patient_name` | Source of the child folder slug (sanitised app-side). `null` falls back to `unknown_<n>`. |
| `cases[].status` | Per-case gate — `failed` skips that case's post-processing. |

Non-DB fields (`visit_type`, `chief_complaint`, `placeholders`, `warnings`, `summary`) are logged once to `app.log` via the parsed manifest object — never persisted to `app.db`. Adding columns later for any of these is a one-line migration; preallocating is not.

The parser is layered defensive: (1) last non-empty line, direct `JSON.parse`; (2) strip ```` ```json ```` / ```` ``` ```` fences; (3) brace-balance scan from the rightmost `}` walking left for a matching `{`. On total failure: returns `null`; caller marks the run failed and logs the trailing stdout for debugging. Unit-tested via [tests/parseSkillManifest.test.js](../tests/parseSkillManifest.test.js) — run with `node tests/parseSkillManifest.test.js`.

### Multi-patient split

When the manifest sets `multi_patient: true`, the parent recording folder becomes an audit folder and the app fans out per-patient child folders next to it:

```
Cases/2026-05-22/
  recording_2026-05-22_14-33-10/      ← audit folder (parent cases row, soap_note_path=NULL)
    recording.mp3
    transcript.md
    transcript.docx
    jane_doe_soap_note.md              ← retained (audit, .md hidden on Windows)
    john_smith_soap_note.md
    maria_garcia_soap_note.md
  jane_doe_2026-05-22/                  ← child (own cases row, same session_id as parent)
    jane_doe.mp3                       ← copy of parent's MP3 renamed to single-patient convention
    transcript.md                       ← copy
    transcript.docx                     ← copy
    jane_doe_2026-05-22_soap_note.md   ← copy of the audit .md, renamed to single-patient convention
    jane_doe_2026-05-22_soap_note.docx ← generated by app
  john_smith_2026-05-22/
    ...
  maria_garcia_2026-05-22/
    ...
```

Properties:
- **Child folders are indistinguishable from single-patient cases on disk.** Pre-chart, the file picker, recent-cases listings, DB queries — none of them have to special-case multi-patient children.
- **Recording folder retains everything the skill wrote.** No files are moved out, only copied. The audit `.md` files stay in the recording folder (hidden on Windows) alongside the original MP3 and transcript.
- **DB shape: 1 parent row + N child rows, all sharing `session_id` and `doctor_id`.** Parent has `soap_note_path=NULL`, `status='completed'`. Each child has all paths populated and progresses `converting → completed` via the existing docx success path. Children are inserted by `db/cases.js → createChildCase` (a separate helper from `createCase` since children skip the `transcribing` → `generating_note` stages).
- **`processing_events` for the SOAP step stays attached to the parent's `case_id`.** Only one Claude invocation, only one usage event. Each child docx run gets its own `docx` event row with `case_id` pointing to the child.
- **`processing_events` for the ICD step is per child.** Each child's ICD invocation gets its own `icd` event row with `case_id` pointing to the child — never the parent. The audit folder is not ICD-coded, so the parent gets zero `icd` events.
- **`session.case_count` counts children, not recordings.** A 5-patient recording bumps `case_count` by 5 because `bumpSessionCounters` fires per docx-success and docx runs once per child. Parent (audit) rows never docx so they never bump the counter. Pre-existing develop behavior.
- **`audio_duration` and `audio_size_bytes` live only on the parent row.** Children inherit nothing audio-specific — one audio file is shared across all patients in the recording. The child's `mp3_path` points to the per-child *copy* of that audio.
- **Per-patient cost attribution for SOAP is intrinsically not separable.** One Claude invocation generates content for all patients, so SOAP cost lives on the audit row only. Per-child queries see ICD + docx costs only. Per-session totals (joining through `case_id` → `cases.session_id`) include the SOAP cost via the parent row.
- **No cleanup or "resume" logic in v1.** If the app crashes between skill exit and split completion, the recording folder is durable; the user can re-process manually. A future "resume split" feature could re-read the manifest from `app.log`.

### Per-case post-processing chain (ICD → CDI → docx)

Both single-patient and multi-patient cases run the same per-case post-processing chain after the SOAP `.md` is in its final on-disk location:

1. **`spawnIcdCoding(soapNoteMdPath, …)`** invokes the `add-icd-codes` skill (`claude -p "add ICD codes. Soap note: <rel-path>."`). The skill reads the SOAP `.md`, extracts diagnoses, looks them up via the claude.ai ICD-10 MCP connector, and appends an `## ICD-10-CM Codes` table at the end of the file. The function returns a Promise that resolves on completion (success OR failure — it never rejects). A `processing_events` row with `job_kind='icd'` is recorded with token usage, cost, duration, and status (`success` / `failed` / `rate_limited`). Status-popup label transitions through `coding_icd` while it runs.

2. **`spawnCdiReview({ caseDir, doctor, … })`** invokes the `cdi-review` skill (`claude -p "review cdi. Case: …. Specialty: …. Mode: …. Doctor: …. Standards: …"`). The skill validates the SOAP note against the standards packs in `<NOTES_DIR>/.claude/standards/`, produces `<case>_cdi.json` + `<case>_cdi.md` in the case folder, and emits a terminal-line contract (`CDI_OK:` / `CDI_SKIPPED:` / `CDI_FAIL:`) `main.js` greps for. On success, the summary fields land in the `cases.cdi_*` columns (via `dbCases.updateCaseCdi`) and the per-flag payload lands in `cdi_flags` (via `dbCdiFlags.insertFlags`). A `processing_events` row with `job_kind='cdi'` captures token usage. Status-popup label transitions through `running_cdi`. **Three gates short-circuit the spawn before Claude runs** — saves tokens + latency: (a) global `enableCdi` setting must be on; (b) `doctor.specialty` must be non-empty; (c) `<NOTES_DIR>/.claude/standards/specialties/<specialty>.md` must exist. When any gate fails, main.js writes the same stub `_cdi.{json,md}` the skill's Step 0b would have written and records `cdi_status='skipped'` — downstream shape is identical. The skill's Step 0b stays as a defensive backstop for direct `claude -p` invocations. **ICD-aware**: the skill notices any ICD codes already in the SOAP note (from step 1) and validates them, populating an optional `code_validation` block in the output JSON and appending ` · ICD validated` to its `CDI_OK:` line.

3. **`spawnDocxConversion(soapNoteMdPath, …)`** runs after the CDI promise resolves, generating the soap `.docx` from the now-coded `.md`. A second `spawnDocxConversion(cdiMdPath, …)` runs in parallel when CDI succeeded, generating the cdi `.docx`. The kind ('soap' / 'cdi' / 'transcript') is detected from the filename (`*_cdi.md` → 'cdi'); the close handler branches accordingly. Soap-docx success flips the case to `'completed'` (primary deliverable); cdi-docx success only populates `cdi_docx_path` and surfaces the Open CDI Review button in the popup.

Properties:
- **ICD + CDI are both best-effort.** Failure (MCP unreachable, model error, rate limit, network, skill bug) logs + emits a `service-warning` IPC + records the failure status on `processing_events`, but the chain always falls through to docx. A SOAP note without codes — or without a CDI review — is still useful.
- **ICD + CDI are per case folder, never on audit folders.** Single-patient runs them once on the parent's `.md`. Multi-patient runs them once per child folder's `.md`. The recording (audit) folder retains the SOAP `.md` files the skill wrote — never appended to, never CDI-reviewed, never converted to docx.
- **Sequential across children.** In multi-patient runs the per-child loop awaits each child's ICD then CDI before continuing to the next. This keeps MCP connector load + Anthropic rate-limit pressure + log-block readability sensible. Across-child parallelism is a future optimization.
- **CDI sequentially after ICD.** The ICD-aware behavior in `cdi-review/SKILL.md` Step 3 requires codes to already be in the note when CDI runs. Running ICD and CDI in parallel would make the validation behavior non-deterministic — sometimes CDI sees codes, sometimes not. Sequential is correct.
- **Pre-chart re-runs ICD only.** When `edit-note` rewrites a SOAP `.md`, the diagnoses may have changed — `spawnIcdCoding` re-runs before the docx refresh. CDI is **not** re-run automatically (v1.1 follow-up); the old `_cdi.{json,md,docx}` artifacts remain in the case folder.
- **All children visible in the status UI upfront.** `applyMultiPatientManifest` does a planning pass to compute every child's slug + folder + UI entry, calls `setRecordingPatients` once, then runs the processing pass. Each child starts in state `queued` (muted, static dot in the popup); the active one transitions to `coding_icd` → `running_cdi` → `converting` → `completed` (or `failed`) while siblings sit on `queued`. This decouples "show all patients" from "process them one at a time" — the per-child sequencing only affects work, not visibility.
- **CDI UI fields ride alongside the main status.** Each entry / patient carries `cdiStatus`, `cdiFlagCount`, `cdiQualityScore`, `cdiClinicianApprovalRequired`, `cdiDocxPath` independent of the main status state machine. The status popup uses these to render the "⚠ Review" badge (when approval required) and the Open CDI Review button (when `cdiDocxPath` is set). `broadcastRecordingStatus` and `get-session-recordings` spread the entry, so these fields flow to the renderer without a separate IPC channel.

---

## Template + Pre-chart pipelines

All three operations (template create, template update, pre-chart edit-note) share the same `templateJobProc` lock and `.template_job.json` persistence. The job object has a `type` field (`'create'`, `'update'`, or `'prechart'`) so the renderer banner shows the right text. Only one of these jobs can run at a time.

**Create:**
```
User           Renderer                Main                            Claude CLI (skill)
 │               │                      │                                │
 │ Templates tab │                      │                                │
 │ pick files,   │ startTemplateCreation│                                │
 │ enter name ──▶│ ──IPC──────────────▶ │ stage files into               │
 │               │                      │ <NOTES>/templates/_staging/<x>/│
 │               │                      │ broadcast {type:'create',      │
 │               │                      │            status: 'running'}  │
 │               │                      │ spawn claude -p ──────────────▶│ create-doctor-profile
 │               │                      │   --model opus-4-7             │   reads staging
 │               │ ◀─template-job-status│   effort=max                   │   analyses N notes
 │ banner shown  │                      │                                │   writes <lastname>.md
 │               │                      │ on close + file exists:        │
 │               │                      │   register doctor in settings  │
 │               │                      │   delete staging               │
 │               │                      │   broadcast {status: 'success'}│
 │               │ ◀─template-job-status│                                │
 │ banner ✓      │                      │                                │
```

**Update:**
```
User           Renderer                Main                            Claude CLI (skill)
 │               │                      │                                │
 │ pick doctor,  │ startTemplateUpdate  │                                │
 │ type fixes ──▶│ ──IPC──────────────▶ │ resolve templatePath           │
 │               │                      │   from settings.json           │
 │               │                      │ broadcast {type:'update',      │
 │               │                      │            status: 'running'}  │
 │               │                      │ spawn claude -p ──────────────▶│ update-doctor-profile
 │               │ ◀─template-job-status│                                │   verify file exists
 │ banner shown  │                      │                                │   backup → backups/
 │               │                      │                                │   read full template
 │               │                      │                                │   apply surgical edits
 │               │                      │                                │   write back in place
 │               │                      │ on close (code 0):             │
 │               │                      │   broadcast {status: 'success'}│
 │               │ ◀─template-job-status│                                │
 │ banner ✓      │                      │                                │
```

**Pre-chart (edit-note):**
```
User           Renderer                Main                            Claude CLI (skill)
 │               │                      │                                │
 │ Record tab    │                      │                                │
 │ click         │ showPrechartView()   │                                │
 │ Pre-chart     │ list recent cases    │                                │
 │ pick case,    │                      │                                │
 │ type instr,   │                      │                                │
 │ add files ──▶ │ startPrechartJob ──▶ │ resolve template from          │
 │               │                      │   *_soap_note.md "**Doctor:**" │
 │               │                      │ extract_attachments.py ──▶     │
 │               │                      │   write tmp combined.md        │
 │               │                      │ broadcast {type:'prechart',    │
 │               │                      │            status: 'running'}  │
 │               │                      │ spawn claude -p ──────────────▶│ edit-note
 │               │ ◀─template-job-status│   --model soapModel            │   backup soap note
 │ banner shown  │                      │   effort=high                  │   read template+note
 │               │                      │                                │   integrate attachment
 │               │                      │                                │   re-enforce template
 │               │                      │                                │   overwrite *_soap_note.md
 │               │                      │ on close (code 0):             │
 │               │                      │   delete tmp combined.md       │
 │               │                      │   spawnDocxConversion (soap)   │
 │               │                      │   broadcast {status: 'success'}│
 │               │ ◀─template-job-status│                                │
 │ banner ✓      │                      │                                │
```

The user picks 1+ files in the picker; `python/extract_attachments.py` concatenates their text (handling `.md`/`.txt` directly, `.docx` via python-docx, `.pdf` via pdfplumber→pypdf) into a single `prechart_<ts>.md` in OS temp. That single path is what the skill receives as `Attachment:` — the skill itself only ever processes one attachment, matching its existing contract.

`.template_job.json` ensures:
- popup can close/reopen and still see status
- one job at a time (`templateJobProc !== null` guard)
- stale `running` from a crash is cleared on next launch

---

## Audio-upload pipeline (alt path)

If the user uploads an existing audio file instead of recording:

1. `browse-audio-file` → file picker → user picks `.mp3/.wav/.m4a/.ogg/.flac/.mp4`
2. `process-audio-file(path, name)` → file copied into a new case folder (no record.py involved)
3. From there, identical pipeline: `spawnTranscription → spawnSoapGeneration → spawnDocxConversion`

This means `spawnTranscription` is the joining point of both flows. Don't bake recording-specific assumptions into it.

---

## Audio capture (record.py)

Single Python file, two platform branches selected by `sys.platform`.

| Platform | Library | Mechanism | Sample rate |
|---|---|---|---|
| Windows | `pyaudiowpatch` | WASAPI loopback on the default output device | Native (44.1 / 48 kHz), downsampled to 16 kHz on MP3 export |
| macOS   | `sounddevice` | Reads from BlackHole virtual device (must be installed and in a Multi-Output Device) | 48 kHz native |

Both branches:
- Write PCM frames into a WAV in a temp file as audio arrives
- Listen for `stop` / `pause` / `resume` lines on stdin (a thread reads stdin, sets events)
- On `stop`: flush the WAV, convert to MP3 via `pydub` (requires `ffmpeg` on PATH), delete WAV, exit 0
- On unexpected error: print `ERROR: ...` to stderr → main surfaces it as a setup-warning IPC

`--list-devices` mode prints JSON of the loopback / input devices and exits — used by the Settings advanced panel.

---

## Skills integration (the `notes-claude` → `<NOTES_DIR>/.claude` sync)

This is the most non-obvious part of the app.

```
repo/notes-claude/                       ← source of truth, version-controlled
  skills/
    generate-note/SKILL.md
    create-doctor-profile/SKILL.md
    update-doctor-profile/SKILL.md
  scripts/, draft/, settings.json
                  │
                  │  copyDirSync on every app start
                  ▼
~/Documents/AI Medical Notes/.claude/    ← runtime workspace for `claude -p`
  skills/...
```

When the app spawns `claude -p "..."`, the cwd is set to `<NOTES_DIR>` (the AI Medical Notes folder, not the repo). The `claude` CLI auto-discovers `<cwd>/.claude/` and loads the skills there.

Implications:
- Edit skills in `notes-claude/`, never in `<NOTES_DIR>/.claude/` — your edits will be overwritten on next launch.
- Adding a new skill = drop a folder into `notes-claude/skills/`. The next app launch copies it.
- The auto-update flow (`git pull`) re-syncs after pulling new code.

Prompt formats the skills expect:
- `generate-note`: `generate a note using template "<rel>" and transcript "<rel>"`  *(or omit template to fall back to doctor lookup)*
- `create-doctor-profile`: `create a doctor profile for "<name>" from source folder "<rel>"`
- `update-doctor-profile`: `update doctor profile. Doctor: <name>. Template: <abs-path>. Corrections: <text>`  *(path is absolute; multi-line corrections are collapsed to ` | ` separators)*
- `edit-note` (pre-chart): `edit note. Case: <abs-case-dir>. Template: <abs-template-path>. Attachment: <abs-attachment-path-or-empty>. Instructions: <scribe-text-or-empty>`  *(at least one of Attachment/Instructions must be non-empty; multi-file attachments are pre-combined by `extract_attachments.py`)*

The first two use paths relative to cwd (= `<NOTES_DIR>`). The update prompt uses an absolute path because the template path is already resolved in main.js before the prompt is built.

---

## File system layout (runtime)

```
<NOTES_DIR>/                                    e.g. ~/Documents/AI Medical Notes
├── settings.json                               app + user-editable (doctors[] migrated to app.db on first launch)
├── app.db                                      SQLite metadata store — doctors, sessions, cases, processing_events
├── app.db-wal / app.db-shm                     WAL journal (auto-managed; safe to delete when app is closed)
├── settings.doctors.backup.json                one-time backup of doctors[] at migration (hand-recovery only)
├── .template_job.json                          live + last-finished template job
├── app.log                                     append-only diagnostic log
├── .claude/                                    synced from repo notes-claude/
│   ├── skills/...
│   └── standards/                              cdi-review consumes these at runtime
├── .mcp.json                                   project-scope MCP config (ICD-10 connector)
├── Cases/
│   └── <patient>_<YYYY-MM-DD>/
│       ├── <patient>.mp3                       (or recording.mp3 if name skipped)
│       ├── transcript.md                       diarised, by speaker
│       ├── transcript.docx                     auto-converted
│       ├── <case>_soap_note.md                 SOAP note from skill (with ## ICD-10-CM Codes table appended)
│       ├── <case>_soap_note.docx               auto-converted (primary deliverable)
│       ├── <case>_cdi.json                     CDI review — canonical structured output (Windows: hidden)
│       ├── <case>_cdi.md                       CDI review — rendered from JSON (Windows: hidden)
│       └── <case>_cdi.docx                     CDI review — auto-converted (visible)
├── templates/
│   ├── <lastname>.md                           per-doctor template
│   ├── _staging/                               transient — used during AI template creation
│   └── backups/
│       └── <lastname>_backup_<YYYYMMDD_HHMMSS>.md   timestamped backup created before each AI update
└── (folder picked at install time wraps all the above)
```

```
<repo>/                                         the cloned source dir
├── .env                                        ELEVENLABS_API_KEY, NOTES_DIR_PATH
├── notes-claude/                               source of truth for skills
├── main.js, preload.js, renderer/, python/
└── docs/, CLAUDE.md, README.md
```

`NOTES_DIR_PATH` lives in repo `.env` so the user can move the notes folder without losing app state. `settings.json` lives **inside** notes-dir so it travels with the data.

---

## State machine details

States: `IDLE`, `SESSION_ACTIVE`, `RECORDING`, `PAUSED`, `PROCESSING`.

```
       ┌──────────────────────── stop-session ─────────────────────────┐
       │                                                               │
       ▼                                                               │
  ┌────────┐  start-session   ┌──────────────┐  start-recording   ┌──────────┐
  │  IDLE  │ ───────────────▶ │SESSION_ACTIVE│ ─────────────────▶ │RECORDING │
  └────────┘                  └──────────────┘                    └──────────┘
                                    ▲   ▲                            │  ▲
                                    │   │                       pause│  │resume
                                    │   │                            ▼  │
                                    │   │                          ┌─────────┐
                                    │   │                          │ PAUSED  │
                                    │   │                          └─────────┘
                                    │   │                            │
                                    │   │                            │ stop-recording
                                    │   │                            ▼
                                    │   │                       ┌────────────┐
                                    │   └─── (name resolved) ─── │ PROCESSING │
                                    │                            └────────────┘
                                    │
                                    └─ (also: discard, save-with-name, auto-record next)
```

`PROCESSING` is brief — it covers only the patient-name form. As soon as the user submits, the case folder is built, transcription is spawned, and state returns to `SESSION_ACTIVE`. The pipeline that follows is invisible to the state machine.

`PAUSED` reuses the same `recordingProcess` — `pause`/`resume` are stdin commands the Python side acts on (it stops appending frames to the WAV until resume). This is why a pause+resume gap doesn't show up in the recording.

Rendered identically in main.js and renderer.js — the renderer's `render(state)` switch decides which buttons are visible and what the indicator looks like.

---

## IPC and event channels

Source: [preload.js](../preload.js). Renderer → main are `invoke`/`handle`; main → renderer are `send`/`on`.

Renderer → main (request/response):
- Lifecycle: `start-session`, `stop-session`, `start-recording`, `stop-recording`, `pause-recording`, `resume-recording`, `discard-recording`, `submit-patient-name`
- Doctors: `get-doctors`, `add-doctor`, `update-doctor`, `update-doctor-template`, `remove-doctor`, `select-doctor`
- Templates tab (create): `browse-notes-files`, `start-template-creation`, `get-template-job-status`, `cancel-template-creation`, `dismiss-template-job`
- Templates tab (update): `start-template-update` (takes typed corrections + optional corrections file + optional extra sample notes), `browse-corrections-file`, `get-doctors-with-templates`
- Pre-chart: `browse-prechart-files`, `list-recent-patient-cases`, `browse-patient-case-folder`, `start-prechart-job` (status uses the shared `get-template-job-status` / `template-job-status` channel)
- Audio upload: `browse-audio-file`, `process-audio-file`
- Config: `get-state`, `get-config-status`, `get-elevenlabs-key`, `save-elevenlabs-key`, `get-settings`, `save-settings`, `list-audio-devices`, `get-notes-dir`, `change-notes-dir` (now accepts an optional mode)
- Status window: `get-session-recordings`, `open-status-window`, `close-status-window`
- Open output: `open-soap-note(filePath)` — opens the SOAP `.docx` in the OS default handler
- Window: `hide-window` (minimizes the main window)

Main → renderer (events):
- `state-change` — fires on every `setState`
- `show-patient-form` — fires inside `stop-recording` after the Python child exits
- `setup-warning` — BlackHole missing, Claude CLI missing, record.py errors
- `service-warning` — ElevenLabs API errors, Claude usage limits
- `auto-start-recording` — fired after `stop-recording` completes if `autoRecord` setting is on
- `pick-doctor` — fires on `start-session` if more than one doctor configured
- `template-job-status` — fires on every state change of a template-creation, template-update, or pre-chart job (carries `type` field)
- `recording-status-update` — drives the optional floating status window with per-case pipeline stage (recording → transcribing → soap → icd → docx → done)

---

## Single-instance and lifecycle

`app.requestSingleInstanceLock()` — second launches focus the existing window and exit.

**Close-to-minimize.** Clicking the window close button minimizes the window instead of quitting. Only the tray menu's "Quit" or `before-quit` actually exits. An `isQuitting` flag gates `win.on('close', …)` to decide whether to preventDefault.

**Quit path:** tray → Quit → `before-quit` handler sets `isQuitting = true`, kills `recordingProcess` so the temp WAV doesn't linger, and lets Electron tear down.

**macOS:** `app.dock?.hide()` keeps the dock icon hidden — the app still has a tray icon and a window, but it doesn't clutter the dock. (The window itself is normal — taskbar/dock behaviour differs from Windows where the window does appear in the taskbar.)

---

## Windows file hiding (`attrib +h`)

To keep the notes folder presentable to non-technical users on Windows, the app hides files the user doesn't need to see:

- **Inside `<NOTES_DIR>`** — every entry except `Cases/` is hidden (so `.claude/`, `.mcp.json`, `settings.json`, `app.log`, `.template_job.json`, and the `templates/` folder don't show by default).
- **Inside each case folder** — every `.md` file is hidden, leaving only the `.mp3` audio and the `.docx` finals visible. The `.md` files still exist (the skills read them) — they're just hidden from the user.

Helpers: `hideFileFromUser(path)`, `hideNotesDirInternals()`, `hideExistingCaseMdFiles()`. All no-op on non-Windows platforms. New `.md` files generated by the pipeline are hidden on write.

---

## Auto-update

`checkForUpdates()` runs on every launch ([main.js:538](../main.js#L538)):
1. `git pull --ff-only` in the repo working tree
2. If output is `Already up to date.` → done
3. Otherwise re-run the `notes-claude → <NOTES_DIR>/.claude` sync (so updated skills are immediately available)
4. Set tray tooltip + OS notification: "restart to apply"

Failures (no git, conflicts, network) are logged and ignored. The app never blocks on this.

The pull is branch-agnostic — whatever branch the clone is on. User installs (`install.ps1`) clone `main`; staging installs (`install-staging.ps1`) clone `staging` and write a local `.staging-marker` that flips the UI badge and prefixes tooltip / notification titles with `(staging)`. See CLAUDE.md → *Branching + release flow* for the promotion rules.

---

## DB schema overview

SQLite database at `<NOTES_DIR>/app.db`. WAL mode, `better-sqlite3` in main process. All writes are `try/catch` — a failed write never breaks the pipeline.

| Table | Key columns | Written by |
|---|---|---|
| `doctors` | `id` (preserves settings.json ids), `name`, `lastname`, `template_path`, `enable_cdi` | `db/doctors.js` — upserted by `add-doctor`, `update-doctor`, `update-doctor-template`, `spawnTemplateCreation` |
| `sessions` | `id` (UUID), `session_folder`, `doctor_id`, `started_at`, `ended_at`, `case_count`, `failed_count` | `db/sessions.js` — inserted by `start-session`, updated by `stop-session`; counters bumped when cases reach terminal status |
| `cases` | `id` (UUID), `case_dir` (UNIQUE), `status`, `revision`, file paths, audio metadata | `db/cases.js` — inserted in `stop-recording`/`process-audio-file`; updated at each pipeline stage |
| `processing_events` | `job_kind` (`transcribe`/`soap`/`icd`/`cdi`/`docx`/`prechart`/`template_create`/`template_update`), token columns, `cost_usd`, `duration_ms`, `backup_path` | `db/events.js` — `startEvent()` before each spawn, `finishEvent()` in close handler |
| `cdi_flags` | `case_id`, `cdi_run_id`, `flag_index`, `type`, `category`, `title`, `body`, `guideline_reference`, `current_code`, `suggested_codes` (JSON), `confidence`, `evidence_found` (JSON), `evidence_missing` (JSON) | `db/cdi_flags.js` — bulk-inserted by `spawnCdiReview` on `CDI_OK`. Attached to the case row that owns the SOAP it flagged (never to multi-patient parent rows). |

`cases.status` transitions: `transcribing → generating_note → converting → completed` (or `failed` at any stage). `cases.revision` starts at 1 and increments on each successful prechart. `processing_events.backup_path` is populated from the `BACKUP_OK: <path>` line printed by the edit-note skill.

Module layout: `db/init.js` (singleton + migrations + doctor migration), `db/doctors.js`, `db/sessions.js`, `db/cases.js`, `db/events.js`. `python/db_helper.py` is scaffolded for future Python workers (not used in v1).

## Cross-cutting: error surfacing

| Error class | Where detected | Surfaced as |
|---|---|---|
| BlackHole missing | startup probe + record.py stderr | `setup-warning` IPC → yellow banner |
| ffmpeg missing | startup probe (warn-only) | `app.log` only |
| Claude CLI missing (`ENOENT`) | spawn error in soap/template | `setup-warning` IPC |
| ElevenLabs key invalid (401) | regex on transcribe stderr | `service-warning` IPC → orange banner |
| ElevenLabs quota (429) | regex on transcribe stderr | `service-warning` IPC |
| Claude usage limit | regex on claude stdout/stderr | `service-warning` IPC |
| Recording process died unexpectedly | `record.py` exit handler with non-null `recordingProcess` | state recovers to `SESSION_ACTIVE` |
| Template job orphaned by crash | startup check on `.template_job.json` | rewritten as `failed` |
| ICD MCP not authenticated / 401 | regex on add-icd-codes stdout/stderr | `service-warning` IPC (best-effort — pipeline still falls through to CDI and DOCX) |
| CDI skill non-zero exit / no terminal line | `spawnCdiReview` close-handler | `service-warning` IPC ("CDI review failed"); `cdi_status='failed'`; pipeline still falls through to DOCX |
| CDI rate-limited (Claude usage limit) | regex on cdi-review stdout/stderr | `service-warning` IPC ("Claude usage limit reached") |
| CDI specialty unsupported / NULL | skill emits `CDI_SKIPPED:` terminal line | `cdi_status='skipped'`; popup shows the skip reason; no warning IPC (not an error condition) |

Adding a new failure mode? Pick `setup-warning` (config issue, fix once) vs `service-warning` (runtime issue, may recover) and route accordingly.

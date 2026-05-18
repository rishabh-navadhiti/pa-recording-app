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
 │               │                  │                   │                       │  writes _soap_note.md
 │               │                  │ on claude close: spawn md_to_docx.py for both .md files   │
```

Key properties:
- **Non-blocking**: state returns to `SESSION_ACTIVE` *before* transcription completes. The scribe can start the next case while the pipeline runs.
- **Detached subtree**: transcribe → soap → docx is a chain, not a supervisor tree. Each child only listens for its predecessor's `close` event.
- **Single log stream**: every child's stdout/stderr is captured by the main process and written to `<NOTES_DIR>/app.log` with a `[<case>]` tag, so the whole pipeline is reconstructable from one file.

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
│   └── skills/...
├── Cases/
│   └── <patient>_<YYYY-MM-DD>/
│       ├── <patient>.mp3                       (or recording.mp3 if name skipped)
│       ├── transcript.md                       diarised, by speaker
│       ├── transcript.docx                     auto-converted
│       ├── <case>_soap_note.md                 SOAP note from skill
│       └── <case>_soap_note.docx               auto-converted
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
| `processing_events` | `job_kind` (`transcribe`/`soap`/`docx`/`prechart`/`template_create`/`template_update`), token columns, `cost_usd`, `duration_ms`, `backup_path` | `db/events.js` — `startEvent()` before each spawn, `finishEvent()` in close handler |

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
| ICD MCP not authenticated / 401 | regex on add-icd-codes stdout/stderr | `service-warning` IPC (best-effort — pipeline still falls through to DOCX) |

Adding a new failure mode? Pick `setup-warning` (config issue, fix once) vs `service-warning` (runtime issue, may recover) and route accordingly.

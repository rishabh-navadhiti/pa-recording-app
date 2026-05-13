# Architecture

Pipeline, processes, and file flow for AI Medical Scribe. Sister doc to [CLAUDE.md](../CLAUDE.md) — this is the deeper view; CLAUDE.md is the quick reference.

---

## Process model

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron main process (main.js)                                 │
│   • Tray + popup window                                         │
│   • State machine                                               │
│   • IPC handlers                                                │
│   • Spawns and supervises all child processes                   │
│   • Single-instance lock                                        │
└────────────┬───────────────────────────────────┬────────────────┘
             │ contextBridge                     │ child_process.spawn
             │ (preload.js)                      │
             ▼                                   ▼
┌────────────────────────┐         ┌─────────────────────────────┐
│ Renderer (BrowserWin)  │         │ Children (one per task)     │
│   • renderer.js (UI)   │         │   • python record.py        │
│   • Listens for state  │         │   • python transcribe.py    │
│     + event broadcasts │         │   • python md_to_docx.py    │
│                        │         │   • claude -p (SOAP)        │
│                        │         │   • claude -p (template)    │
│                        │         │   • git pull (auto-update)  │
└────────────────────────┘         └─────────────────────────────┘
```

The renderer cannot touch Node, fs, or `child_process` — it must go through `window.api` (`preload.js`). Children are short-lived and unsupervised after spawn except `record.py`, which is held in `recordingProcess` and stopped via stdin.

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
 │               │                  │ on claude close: spawn claude -p (add-icd-codes) ─────────▶│
 │               │                  │                   │                       │  add-icd-codes
 │               │                  │                   │                       │  reads soap note
 │               │                  │                   │                       │  calls ICD-10 MCP
 │               │                  │                   │                       │  appends code table
 │               │                  │ on icd close (ANY exit): spawn md_to_docx.py for both .md │
```

Key properties:
- **Non-blocking**: state returns to `SESSION_ACTIVE` *before* transcription completes. The scribe can start the next case while the pipeline runs.
- **Detached subtree**: transcribe → soap → icd → docx is a chain, not a supervisor tree. Each child only listens for its predecessor's `close` event.
- **Single log stream**: every child's stdout/stderr is captured by the main process and written to `<NOTES_DIR>/app.log` with a `[<case>]` tag, so the whole pipeline is reconstructable from one file.
- **ICD coding is best-effort**: `spawnIcdCoding` always falls through to `spawnDocxConversion`, even on non-zero exit, MCP failure, or empty output. A note without codes is still useful; a hard MCP auth error surfaces as a `service-warning` IPC but does not block the case.

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
    edit-note/SKILL.md
    add-icd-codes/SKILL.md
  .mcp.json                              ← project-scope MCP config (ICD-10 connector)
  scripts/, draft/, settings.json
                  │
                  │  copyDirSync on every app start
                  ▼
~/Documents/AI Medical Notes/.claude/    ← runtime workspace for `claude -p`
  skills/...
~/Documents/AI Medical Notes/.mcp.json   ← written by ensureMcpConfig() next to every sync
```

`.mcp.json` lives at the **project root** (`<NOTES_DIR>`), not inside `.claude/`, per Claude Code's MCP discovery rules. `ensureMcpConfig()` writes it from a constant in `main.js` rather than copying the bundled file, so the runtime location is decoupled from the bundle layout.

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
- `add-icd-codes`: `add ICD codes. Soap note: "<rel-or-abs>".`  *(single arg; the skill reads the SOAP `.md`, calls the ICD-10 MCP connector, and appends an `## ICD-10-CM Codes` table. Re-runs strip a prior section and re-write it. Always exits 0 — failures are best-effort.)*

The first two use paths relative to cwd (= `<NOTES_DIR>`). The update prompt uses an absolute path because the template path is already resolved in main.js before the prompt is built. `add-icd-codes` accepts either — `main.js` passes a relative path.

### MCP integration

`add-icd-codes` calls tools from the claude.ai ICD-10 Codes connector. The connector is registered two ways:

1. **User-level (`~/.claude.json`)** — auto-added when the user logs into `claude` with an account whose org has the connector enabled. Tools appear as `mcp__claude_ai_ICD-10_Codes__*`.
2. **Project-scope (`<NOTES_DIR>/.mcp.json`)** — bundled with the app and written by `ensureMcpConfig()`. Tools appear as `mcp__icd10__*`.

The skill is tolerant of either namespace. The project-scope config is the fallback that makes the feature robust against per-user login state.

---

## File system layout (runtime)

```
<NOTES_DIR>/                                    e.g. ~/Documents/AI Medical Notes
├── settings.json                               app + user-editable
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
- Templates tab (update): `start-template-update`, `get-doctors-with-templates`
- Pre-chart: `browse-prechart-files`, `list-recent-patient-cases`, `browse-patient-case-folder`, `start-prechart-job` (status uses the shared `get-template-job-status` / `template-job-status` channel)
- Audio upload: `browse-audio-file`, `process-audio-file`
- Config: `get-state`, `get-config-status`, `save-elevenlabs-key`, `get-settings`, `save-settings`, `list-audio-devices`, `get-notes-dir`, `change-notes-dir`
- Window: `hide-window`

Main → renderer (events):
- `state-change` — fires on every `setState`
- `show-patient-form` — fires inside `stop-recording` after the Python child exits
- `setup-warning` — BlackHole missing, Claude CLI missing, record.py errors
- `service-warning` — ElevenLabs API errors, Claude usage limits
- `auto-start-recording` — fired after `stop-recording` completes if `autoRecord` setting is on
- `pick-doctor` — fires on `start-session` if more than one doctor configured
- `template-job-status` — fires on every state change of a template-creation, template-update, or pre-chart job (carries `type` field)

---

## Single-instance and lifecycle

`app.requestSingleInstanceLock()` ([main.js:602](../main.js#L602)) — second launches focus the existing popup and exit.

`before-quit` handler kills the recording process so the temp WAV doesn't linger.

`app.dock?.hide()` on macOS — no dock icon, tray-only.

---

## Auto-update

`checkForUpdates()` runs on every launch ([main.js:538](../main.js#L538)):
1. `git pull --ff-only` in the repo working tree
2. If output is `Already up to date.` → done
3. Otherwise re-run the `notes-claude → <NOTES_DIR>/.claude` sync (so updated skills are immediately available)
4. Set tray tooltip + OS notification: "restart to apply"

Failures (no git, conflicts, network) are logged and ignored. The app never blocks on this.

---

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

Adding a new failure mode? Pick `setup-warning` (config issue, fix once) vs `service-warning` (runtime issue, may recover) and route accordingly.

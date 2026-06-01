# CLAUDE.md

Context for Claude Code sessions working on this repo. Read this first.

---

## What this is

**AI Medical Scribe** — an Electron system tray app for medical scribes. The scribe joins a doctor's Microsoft Teams consultation, the app silently captures system audio (loopback), transcribes it with ElevenLabs, and uses Claude (via the local `claude` CLI) to generate a SOAP note from a per-doctor template. Windows is the primary platform; macOS is secondary.

End-to-end flow:
`Click tray → Start Session → Pick Doctor → Start Recording → Stop → name patient → SESSION_ACTIVE (next case) … background pipeline: MP3 → transcript.md → SOAP note .md → .docx`

All output lands in `~/Documents/AI Medical Notes/Cases/{patient}_{YYYY-MM-DD}/`.

---

## Code map

```
main.js                       Electron main process — tray, popup window, state machine, IPC, pipeline orchestration, child-process management
preload.js                    contextBridge → window.api — the ONLY surface renderer can use
renderer/
  index.html                  Main window UI (280×420, three tabs: Record + Pre-chart + Templates)
  renderer.js                 State-driven UI; renders by current STATE; owns timer + forms
  styles.css                  Dark theme, single file
  status.html / status.js     Floating mini-window (300×380) showing per-case background-pipeline progress; opened via tray menu
python/
  record.py                   Audio capture. Win: PyAudioWPatch / WASAPI loopback. Mac: sounddevice / BlackHole. Reads stdin commands: stop, pause, resume.
  transcribe.py               ElevenLabs scribe_v1 → diarised transcript.md
  md_to_docx.py               Markdown → .docx via python-docx (run on every transcript and SOAP note)
  extract_attachments.py      Combines multiple prechart files (.md/.txt/.docx/.pdf) into a single .md for the edit-note skill
notes-claude/                   Bundled Claude Code workspace — copied at runtime to <NOTES_DIR>/.claude
  skills/generate-note/           SOAP-note skill, invoked by `claude -p "generate a note ..."`
  skills/create-doctor-profile/   Template builder skill, invoked by `claude -p "create a doctor profile ..."`
  skills/update-doctor-profile/   Template updater skill, invoked by `claude -p "update doctor profile. Doctor: ..."`
  skills/edit-note/               Pre-chart skill, invoked by `claude -p "edit note. Case: ..."`
  scripts/, draft/, settings.json
assets/tray-icon.png
docs/                         See "Documentation conventions" below
install.ps1, setup.ps1,
uninstall*.ps1, launch.vbs    Windows installer / launcher scripts
```

`<NOTES_DIR>` = the folder the user picked on first launch (stored in repo `.env` as `NOTES_DIR_PATH`). Conventionally `~/Documents/AI Medical Notes`.

---

## State machine

`IDLE → SESSION_ACTIVE → RECORDING ↔ PAUSED → PROCESSING → SESSION_ACTIVE` (loop), then `SESSION_ACTIVE → IDLE` on stop-session.

| State | Meaning | Transition trigger |
|---|---|---|
| `IDLE` | No active session | Stop Session, app start |
| `SESSION_ACTIVE` | Doctor picked, ready to record | Start Session, after Save Case, Discard |
| `RECORDING` | Python process capturing audio | Start Recording |
| `PAUSED` | Recording mid-flight, audio paused | Pause button |
| `PROCESSING` | Patient-name form open, awaiting input | Stop Recording (transient — popped immediately after name resolved) |

Defined identically in [main.js](main.js) (`STATE`) and [renderer/renderer.js](renderer/renderer.js) (`STATE`). They MUST match. Renderer subscribes via `api.onStateChange`.

After a recording completes, `stop-recording` returns to `SESSION_ACTIVE` immediately so the next case can begin while transcription/SOAP generation run in the background.

---

## Recording pipeline (the load-bearing flow)

1. **Start Recording** ([main.js:833](main.js#L833)) — spawn `python/record.py --output <tmp>/rec_<ts>.mp3`. Audio writes incrementally to a WAV in tmp.
2. **Stop Recording** ([main.js:876](main.js#L876)) — write `stop\n` to the Python process's **stdin** (NOT kill — see Decision #1 in `docs/DECISIONS.md`). Python flushes the WAV, converts to MP3, exits 0.
3. Patient-name form shown; main awaits `submit-patient-name`.
4. Case folder built: `<NOTES_DIR>/Cases/{patient}_{YYYY-MM-DD}/`. Temp MP3 renamed in.
5. `spawnTranscription` → `python/transcribe.py` → `transcript.md` (diarised).
6. On transcribe success: `spawnSoapGeneration` → `claude -p "generate a note using template X and transcript Y"` (cwd = `<NOTES_DIR>`). Skill `generate-note` writes `<case>_soap_note.md`.
7. On SOAP write: `spawnDocxConversion` → `.docx` of both transcript and SOAP note.
8. State already returned to `SESSION_ACTIVE` after step 4 — pipeline runs detached.

Per-step logging tagged with `[<case>]` and `[<phase>]` in `<NOTES_DIR>/app.log`.

Service-warning surface: stderr/stdout of transcribe and claude is regex-scanned for ElevenLabs key/quota errors and Claude usage limits, surfaced to the renderer via `service-warning` IPC.

---

## Template + Pre-chart pipelines

All three Claude background jobs (template create, template update, pre-chart edit-note) share the same `templateJobProc` lock (only one at a time) and persist their state to `<NOTES_DIR>/.template_job.json`. The job object includes a `type` field (`'create'`, `'update'`, or `'prechart'`) so the renderer banner shows the right verb.

**Template create (Templates tab):**
1. User picks doctor name + sample-note files in the Templates tab.
2. `start-template-creation` — files staged into `<NOTES_DIR>/Templates/_staging/<lastname>/`.
3. `spawnTemplateCreation` → `claude -p "create a doctor profile for ... from source folder ..."` with `--model claude-opus-4-7`, `CLAUDE_CODE_EFFORT_LEVEL=max`.
4. Skill `create-doctor-profile` writes `<NOTES_DIR>/templates/<lastname>.md`.
5. On success: doctor auto-registered in `settings.json`, staging folder deleted.

**Template update (Templates tab):**
1. User picks a doctor (dropdown — only doctors with an existing template file) and types corrections.
2. `start-template-update` — resolves template path from `settings.json`, calls `spawnTemplateUpdate`.
3. `spawnTemplateUpdate` → `claude -p "update doctor profile. Doctor: <name>. Template: <abs-path>. Corrections: <text>"`.
4. Skill `update-doctor-profile` backs up the existing template to `templates/backups/<lastname>_backup_<ts>.md`, applies surgical edits, writes back in place.

**Pre-chart (Record tab → Pre-chart button):**
1. From SESSION_ACTIVE the user clicks **Pre-chart**, picks an existing patient case (dropdown of recent cases or Browse), types instructions, and optionally attaches one or more files (`.md`/`.txt`/`.docx`/`.pdf`).
2. `start-prechart-job` — main.js parses `**Doctor:**` from the case's existing `*_soap_note.md` to resolve the doctor's template (falls back to currently-selected doctor).
3. If files were attached: `python/extract_attachments.py` combines them into a single `prechart_<ts>.md` in OS temp.
4. `spawnPrechartJob` → `claude -p "edit note. Case: <case>. Template: <tmpl>. Attachment: <combined-or-empty>. Instructions: <text>"` with `--model <soapModel>`, `CLAUDE_CODE_EFFORT_LEVEL=high`.
5. Skill `edit-note` backs up the existing soap note to `<stem>_soap_note_backup_<ts>.md`, regenerates with the new content, overwrites in place.
6. On success: temp combined attachment deleted, `spawnDocxConversion` re-runs against the updated soap note.

Stale `running` jobs from a prior crash are cleared on app start — the child died with the app, so the marker is orphaned.

---

## IPC contract (preload.js)

Renderer can call ONLY these methods on `window.api`. Source of truth: [preload.js](preload.js).

| Method | Purpose |
|---|---|
| `getState()` | Current state at startup |
| `startSession() / stopSession()` | Session lifecycle (returns `{ok, error?}` — `no-doctors`, `cancelled`) |
| `startRecording() / stopRecording()` | Recording lifecycle |
| `pauseRecording() / resumeRecording() / discardRecording()` | Mid-recording control |
| `submitPatientName(name)` | Resolves the awaited patient-name promise in stop-recording |
| `getConfigStatus()` | `{elevenLabsKeyMissing, elevenLabsKeyInvalid, noDoctors, notesDirMissing}` |
| `saveElevenLabsKey(key)` | Writes to repo `.env` |
| `getDoctors() / addDoctor / updateDoctor / updateDoctorTemplate / removeDoctor / selectDoctor` | Doctor CRUD + picker resolution |
| `browseAudioFile() / processAudioFile(path, name)` | Audio-file upload flow |
| `browseNotesFiles() / startTemplateCreation / getTemplateJobStatus / cancelTemplateCreation / dismissTemplateJob` | Template-creation flow |
| `startTemplateUpdate(doctorName, corrections, correctionsFile, sampleFiles) / browseCorrectionsFile() / getDoctorsWithTemplates()` | Template-update flow (corrections can be typed AND/OR loaded from a file; optional extra sample notes for additional context) |
| `browsePrechartFiles() / listRecentPatientCases() / browsePatientCaseFolder() / startPrechartJob(doctorId, caseDir, instructions, attachmentPaths)` | Pre-chart (edit-note) flow — status uses the shared `getTemplateJobStatus` channel |
| `getSessionRecordings() / openStatusWindow() / closeStatusWindow()` | Floating status window for tracking concurrent background pipelines |
| `openSoapNote(filePath)` | Opens the SOAP `.docx` in the OS default handler |
| `getElevenLabsKey()` | Returns the configured ElevenLabs key for the Settings view |
| `browsePrechartFiles() / listRecentPatientCases() / browsePatientCaseFolder() / startPrechartJob(caseDir, instructions, attachmentPaths)` | Pre-chart (edit-note) flow — status uses the shared `getTemplateJobStatus` channel |
| `getSettings() / saveSettings(s)` | `settings.json` in NOTES_DIR |
| `listAudioDevices()` | Spawns `record.py --list-devices` |
| `getNotesDir() / changeNotesDir()` | Notes folder picker |
| `hideWindow()` | Close popup |
| `openSoapNote(filePath)` | Opens SOAP note `.docx` via OS default handler |

Events (`on*`):
`onStateChange`, `onShowPatientForm`, `onSetupWarning`, `onAutoStartRecording`, `onPickDoctor`, `onServiceWarning`, `onTemplateJobStatus`, `onRecordingStatusUpdate` (driving the floating status window).

When adding an IPC method: add to `preload.js`, register handler in `registerIpcHandlers()` in `main.js`, document the call in this table.

---

## Settings & config files

| File | Owned by | Purpose |
|---|---|---|
| `<repo>/.env` | App writes; user-editable | `ELEVENLABS_API_KEY`, `NOTES_DIR_PATH` |
| `<NOTES_DIR>/settings.json` | App writes; user-editable | `autoRecord`, `manualDeviceSelection`, `selectedDeviceIndex`, `doctors[]`, `soapModel`, `templateModel`, `templateEffort` |
| `<NOTES_DIR>/.template_job.json` | App writes only | Live + last-finished background-job state (template create/update + pre-chart share this file) |
| `<NOTES_DIR>/.claude/` | App copies from `notes-claude/` on every startup | Skills + Claude config consumed by `claude -p` |
| `<NOTES_DIR>/app.log` | App appends | Single log stream from main + Python children |

`settings.json` defaults are in `DEFAULT_SETTINGS` ([main.js:77](main.js#L77)) — keep additions there, not scattered.

---

## Windows-only conveniences

- **File hiding** — on Windows the app calls `attrib +h` on (a) every `.md` file inside case folders, and (b) every entry inside `<NOTES_DIR>` except `Cases/` (so users see only the patient folders and `.docx` finals, not transcripts, raw markdown, settings, or `.claude/`). `hideFileFromUser()` / `hideNotesDirInternals()` / `hideExistingCaseMdFiles()` in main.js. Helpers no-op on macOS.
- **Close-to-minimize** — clicking the window close button minimizes instead of quitting; only the tray menu's Quit or `before-quit` actually exits. `isQuitting` flag gates this.
- **Smart Python resolution** — on Windows we try `py`, then `python`, then `python3` to handle Python launcher / store-app / PATH variations. `PYTHON` constant resolves once at startup.

---

## Auto-update

On launch, [main.js:538](main.js#L538) runs `git pull --ff-only` in the repo. If new commits land, `notes-claude/` is re-synced into `<NOTES_DIR>/.claude/` and a tray-tooltip + OS notification ask the user to restart. Failures are logged and ignored — never blocks startup.

---

## Don't touch without thinking

These are load-bearing. Read [docs/DECISIONS.md](docs/DECISIONS.md) before changing them.

1. **The state machine** — values in `STATE` (main.js + renderer.js) must stay in sync.
2. **The stdin-stop protocol** ([main.js:888](main.js#L888)) — `stop-recording` writes `stop\n` to Python's stdin. Do NOT switch to `kill()`/`SIGTERM` — TerminateProcess on Windows skips Python's WAV-flush + MP3 convert.
3. **Skills sync** ([main.js:629](main.js#L629)) — `notes-claude/` is the source of truth, copied to `<NOTES_DIR>/.claude/` on every launch. Don't store skill state inside `<NOTES_DIR>/.claude/` directly.
4. **Skill prompt signatures** — `generate-note` parses `using template "X" and transcript "Y"`; `create-doctor-profile` parses `for "<name>" from source folder "<path>"`; `update-doctor-profile` parses `Doctor: <name>. Template: <path>. Corrections: <text>`; `edit-note` parses `Case: <case>. Template: <tmpl>. Attachment: <path-or-empty>. Instructions: <text>` (single attachment — multi-file Pre-chart is pre-combined by [python/extract_attachments.py](python/extract_attachments.py) before the skill is invoked). The skills' Step 0/1 expects these exact formats.

---

## Branching + release flow

Three long-lived branches, promoted in one direction only:

```
feature/* ──► develop ──► staging ──► main
                            ▲           │
                            └── auto-update on running installs
```

| Branch | What runs against it | Purpose |
|---|---|---|
| `develop` | `npm start` during dev | Latest accepted features. Devs test by running source. |
| `staging` | Installed via `install-staging.ps1` | Mirrors what users will see. Devs run this as a real installed app so the **auto-update + `notes-claude/` sync pipeline** is exercised before users hit it. |
| `main` | Installed via `install.ps1` (user-facing) | What every end-user install auto-pulls on launch. |

**Rules — follow these exactly when the user asks to "merge to staging" or "push to main":**

1. **Never merge `develop` straight to `main`.** Promotion is `develop → staging → main`, never skipped.
2. **`develop → staging` is the test gate.** After this merge, sit on staging long enough that at least one auto-update cycle has fired on a dev's staging install. Confirm it didn't break before promoting onward.
3. **`staging → main` should be a fast-forward** (no extra work between staging and main — staging *is* the candidate for main). If it can't fast-forward, that means a hotfix landed directly on main; back-merge `main → staging` first, then `staging → main` again.
4. **Hotfix rule:** truly urgent fixes land on a `hotfix/*` branch, merged to **both** `main` and `staging` (and `develop`) in the same session. Never let `staging` fall behind `main`.
5. **Branch contents are identical across all three.** No staging-only files committed. Staging-mode behavior is gated by a local-only `.staging-marker` file (gitignored) written by `install-staging.ps1`. See "Staging detection" below.
6. **Squashing:** prefer merge commits (not squash) on `develop → staging` and `staging → main` so the relationship between branches stays visible in `git log --graph`.

### Staging detection

A staging build is **not** identified by branch name — it's identified by the local file `.staging-marker` in the install directory. The marker is written by `install-staging.ps1` and is `.gitignored`, so it can never leak into a user's production install regardless of which branch the code is on. Read by [`isStagingBuild()`](main.js) on startup. When true:

- The header shows a yellow `STAGING` badge ([renderer/index.html](renderer/index.html), `#staging-badge`).
- Update notifications and the tray tooltip include `(staging)` in the title.
- `[Build: STAGING ...]` is logged at startup.

If you add staging-mode behavior, gate it on `isStagingBuild()` in main.js or on `api.getBuildInfo().isStaging` in the renderer — never on branch name and never on a committed file.

---

## Development conventions

- **Edit, don't rewrite.** Prefer `Edit` over `Write` for existing files. Keep diffs small.
- **No Co-Authored-By in commits.** Single-author per the user's preference.
- **Commit style:** `<type>: <imperative summary>` (e.g. `feat: add pause button`, `fix: strip Dr. prefix from lastname`). Match existing `git log`.
- **Branches:** see the **Branching + release flow** section below — never merge straight to `main`, always go through `staging`.
- **Logging:** use the `log()` helper in main.js. All Python output already piped through it tagged.
- **Comments:** only when the *why* isn't obvious. The code has a few load-bearing ones — don't strip them.
- **Test the UI before claiming done** — run `npm start` and exercise the change. Type-check passes don't prove the popup still works.
- **Platform parity:** Windows is primary. If you write platform-specific code, add the macOS branch (or a clear `if process.platform === 'win32'` guard) — don't break Mac.

---

## Documentation conventions

Six living docs. Keep them tight; everything else goes in `docs/archive/`.

```
README.md                          Public-facing quickstart (GitHub front page)
CLAUDE.md                          This file — context for Claude Code sessions
docs/
  OVERVIEW.md                      What this app is, who uses it, how it hangs together (self-contained for new readers)
  ARCHITECTURE.md                  Pipeline, state machine, IPC, file flow (deeper view)
  DECISIONS.md                     Append-only, dated, initialed
  plans/
    README.md                      Index of in-flight feature plans
    YYYY-MM-DD-<initials>-<slug>.md  One per planned feature
  archive/                         Anything historical or shipped
    plans/                         Plans for shipped features end up here
```

If you give `docs/` to a fresh Claude session without this repo, **OVERVIEW.md is the entry point** — it's the standalone explainer of what the app is and how it works. ARCHITECTURE.md is the deeper technical view (assumes you've already oriented).

**When you change code, update docs in the same PR.** Specifically:
- Touched the state machine, IPC channels, pipeline, or settings → update [CLAUDE.md](CLAUDE.md) **and** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Made a non-obvious technical choice → append a dated entry to [docs/DECISIONS.md](docs/DECISIONS.md).
- Built from a plan → move the plan to `docs/archive/plans/` after merging.

**Feature workflow:**
1. Plan: `docs/plans/YYYY-MM-DD-<initials>-<slug>.md` — design before coding. Add a one-line entry to `docs/plans/README.md`.
2. Implement + update living docs in the same PR.
3. After merge: `git mv` the plan into `docs/archive/plans/` and remove its line from `docs/plans/README.md`.

**Doc edits with two devs:** `DECISIONS.md` is append-only by date — no merge conflicts by construction. For `CLAUDE.md` / `ARCHITECTURE.md`, prefer adding new sections over reflowing existing ones; section headers are stable anchors.

**Periodic audit prompt** (run when docs feel drifted):
> "Read main.js, preload.js, renderer/renderer.js, and the python/ files. Diff what they actually do against CLAUDE.md and docs/ARCHITECTURE.md. Patch only the parts that have drifted; don't reflow."

---

## Quick references

- Logs: `<NOTES_DIR>/app.log`
- ElevenLabs key + notes path: `<repo>/.env`
- Skills: `notes-claude/skills/{generate-note,create-doctor-profile,update-doctor-profile}/SKILL.md`
- Default models (overridable via settings.json): SOAP = `claude-sonnet-4-6`, template = `claude-opus-4-7` (effort=max)
- Python entry: `record.py`, `transcribe.py`, `md_to_docx.py`
- Run: `npm start`

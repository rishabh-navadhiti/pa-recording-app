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
renderer/                     ESM module graph (no bundler — native file:// imports; sandboxed, can't require src/shared)
  index.html                  Main window UI (280×420, three tabs: Record + Pre-chart + Templates); loads app.js as type=module
  app.js                      viewRouter — renders the active view by current STATE; owns the state subscription
  views/                      one module per screen ({ mount, update, unmount }) — record, prechart, templates, settings, upload, …
  components/                 shared building blocks: visible, timer, fileListField, button, confirm
  ipc/client.js               the single window.api seam — `ipc` Proxy forwarding lazily to window.api
  constants.js                ESM copies of STATE / STATUS_LABELS / DOCTOR_SPECIALTIES (drift-tested vs src/shared)
  styles.css                  Dark theme, single file
  status.html / statusPanel.js  Floating mini-window (300×380) showing per-case background-pipeline progress; opened via tray menu
python/
  record.py                   Audio capture. Win: PyAudioWPatch / WASAPI loopback. Mac: sounddevice / BlackHole. Reads stdin commands: stop, pause, resume.
  md_to_docx.py               Markdown → .docx via python-docx (run on every transcript and SOAP note)
  (transcribe.py + extract_attachments.py ported to Node in Phase 5 — see src/pipeline/elevenLabs.js + src/pipeline/attachments.js)
notes-claude/                   Bundled Claude Code workspace — copied at runtime to <NOTES_DIR>/.claude
  skills/generate-note/           SOAP-note skill, invoked by `claude -p "generate a note ..."`
  skills/create-doctor-profile/   Template builder skill, invoked by `claude -p "create a doctor profile ..."`
  skills/update-doctor-profile/   Template updater skill, invoked by `claude -p "update doctor profile. Doctor: ..."`
  skills/edit-note/               Pre-chart skill, invoked by `claude -p "edit note. Case: ..."`
  skills/add-icd-codes/           ICD-10 coding skill, invoked by `claude -p "add ICD codes. Soap note: ..."` — appends an ICD-10-CM Codes table to a SOAP note via the claude.ai ICD-10 MCP connector
  skills/cdi-review/              CDI Co-Pilot skill (v1, ortho only), invoked by `claude -p "review cdi. Case: ..."` — produces <case>_cdi.json + .md. Standalone in v1; app pipeline integration is Plan 2.
  standards/                      Standards packs consumed by cdi-review (and future review engines): icd10_fy2026.md, ahima_acdis_2026.md, specialties/orthopedics.md. README.md explains naming + update policy.
  .mcp.json                       Project-scope MCP config — copied verbatim by writeMcpConfig() (config/mcp.js, called from startup/bootstrapNotesDir.js + src/update/autoUpdate.js) to <NOTES_DIR>/.mcp.json on every skills sync so `claude -p` (cwd: NOTES_DIR) always sees the ICD-10 connector
  settings.json
assets/tray-icon.png
docs/                         See "Documentation conventions" below
src/                          Modular app code (Phases 0-5). main.js is now a thin bootstrap + shims + a deps-assembling registerIpcHandlers.
  shared/                       Single-sourced enums: state.js, pipeline-status.js, ipc-channels.js (CHANNELS), specialties.js — imported by main.js + preload; the sandboxed renderer keeps drift-tested copies in renderer/constants.js
  llm/                          LLM seam: provider.js (interface) + claudeCliProvider.js (arg-array spawn, no shell:true), childRunner.js, usage.js; skill-io/{prompts,markers,manifest}.js
  engines/                      soap/icd/cdi/emScore/patientSummary descriptors + registry.js + engineRunner.js (the shared per-engine runner: gates→status→startEvent→runSkill→classify→interpret→finishEvent→persist→service-warning→stage-complete)
  pipeline/                     chain.js (single+multi per-case chain), ingest.js, transcription.js (+ elevenLabs.js — Node ElevenLabs client/formatter), attachments.js (Node prechart combine — mammoth/.docx, pdf-parse/.pdf), docx.js, report.js (combined "Clinical Cockpit" HTML→PDF render of the engine JSONs), multiPatient.js, caseStatus.js, artifacts.js
  jobs/                         jobDispatcher.js (runJob: acquire lock → ctx.llm.runSkill → abort/finally) + templateCreate/templateUpdate/prechart descriptors. (The lock/state object itself is top-level jobs/jobRunner.js → createJobRunner → ctx.stores.jobs.)
  ipc/                          envelope.js + 8 per-domain registrars (lifecycle/recording/doctors/templates/prechart/config/audioUpload/status) — 43 handlers
  update/autoUpdate.js          git-pull updater (Phase 6 → electron-updater)
context/                      appContext.js (the ctx) + stateMachine, sessionStore, recordingsStore, recorderController
config/                       paths, settings (cached), secrets, jobState, mcp
platform/                     index.js + windows.js / macos.js (the platform seam)
windows/                      mainWindow.js (guarded send facade), statusWindow.js, tray.js
startup/                      bootstrap.js (ordered whenReady steps) + bootstrapNotesDir.js
log/logger.js                 levels + redact(PII)
db/                           hardened: transactional migrations, withDb.js, injectable getDb
templates/engine-report/      cockpit.html — the shipped, committed engine-output report template (CDI · E/M · patient-summary in one print-optimised page). Self-contained; the app injects PA_DATA into its `<script id="pa-data">` seam. Read at runtime by src/pipeline/report.js.
install.ps1, setup.ps1,
uninstall*.ps1                Windows installer / launcher scripts
```

`<NOTES_DIR>` = the folder the user picked on first launch (stored in repo `.env` as `NOTES_DIR_PATH`). Conventionally `~/Documents/AI Medical Notes`.

---

## Working in the refactored codebase (read before adding features)

The Phase 0–5 refactor dissolved the old `main.js` monolith. main.js is now a ~675-line bootstrap; logic lives in `src/`, `context/`, `config/`, `platform/`, `startup/`, `db/`, `log/`, and (renderer-side) `renderer/views|components|ipc`. The patterns below are how new work should fit in — follow them rather than re-growing main.js.

**The `ctx` object (dependency injection).** Built by `context/appContext.js`, assembled in `startup/bootstrap.js`, held as a single module-level `ctx` in main.js. It carries everything the old globals used to be:
- `ctx.config` — cached settings store (`config/settings.js`); `ctx.config.get()` / `.save()`.
- `ctx.llm` — the **LLM provider seam** (`src/llm/claudeCliProvider.js`). All Claude calls go through `ctx.llm.runSkill({ prompt, model, effort, tag, label })`. **There is no `spawnClaude` anymore.** The provider spawns with `shell:false` + an arg array (prompt is a separate argv element, so shell metacharacters are inert) — never reintroduce `shell:true` or string-interpolated prompts.
- `ctx.paths` — resolved paths (`config/paths.js`), no mutable path globals.
- `ctx.platform` — Win/Mac seam (`platform/index.js` → `windows.js`/`macos.js`): `isStaging()`, `hideInternal()`, `notify()`, `resolvePython()`. Put OS-specific behavior here, not inline `process.platform` checks.
- `ctx.stores.{state, session, recordings, recorder, jobs}` — the former ~18 mutable main.js globals, now encapsulated stores (`context/*.js`).
- `ctx.renderer.send(...)` / `ctx.sendStatus(...)` — the single **guarded** path to the windows (never reach for `win` directly).
- `ctx.db`, `ctx.log`.
main.js keeps thin shims (`log`, `setState`, `readSettings`, `spawnDocxConversion`, `spawnTemplateCreation`, …) that just delegate to `ctx` for backwards-compatible call sites; new code should take `ctx` (or `appCtx` + a `deps` bag) as a parameter and never reach for module globals.

**Adding a post-processing engine** (a new "review/generate on the SOAP note" step — e.g. Workers-Comp, E/M scorer): write a descriptor in `src/engines/<name>.js` exposing the standard shape (`id`, `skillId`, `jobKind`, `stage`, `gates(ctx, caseCtx)`, `buildInput()`, `interpret()`, `persist()`, `render()`, `model()`, `effort`) — mirror `icd.js`/`cdi.js`; register it in `src/engines/registry.js` (the ordered array the chain iterates); add a DB migration under `db/migrations/`; add the skill folder under `notes-claude/skills/`. The shared `runEngine()` (`src/engines/engineRunner.js`) drives every descriptor through the same lifecycle. No monolith edits. **Agentic vs API:** by default `runEngine` runs the skill agentically via `ctx.llm.runSkill` (ICD/CDI). If the engine has **no tool/MCP needs**, give it a `runLlm(input, ctx, caseCtx, {model, provider})` method instead — `runEngine` then routes it through a single Anthropic Messages-API call (pinned to `ctx.api`), Node reads inputs + writes the output file, and `runLlm` returns a normalized `{code, text(=manifest), usage}` result (see `emScore.js`/`patientSummary.js`). (See `docs/refactor/02-target-architecture.md` for the full engine-framework design.)

**Adding a renderer view** (a new screen/overlay): create `renderer/views/<name>.js` exporting `{ mount, update, unmount }`, wire it into the router in `renderer/app.js`, and call the backend only through the `ipc` proxy in `renderer/ipc/client.js` (forwards to `window.api`). The renderer is **sandboxed ESM** — it cannot `require` anything from `src/`; shared enums are drift-tested copies in `renderer/constants.js`. Shared widgets live in `renderer/components/` (`fileListField`, `timer`, `button`, `confirm`, `visible`). (Future heavy/stateful screens — e.g. a unified review surface — may adopt React/Vue via the same `{mount,update,unmount}` seam; see `docs/refactor/07` B15.)

**Background jobs** (template-create/update, prechart): defined as descriptors (`src/jobs/{templateCreate,templateUpdate,prechart}.js`) and run through `src/jobs/jobDispatcher.js`'s `runJob()`, which acquires the single-flight lock (`ctx.stores.jobs`, created by top-level `jobs/jobRunner.js`). Don't reintroduce a `templateJobProc` global.

**Tests.** Pure modules are unit-testable in isolation (`tests/unit/`), integration tests cover the migration-replay + recorder protocol (`tests/integration/`), Python has its own suite (`tests/python/`). Add tests with the module you extract — that's the whole point of the seams. `npm test` runs unit+integration; CI runs on push.

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

Defined identically in [main.js](main.js) (`STATE`, imported from `src/shared/state.js`) and [renderer/constants.js](renderer/constants.js) (`STATE`). They MUST match — guarded by the drift test in [tests/unit/shared-drift.test.js](tests/unit/shared-drift.test.js). Renderer subscribes via `api.onStateChange`.

After a recording completes, `stop-recording` returns to `SESSION_ACTIVE` immediately so the next case can begin while transcription/SOAP generation run in the background.

---

## Recording pipeline (the load-bearing flow)

1. **Start Recording** (`src/ipc/recording.js`, `start-recording` handler) — spawn `python/record.py --output <tmp>/rec_<ts>.mp3`. Audio writes incrementally to a WAV in tmp. The live process is held by `ctx.stores.recorder` (`context/recorderController.js`).
2. **Stop Recording** (`src/ipc/recording.js` → `ctx.stores.recorder.stop()` in `context/recorderController.js`) — write `stop\n` to the Python process's **stdin** (NOT kill — see Decision #1 in `docs/DECISIONS.md`). Python flushes the WAV, converts to MP3, exits 0.
3. Patient-name form shown; main awaits `submit-patient-name`.
4. Case folder built: `<NOTES_DIR>/Cases/{patient}_{YYYY-MM-DD}/`. Temp MP3 renamed in. **In-recording pre-chart:** if the scribe captured context via the Pre-chart screen — reachable from the recording action row OR the patient-name form (and from the upload name form for the upload flow) and held in `recorderController` — `stop-recording`/`process-audio-file` combines the text + attachments (`buildPrechartTempFile` in `src/pipeline/attachments.js`) and `ingestAudio` writes `<caseDir>/prechart.md` (hidden on Windows) before transcription starts. The Pre-chart screen is a pure overlay that keeps the recording timer running (it never resets it).
5. `spawnTranscription` → ElevenLabs scribe_v2 via Node (`src/pipeline/elevenLabs.js`, native `fetch`) → `transcript.md` (diarised). No longer a Python child.
6. On transcribe success: `spawnSoapGeneration` → `claude -p "generate a note using template X and transcript Y"` (cwd = `<NOTES_DIR>`). Skill `generate-note` writes one `.md` per patient into the case folder and ends its final response with a single-line JSON manifest declaring what it wrote (paths, patient names, `multi_patient` flag, per-case status). The skill no longer generates DOCX and no longer creates sub-folders. **Pre-chart on the API path:** when `soapModel` resolves to an API provider and a `prechart.md` exists in the case folder, `generateSoapViaApi` reads it and `buildSingleCallNoteGen` injects a `PRE-CHART CONTEXT` block into every note-gen call (single-patient + each multi-patient fan-out). The skill is always `generate-note-api`, whose `PRE-CHART CONTEXT` rule is optional — it only engages when the block is present, so no `prechart.md` → behaviour is unchanged. The CLI/agentic path ignores pre-chart.
7. On SOAP close (`spawnSoapGeneration` in main.js, a thin shim): `parseSkillManifest()` reads the manifest from the skill's final assistant text, then the per-case post-processing chain runs via **`src/pipeline/chain.js`** — `runCaseChain()` (single-patient) or `runMultiPatientChain()` (multi-patient). The chain runs **ICD → CDI → E/M score → patient summary → docx → report**: ICD, CDI, em-score, patient-summary are all **engine descriptors** (`src/engines/{icd,cdi,emScore,patientSummary}.js`) executed through `runEngine()` (`src/engines/engineRunner.js`); docx is `spawnDocxConversion()` (`src/pipeline/docx.js`) × {soap, cdi}; report is `renderCaseReport()` (`src/pipeline/report.js`). There is no `spawnIcdCoding`/`spawnCdiReview` anymore — those are engine descriptors now. docx and report are both **fixed post-steps** (not engines).
   - **Single-patient** (`multi_patient: false`): the **ICD engine** appends an `## ICD-10-CM Codes` table to the declared `.md` (best-effort — failure logs + emits `service-warning` but the chain continues). Its `gates()` short-circuit before Claude runs when global `enableIcd` is off. Then the **CDI engine** runs — its `gates()` short-circuit before Claude when global `enableCdi` is off, the doctor has no specialty, or there's no standards file for the specialty (the case is marked skipped). When the gates pass, the skill produces `<case>_cdi.json` + `<case>_cdi.md`, and `cdi.persist()` writes the `cases.cdi_*` summary columns (`updateCaseCdi`) + `cdi_flags` rows (`insertFlags`). Then the **E/M-score engine** (`enableEmScore` gate) and **patient-summary engine** (`enablePatientSummary` gate) run sequentially — each writes its JSON (`<case>_em.json` / `<case>_patient_summary.json`, **JSON only, no MD/docx**) and one row to the generic `engine_outputs` table (`db/engine_outputs.js insertOutput`). **These two engines are API-only** (see DECISIONS 2026-06-29): unlike ICD/CDI (agentic `claude -p`), they expose a `runLlm` hook and run as a single Anthropic Messages-API call pinned to `ctx.api` — Node reads the inputs (note, transcript, MDM pack) and writes the JSON; the model returns only the JSON object. They need `ANTHROPIC_API_KEY` even on the "Agentic" SOAP option. Then `spawnDocxConversion` runs against the soap `.md` (now with ICD codes baked in) — generates the `.docx`, hides the `.md` on Windows, updates the `cases` row to `completed`. When CDI produced an md, a second `spawnDocxConversion` runs on the cdi `.md` (generates `<case>_cdi.docx`, sets `cdi_docx_path`). `transcript.docx` is generated in parallel after transcription. **Finally `renderCaseReport()` (`src/pipeline/report.js`) renders the combined "Clinical Cockpit" report** from whatever engine JSONs landed (`<stem>_{cdi,em,patient_summary}.json`): it assembles `PA_DATA = {meta, cdi, em, patient_summary}`, injects it into `templates/engine-report/cockpit.html`'s `<script id="pa-data">` seam (`<`/`>` escaped so note text can't break the script block), writes `<stem>_report.html`, then prints it to `<stem>_report.pdf` via an **offscreen Electron `BrowserWindow` + `webContents.printToPDF`** (Chromium, zero new deps, `preferCSSPageSize` honors the template's `@page` Letter rules). Both report paths persist to the new `cases.report_html_path` / `report_pdf_path` columns (migration 008). Best-effort and **awaited** (one offscreen render at a time); a failure logs and leaves the engine JSONs untouched — the SOAP note is the primary deliverable. **The engine review/scoring outputs keep their own JSON (canonical) + this combined HTML+PDF; CDI's `.md`/`.docx` are unchanged (kept), em-score/patient-summary stay JSON-only.** The status window gains an "Open Report" button (prefers the PDF, falls back to HTML).
     - ⚠️ **KNOWN REGRESSION (flagged 2026-06-09):** the CDI engine's `persist()` is currently a no-op and `runEngine` never calls the engine `render()`, so the `cases.cdi_*` summary columns and `cdi_flags` rows are **not** being written (only `cdi_docx_path` is, via docx.js). CDI still runs and writes its `.json/.md/.docx`; only the DB persistence regressed during the refactor. Re-wire `cdi.persist()` to call `dbCases.updateCaseCdi` + `dbCdiFlags.insertFlags` (reading `<case>_cdi.json`) and have `runEngine` apply `render()` to the status store. See `docs/DB-SCHEMA.md` §3.3 + the DECISIONS entry.
   - **Multi-patient** (`multi_patient: true`): `runMultiPatientChain()` does a planning pass (`planChildCases` in `src/pipeline/multiPatient.js`) and publishes all children as `queued` to the status UI, then for each `ok`/`partial` entry it creates a child folder (`<slug>_<YYYY-MM-DD>/`), copies the parent's MP3 + `transcript.md` + `transcript.docx` with single-patient naming, copies the SOAP `.md` in renamed to `<folder>_soap_note.md`, inserts a child `cases` row (via `dbCases.createCase`), then runs `runCaseChain()` on the child (ICD → CDI → docx, sequential across children so the MCP connector + Anthropic quota aren't hit in parallel and per-case log blocks don't interleave). The recording (audit) folder retains the original MP3, transcript, and all `.md` SOAP files the skill wrote — **never ICD-coded, never CDI-reviewed, never docx-converted**; on Windows those `.md` files are hidden. The parent row is marked `completed` with `soap_note_path=NULL` and all `cdi_*` columns NULL. Non-DB manifest fields (`visit_type`, `chief_complaint`, `placeholders`, `warnings`, `summary`) are logged to `app.log` only — see [07-open-questions B13](docs/refactor/07-open-questions-and-decisions.md) for the plan to persist `visit_type`/`chief_complaint` for gated engines.
8. State already returned to `SESSION_ACTIVE` after step 4 — pipeline runs detached.

Per-step logging tagged with `[<case>]` and `[<phase>]` in `<NOTES_DIR>/app.log`.

Service-warning surface: stderr/stdout of transcribe and claude is regex-scanned for ElevenLabs key/quota errors and Claude usage limits, surfaced to the renderer via `service-warning` IPC.

---

## Template + Pre-chart pipelines

All three Claude background jobs (template create, template update, pre-chart edit-note) are descriptors (`src/jobs/{templateCreate,templateUpdate,prechart}.js`) run by `runJob()` in `src/jobs/jobDispatcher.js`, which shares a single-flight lock (`ctx.stores.jobs`, only one at a time) and persists state to `<NOTES_DIR>/.template_job.json`. The job object includes a `type` field (`'create'`, `'update'`, or `'prechart'`) so the renderer banner shows the right verb.

**Template create (Templates tab):**
1. User picks doctor name + sample-note files in the Templates tab.
2. `start-template-creation` — files staged into `<NOTES_DIR>/Templates/_staging/<lastname>/`.
3. `spawnTemplateCreation` (main.js shim → `runJob(templateCreateJob)`, `src/jobs/templateCreate.js`) → `claude -p "create a doctor profile for ... from source folder ..."` with `--model <templateModel>` (default `claude-opus-4-8`) and `CLAUDE_CODE_EFFORT_LEVEL=<templateEffort>` (default `max`).
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
3. If files were attached: `src/pipeline/attachments.js` (Node — `mammoth` for `.docx`, `pdf-parse` for `.pdf`) combines them into a single `prechart_<ts>.md` in OS temp.
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
| `getBuildInfo()` | `{isStaging, version, gitSha}` — used by renderer to show STAGING badge |
| `startSession() / stopSession()` | Session lifecycle (returns `{ok, error?}` — `no-doctors`, `cancelled`) |
| `startRecording() / stopRecording()` | Recording lifecycle |
| `pauseRecording() / resumeRecording() / discardRecording()` | Mid-recording control |
| `submitPatientName(name)` | Resolves the awaited patient-name promise in stop-recording |
| `getConfigStatus()` | `{elevenLabsKeyMissing, elevenLabsKeyInvalid, noDoctors, notesDirMissing}` |
| `getElevenLabsKey()` | Returns the configured ElevenLabs key for the Settings view |
| `saveElevenLabsKey(key)` | Writes to repo `.env` |
| `getDoctors() / addDoctor(name) / updateDoctor(id, name) / updateDoctorTemplate(id) / updateDoctorSpecialty(id, specialty) / removeDoctor(id) / selectDoctor(id)` | Doctor CRUD + picker resolution |
| `browseAudioFile() / processAudioFile(filePath, patientName)` | Audio-file upload flow |
| `browseNotesFiles() / startTemplateCreation(doctorName, filePaths) / getTemplateJobStatus() / cancelTemplateCreation() / dismissTemplateJob()` | Template-creation flow |
| `startTemplateUpdate(doctorName, corrections, correctionsFile, sampleFiles) / browseCorrectionsFile() / getDoctorsWithTemplates()` | Template-update flow (corrections can be typed AND/OR loaded from a file; optional extra sample notes for additional context) |
| `browsePrechartFiles() / listRecentPatientCases() / browsePatientCaseFolder() / startPrechartJob(doctorId, caseDir, instructions, attachmentPaths)` | Pre-chart (edit-note) flow — status uses the shared `getTemplateJobStatus` channel |
| `savePrechartContext(text, files) / getPrechartContext()` | In-recording Pre-chart capture — stores the current recording/upload's context (text + attachment paths) in `recorderController`; reachable from the recording action row AND both patient-name forms (post-recording + upload). Consumed at stop/process into `<caseDir>/prechart.md` and fed into initial note generation. Reuses `browsePrechartFiles()` for the file picker. |
| `getSessionRecordings() / openStatusWindow() / closeStatusWindow()` | Floating status window for tracking concurrent background pipelines |
| `openSoapNote(filePath)` | Opens the SOAP `.docx` in the OS default handler (confined to CASES_DIR) |
| `getSettings() / saveSettings(s)` | `settings.json` in NOTES_DIR |
| `listAudioDevices()` | Spawns `record.py --list-devices` |
| `getNotesDir() / changeNotesDir()` | Notes folder picker |
| `hideWindow()` | Close popup |

Events (`on*`):
`onStateChange`, `onShowPatientForm`, `onSetupWarning`, `onAutoStartRecording`, `onPickDoctor`, `onServiceWarning`, `onTemplateJobStatus`, `onRecordingStatusUpdate` (driving the floating status window).

When adding an IPC method: (1) add the literal channel string to `CHANNELS` in [src/shared/ipc-channels.js](src/shared/ipc-channels.js); (2) add the `ipcMain.handle(...)` to the appropriate per-domain registrar in `src/ipc/` (lifecycle / recording / doctors / templates / prechart / config / audioUpload / status — pick by domain). Registrars receive `(ipcMain, appCtx, deps)`; pull any main.js helpers you need from the `deps` bag assembled in `registerIpcHandlers()` in main.js, and prefer `ctx.*` over reaching for state; (3) expose the method in `preload.js` (channel strings are literals there — the preload is sandboxed and can't `require` the CHANNELS module; the drift test asserts they stay in sync); (4) document the call in this table.

---

## Settings & config files

| File | Owned by | Purpose |
|---|---|---|
| `<repo>/.env` | App writes; user-editable | `ELEVENLABS_API_KEY`, `NOTES_DIR_PATH` |
| `<NOTES_DIR>/settings.json` | App writes; user-editable | `autoRecord`, `manualDeviceSelection`, `selectedDeviceIndex`, `soapModel`, `templateModel`, `templateEffort`, `enableIcd` (gates the per-case ICD coding step), `enableCdi`, `cdiMode` (the last two gate the per-case CDI review step), `enableEmScore` (gates the per-case E/M MDM scoring engine), `enablePatientSummary` (gates the per-case patient-summary engine). **Invariant: `enableCdi` on ⟹ `enableIcd` on** — CDI needs ICD codes in the note, so enabling CDI forces ICD on (enforced in `config/settings.js` — the settings store's normalizer — and the `save-settings` handler in `src/ipc/config.js`). The two new toggles are independent (no coupling). — **`doctors[]` moved to `app.db` after first launch** |
| `<NOTES_DIR>/app.db` | App writes only | SQLite metadata + index store: `doctors`, `sessions`, `cases`, `processing_events`. Canonical artifacts stay on disk; DB stores references + structured metadata. WAL mode; safe to delete (rebuilt on next launch, doctors restored from `settings.doctors.backup.json`). |
| `<NOTES_DIR>/settings.doctors.backup.json` | App writes once | One-time backup of `settings.json doctors[]` written when doctors are migrated to `app.db`. Hand-recovery only — not read by app code. |
| `<NOTES_DIR>/.template_job.json` | App writes only | Live + last-finished background-job state (template create/update + pre-chart share this file) |
| `<NOTES_DIR>/.claude/` | App copies from `notes-claude/` on every startup | Skills + Claude config consumed by `claude -p` |
| `<NOTES_DIR>/.mcp.json` | App writes only (via `writeMcpConfig()` in `config/mcp.js` on every skills sync) | Project-scope MCP config — wires the `claude.ai ICD-10` connector for `claude -p` invocations (cwd: `NOTES_DIR`). Verbatim mirror of `notes-claude/.mcp.json`; overwritten on every sync. |
| `<NOTES_DIR>/app.log` | App appends | Single log stream from main + Python children |

`settings.json` defaults are in `DEFAULT_SETTINGS` ([config/settings.js](config/settings.js), imported by main.js) — keep additions there, not scattered.

---

## Windows-only conveniences

- **File hiding** — on Windows the app calls `attrib +h` on (a) every `.md` file inside case folders, and (b) every entry inside `<NOTES_DIR>` except `Cases/` (so users see only the patient folders and `.docx` finals, not transcripts, raw markdown, settings, or `.claude/`). `hideFileFromUser()` / `hideNotesDirInternals()` / `hideExistingCaseMdFiles()` in main.js. Helpers no-op on macOS.
- **Close-to-minimize** — clicking the window close button minimizes instead of quitting; only the tray menu's Quit or `before-quit` actually exits. `isQuitting` flag gates this.
- **Smart Python resolution** — on Windows we try `py`, then `python`, then `python3` to handle Python launcher / store-app / PATH variations. `PYTHON` constant resolves once at startup.

---

## Auto-update

On launch, `checkForUpdates()` ([src/update/autoUpdate.js](src/update/autoUpdate.js), wired in via `bootstrap()`) runs `git pull --ff-only` in the repo. If new commits land, `notes-claude/` is re-synced into `<NOTES_DIR>/.claude/`, `.mcp.json` is rewritten, `runPostUpdateSetup` runs `npm install` + `electron-rebuild -f -w better-sqlite3`, then a tray-tooltip + OS notification ask the user to restart. Failures are logged and ignored — never blocks startup. (Replaced by electron-updater in Phase 6 — see `docs/refactor/04`.)

---

## Don't touch without thinking

These are load-bearing. Read [docs/DECISIONS.md](docs/DECISIONS.md) before changing them.

1. **The state machine** — values in `STATE` (main.js via `src/shared/state.js` + `renderer/constants.js`) must stay in sync.
2. **The stdin-stop protocol** ([context/recorderController.js](context/recorderController.js) — the `stop()` method) — `stop-recording` writes `stop\n` to Python's stdin via the recorder controller. Do NOT switch to `kill()`/`SIGTERM` — TerminateProcess on Windows skips Python's WAV-flush + MP3 convert.
3. **Skills sync** ([startup/bootstrapNotesDir.js](startup/bootstrapNotesDir.js), also re-run by [src/update/autoUpdate.js](src/update/autoUpdate.js) after a pull) — `notes-claude/` is the source of truth, copied to `<NOTES_DIR>/.claude/` on every launch. Don't store skill state inside `<NOTES_DIR>/.claude/` directly.
4. **Skill prompt signatures** — `generate-note` parses `using template "X" and transcript "Y"` and ends its final response with a **single-line JSON manifest** matching the `schema_version:1` shape defined in [notes-claude/skills/generate-note/SKILL.md](notes-claude/skills/generate-note/SKILL.md) Step 7 (`status` / `multi_patient` / `recording_folder` / `cases[].{patient_name,doctor_lastname,visit_type,chief_complaint,soap_note_md,placeholders,warnings,status}` / `warnings`); main.js consumes that manifest via `parseSkillManifest()` (in [src/llm/skill-io/manifest.js](src/llm/skill-io/manifest.js)) — any prose the skill emits before the manifest is fine, but the manifest **must be the last line** of the final assistant text. `create-doctor-profile` parses `for "<name>" from source folder "<path>"`; `update-doctor-profile` parses `Doctor: <name>. Template: <path>. Corrections: <text>`; `edit-note` parses `Case: <case>. Template: <tmpl>. Attachment: <path-or-empty>. Instructions: <text>` (single attachment — multi-file Pre-chart is pre-combined by [src/pipeline/attachments.js](src/pipeline/attachments.js) before the skill is invoked); `add-icd-codes` parses `Soap note: "<rel-or-abs-soap-md-path>".` and emits one of `ICD_OK: <N> codes added to <path>` / `ICD_SKIPPED: no diagnoses found in <path>` / `ICD_ERROR: <reason>` on stdout (main.js scans the combined stdout+stderr for MCP-auth and rate-limit patterns to surface `service-warning` IPC); `cdi-review` parses `Case: <abs-case-dir>. Specialty: <name>. Mode: <balanced|compliance|aggressive>. Doctor: <name>. Standards: <abs-standards-dir>` and emits a **JSON manifest** as the last line of its final assistant text — schema in [notes-claude/skills/cdi-review/SKILL.md](notes-claude/skills/cdi-review/SKILL.md) Step 9 (`schema_version:1`, `skill:'cdi-review'`, `status:'ok'|'skipped'|'failed'`, plus `json_path`/`md_path`/`flag_count`/`flag_counts`/`quality_score`/`medical_necessity_status`/`claim_defense_readiness`/`clinician_approval_required`/`icd_validated`/`skipped_reason`/`error`). the **CDI engine** (`src/engines/cdi.js`, run through `runEngine()`) consumes the manifest via `parseSkillManifest()` in its `interpret()` (same defensive layered parser as `generate-note`); if the manifest line is missing or malformed, it falls back to reading the on-disk `<case>_cdi.json` (`synthesizeManifestFromDisk`) to recover the run state — that fallback is the load-bearing reliability layer and is intact. (Note: see the §7 regression flag — the *persistence* of the recovered result into `cdi_*`/`cdi_flags` is currently a no-op and needs re-wiring.) The **per-flag schema inside the full `<case>_cdi.json`** (distinct from the outer manifest above) includes `action` (required — one imperative TL;DR line per flag) and `reimbursement_impact` (optional, nullable — a billing signal in outpatient units, mostly null); both persist to the `cdi_flags` table. See [notes-claude/skills/cdi-review/SKILL.md](notes-claude/skills/cdi-review/SKILL.md) Step 3 for the per-flag schema. **`cdi-review` MUST validate every ICD code it emits (`current_code`, `suggested_codes[]`, `code_validation`) against the ICD-10 MCP connector before output, and must not raise a "needs more specificity" flag unless the connector confirms the more-specific child code exists** — the connector is ground truth and **wins over the prose standards packs** when they disagree about code existence or available specificity (the packs are heuristics and have contained wrong claims, e.g. a false De Quervain laterality axis; see the 2026-06-02 DECISIONS addendum). The skills' Step 0/1 expects these exact formats.

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

A staging build is **not** identified by branch name — it's identified by the local file `.staging-marker` in the install directory. The marker is written by `install-staging.ps1` and is `.gitignored`, so it can never leak into a user's production install regardless of which branch the code is on. Read by `ctx.platform.isStaging()` (defined in `platform/windows.js` / `platform/macos.js`, surfaced via `platform/index.js`) on startup. When true:

- The header shows a yellow `STAGING` badge ([renderer/index.html](renderer/index.html), `#staging-badge`).
- Update notifications and the tray tooltip include `(staging)` in the title.
- `[Build: STAGING ...]` is logged at startup.

If you add staging-mode behavior, gate it on `ctx.platform.isStaging()` in main-process code or on `api.getBuildInfo().isStaging` in the renderer — never on branch name and never on a committed file.

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
> "Read main.js, preload.js, renderer/app.js (+ renderer/views/), and the python/ files. Diff what they actually do against CLAUDE.md and docs/ARCHITECTURE.md. Patch only the parts that have drifted; don't reflow."

---

## Quick references

- Logs: `<NOTES_DIR>/app.log`
- ElevenLabs key + notes path: `<repo>/.env`
- Skills: `notes-claude/skills/{generate-note,generate-note-api,create-doctor-profile,update-doctor-profile,edit-note,edit-note-api,add-icd-codes,cdi-review,cdi-costigan,em-score,em-score-api,patient-summary,patient-summary-api}/SKILL.md` (`generate-note-api` has an optional PRE-CHART CONTEXT rule that engages only when the app injects a pre-chart block; there is no separate prechart skill. `em-score`/`patient-summary` are the agentic CLI skills, left on disk but dormant; the engines run the `*-api` skills as single Anthropic API calls — see DECISIONS 2026-06-29)
- Standards (consumed by cdi-review + the review/scoring engines): `notes-claude/standards/{icd10_fy2026,ahima_acdis_2026,em_mdm_2021}.md` + `notes-claude/standards/specialties/<specialty>.md` (ortho only) + `notes-claude/standards/procedures/*.md` (cdi-costigan). `em_mdm_2021.md` (AMA 2021 E/M MDM grid) is read by `em-score` and by `cdi-review` (for the per-flag E/M `reimbursement_impact` signal).
- CDI Co-Pilot review runs after ICD coding. Toggled globally in Settings (`enableCdi` + `cdiMode`); specialty is per-doctor in the Templates tab. Produces `<case>_cdi.{json,md,docx}` per case folder; also emits provider queries (`provider_query` per flag + top-level `queries[]`, AHIMA-compliant) and a per-flag E/M `reimbursement_impact` signal — all in the `_cdi.json`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → *Per-case post-processing chain*.
- E/M MDM scorer (`em-score`) + Patient summary (`patient-summary`) run after CDI, each gated by `enableEmScore` / `enablePatientSummary`. **JSON only** (`<case>_em.json` / `<case>_patient_summary.json`, no MD/docx — presentation is the combined report below). Each persists one row to the generic `engine_outputs` table (`db/engine_outputs.js`), NOT per-`cases` columns. em-score is connector-free (AMA/CPT rules) and parses the note's Level-of-Service placeholder into a structured `billed_em_code`/`billed_em_source` (null when none found — drives the report's billed-vs-supported card); patient-summary is plain-language, connector-free.
- **Engine-output report (`src/pipeline/report.js`):** after the chain's engines + docx, `renderCaseReport()` builds ONE combined "Clinical Cockpit" `<stem>_report.html` + `<stem>_report.pdf` per case from the engine JSONs, via `templates/engine-report/cockpit.html` + offscreen Electron `printToPDF`. Engine JSON stays canonical; this is the presentation layer. Paths persist to `cases.report_html_path`/`report_pdf_path`. Best-effort; one combined doc (not per-engine). Reference design: `docs/notes/cdi-ui-reference/presentation_cockpit_scroller.html`.
- Default models (overridable via settings.json): SOAP = `claude-sonnet-4-6`, template = `claude-opus-4-8` (effort=max)
- Python entry: `record.py`, `md_to_docx.py`, `probe_duration.py` (transcription + prechart-extract are Node now)
- Run tests: `npm test` (Node), `npm run test:py` (Python — stdlib unittest, `tests/python/`)
- Run: `npm start`

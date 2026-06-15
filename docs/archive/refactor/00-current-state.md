# 00 — Current State (the map)

> **Purpose.** A complete, factual snapshot of what the app *is* today — its flow, screens, pipeline, processes, files, and how the code is laid out — written so a fresh reader (human or Claude) can orient before touching anything. This doc is descriptive, not prescriptive. The *problems* with this state are in [01-problems.md](01-problems.md); the *target* is in [02-target-architecture.md](02-target-architecture.md).
>
> Sister docs in the main tree: [docs/OVERVIEW.md](../OVERVIEW.md), [docs/ARCHITECTURE.md](../ARCHITECTURE.md), [docs/DECISIONS.md](../DECISIONS.md). This doc compresses them into one current-state picture and adds the things they don't cover (the dependency chain, the code-size map, the distribution reality).

---

## 1. What the app is, in one paragraph

**AI Medical Scribe** is an Electron system-tray desktop app (Windows primary, macOS secondary) for medical scribes. A scribe joins a doctor's Microsoft Teams consultation, the app silently captures system audio via loopback, transcribes it with ElevenLabs, and uses the **local `claude` CLI** (invoking bundled markdown "skills") to generate a per-doctor SOAP note, append ICD-10 codes, run a CDI (clinical documentation integrity) review, and export everything to `.docx`. All output lands in `~/Documents/AI Medical Notes/Cases/<session-date>/<patient>_<date>/` (two levels: a session-date folder containing per-patient case folders). The app is one process orchestrating a swarm of short-lived child processes (Python for audio/transcription/docx; `claude -p` for every AI step).

The forward roadmap ("Physician Assist") adds ~8 more **engines** that all hang off the same SOAP note — CDI, SOAP-validator, E/M scorer, Workers-Comp report, Prior-Auth letter, order generation, patient summary, and a quality/feedback meta-layer. See [docs/pa-planning/05-engines.md](../pa-planning/05-engines.md). **This roadmap is the single most important driver of the target architecture: the pipeline must become a place where engines drop in cleanly.**

---

## 2. The runtime dependency chain (what a user machine needs today)

This is the *real* cost of an install today (from `install.ps1` / `setup.ps1`):

| # | Dependency | Installed via | Why it's needed |
|---|---|---|---|
| 1 | **Git** | `winget Git.Git` | clone the repo + `git pull` auto-update |
| 2 | **Python 3.12** + pip packages | `winget Python.Python.3.12`, then `pip install -r requirements.txt` | audio capture, transcription, docx, attachment extraction |
| 3 | **Node.js LTS** | `winget OpenJS.NodeJS.LTS` | run `npm install`, `electron-rebuild` |
| 4 | **ffmpeg** | `winget Gyan.FFmpeg` | `pydub` WAV→MP3 conversion |
| 5 | **Visual C++ Build Tools (~4 GB)** | `winget Microsoft.VisualStudio.2022.BuildTools` | compile `pyaudiowpatch` (native) + rebuild `better-sqlite3` for Electron's ABI |
| 6 | **Claude CLI** + `claude login` | `irm https://claude.ai/install.ps1 \| iex`, then **manual login** | every AI step shells out to `claude -p` |
| 7 | **The repo itself** | `git clone` → `%LOCALAPPDATA%\Programs\AI Medical Scribe` | the app code + bundled skills |
| 8 | **better-sqlite3 native addon** | `npm install` + `npx electron-rebuild -f -w better-sqlite3` | the SQLite metadata store |
| 9 | **ElevenLabs API key** | typed into the app after launch → repo `.env` | transcription |

Plus: a Task Scheduler entry (run `electron.exe .` at logon), a Start-Menu shortcut, and a registry uninstall entry. Auto-update is `git pull --ff-only` on launch.

**Two facts that dominate the distribution and refactor design:**
- The install is heavy and developer-shaped (a ~4 GB build-tools download, a manual `claude login`, a live git checkout that must stay clean for `git pull`). It is the opposite of "feels like a normal app."
- **Every AI step depends on an authenticated `claude` CLI on the user's machine.** This is the hardest single dependency to package and the central fork for the whole refactor (see [04-distribution-and-updates.md](04-distribution-and-updates.md)).

---

## 3. The user flow & state machine

```
IDLE ──start-session──► SESSION_ACTIVE ──start-recording──► RECORDING ⇄ PAUSED
  ▲                          ▲   │                              │
  └────── stop-session ──────┘   │ (after patient name resolved)│ stop-recording
                                 └──────── PROCESSING ◄──────────┘
                          (PROCESSING is transient — just the patient-name form;
                           returns to SESSION_ACTIVE immediately, pipeline runs detached)
```

| State | Meaning | Enter via |
|---|---|---|
| `IDLE` | no active session | app start, Stop Session |
| `SESSION_ACTIVE` | doctor picked, ready to record | Start Session, after Save Case, after Discard |
| `RECORDING` | Python capturing audio | Start Recording |
| `PAUSED` | recording held (stdin `pause`) | Pause |
| `PROCESSING` | patient-name form open | Stop Recording (transient) |

The state machine is intentionally lightweight — it models only *user-controllable* flow, not the background pipeline. After a recording stops and the patient name is entered, state returns to `SESSION_ACTIVE` **immediately** so the scribe can start the next case while transcription/SOAP/ICD/CDI/docx run in the background for the previous one. The enum is **defined twice** — `STATE` in `main.js` and `STATE` in `renderer/renderer.js` — and they must stay in sync by hand.

---

## 4. The UI surface (every screen)

One main `BrowserWindow` (280×420, frameless, always-on-top, full taskbar entry) plus an optional floating **status window** (300×380). The renderer is a single state-driven file (`renderer/renderer.js`, 1,632 lines) that builds DOM imperatively. Screens/surfaces:

**Main window — bottom tab bar (3 tabs):**
1. **Record tab** (default) — the core flow. Shows, by state: a Start-Session button (IDLE); session-active controls with a **Pre-chart** button and a Start-Recording button; a running timer + Pause/Resume/Stop while RECORDING/PAUSED; the **patient-name form** (PROCESSING); plus a "view status" affordance for the floating window.
2. **Pre-chart tab** — "edit a note I already generated." Doctor select, recent-case picker (or Browse), instructions textarea, multi-file attach (`.md/.txt/.docx/.pdf`), Start button. Drives the `edit-note` skill.
3. **Templates tab** — per-doctor template management. List doctors; add/remove; **Create with AI** subview (pick name + ~50 sample notes → `create-doctor-profile` skill); **Update with AI** (pick doctor + typed/file corrections + optional samples → `update-doctor-profile` skill); assign/replace a template file; set per-doctor **specialty** (drives CDI ruleset).

**Overlays / sub-views (same window):**
- **Settings view** — ElevenLabs key (masked/edit), notes-dir picker, auto-record toggle, **Enable CDI + CDI mode**, advanced panel (SOAP model, template model, audio device select), doctor list editor.
- **Doctor picker** — shown on Start Session when >1 doctor.
- **Folder setup** — first-run notes-dir selection (new vs existing).
- **Upload form** — name a manually-uploaded audio file.
- **Banners** — setup-warning (yellow: BlackHole/Claude-CLI/record.py errors), service-warning (orange: ElevenLabs/Claude quota), template-job status banner (create/update/prechart progress).

**Floating status window** (`renderer/status.js`, separate renderer) — per-case background-pipeline progress: recording → transcribing → soap → icd → cdi → docx → done, with CDI flag-count/quality/approval badges and Open-Note / Open-CDI buttons. Multi-patient runs show one block per child case. It re-implements its own rendering of the same status payload the main renderer also handles.

---

## 5. The recording pipeline (the load-bearing flow)

```
Start Recording
  └─ spawn python/record.py --output <tmp>/rec_<ts>.mp3   (WASAPI loopback / BlackHole → WAV)
Stop Recording
  └─ write "stop\n" to record.py STDIN  (NOT kill — Windows TerminateProcess skips WAV→MP3)
     └─ Python flushes WAV → MP3 (pydub/ffmpeg), exits 0
  └─ show patient-name form; await submit
  └─ build case folder <NOTES_DIR>/Cases/<session-date>/<patient>_<date>/, move MP3 in
     (baseDir = activeSessionDir from createSessionFolder(), fallback to CASES_DIR when no session)
  └─ spawnTranscription → python/transcribe.py → transcript.md (ElevenLabs scribe_v2, diarised)
  └─ setState SESSION_ACTIVE   ◄── UI freed here; everything below runs detached
     │
     ▼ (on transcribe close)
  spawnSoapGeneration → claude -p "generate a note using template X and transcript Y"
     └─ generate-note skill writes one *_soap_note.md per patient + emits a JSON manifest (last line)
        └─ parseSkillManifest() → branch on multi_patient
           │
           ├─ single-patient: per the one case folder, run the post-processing chain:
           │     spawnIcdCoding  → add-icd-codes skill appends "## ICD-10-CM Codes" table  (best-effort)
           │     spawnCdiReview  → cdi-review skill writes <case>_cdi.json + .md + manifest (best-effort, gated)
           │     spawnDocxConversion(soap.md)  → .docx, mark case completed
           │     spawnDocxConversion(cdi.md)   → cdi .docx (if CDI succeeded)
           │
           └─ multi-patient: parent recording folder becomes an audit folder; for each child case:
                 mkdir <slug>_<date>/, copy mp3+transcript(+docx)+soap.md in, insert child DB row,
                 await spawnIcdCoding → spawnCdiReview (sequential across children),
                 then docx on child soap.md (+ cdi.md). Parent row marked completed, soap_note_path=NULL.
```

Key invariants: **non-blocking** (UI freed before transcription finishes); **detached spawn-chain** (each child only listens for its predecessor's `close`); **best-effort engines** (ICD/CDI failures log + emit `service-warning` but never block docx); **single log stream** (`<NOTES_DIR>/app.log`, tagged `[<case>][<phase>]`); **CDI runs sequentially after ICD** (it validates codes already in the note). The **audio-upload path** joins at `spawnTranscription`, so don't bake recording-specific assumptions there.

### The engine shape (critical for the refactor)

`spawnIcdCoding`, `spawnCdiReview`, and `spawnSoapGeneration` are three instances of the **same latent pattern**, today copy-pasted rather than abstracted:

```
build a structured prompt → spawnClaude(prompt, model, effort) → on close: parse output
  (manifest or terminal line) → record processing_events (tokens/cost) → write DB columns/rows
  → update in-memory status + broadcast → (best-effort) fall through to next step
```

The ~8 future PA engines are all this same shape (review engines flag; generation engines write a new artifact; a meta engine cross-reviews). **There is no engine abstraction today** — each is a bespoke 100–315-line function in `main.js`. Building that abstraction is the centerpiece of the refactor.

---

## 6. Background-job pipelines (template + pre-chart)

Three operations — **template-create**, **template-update**, **pre-chart edit-note** — share **one** background-job slot (`templateJobProc` global) and **one** persisted state file (`<NOTES_DIR>/.template_job.json`, with a `type` field). Only one runs at a time. Each is a `claude -p` invocation of a skill (`create-doctor-profile` / `update-doctor-profile` / `edit-note`). Stale `running` markers from a crash are reset to `failed` on launch. The renderer shows a status banner driven by the shared `template-job-status` IPC event.

---

## 7. Process & IPC model

```
Electron main (main.js) ── contextBridge (preload.js) ──► 2 renderers (renderer.js, status.js)
        │
        └── child_process.spawn ──► record.py · transcribe.py · md_to_docx.py · extract_attachments.py
                                    · claude -p (soap / icd / cdi / template×2 / edit-note) · git pull
```

The renderer has **no** Node/fs/child_process access — everything goes through `window.api` (preload). The IPC contract is **44 `ipcMain.handle` channels** (request/response) + 8 `send`/`on` event channels (`state-change`, `show-patient-form`, `setup-warning`, `service-warning`, `auto-start-recording`, `pick-doctor`, `template-job-status`, `recording-status-update`). Children are short-lived and unsupervised after spawn, **except** `record.py` (held in `recordingProcess` and stopped via stdin). Single-instance lock; close-to-minimize (only tray Quit / `before-quit` actually exits).

### The Node↔child string contracts (fragile coupling)

Communication with children is via **stringly-typed stdout/prompt contracts**, not structured APIs:
- **Skill prompt formats** — e.g. `generate a note using template "X" and transcript "Y"`; `review cdi. Case: … Specialty: … Mode: … Doctor: … Standards: …`. Each skill's Step 0 parses these by regex. Changing the spawn string without updating the SKILL.md (or vice versa) silently breaks the step.
- **Skill output contracts** — `generate-note` and `cdi-review` emit a **single-line JSON manifest** (parsed by `parseSkillManifest.js`, with an on-disk-JSON filesystem fallback for CDI); `add-icd-codes` emits `ICD_OK/ICD_SKIPPED/ICD_ERROR` lines; `edit-note` emits `BACKUP_OK: <path>`.
- **Python stdout contracts** — `record.py` prints `DURATION_SECONDS: <float>`; errors as `ERROR: …`; regexes scan transcribe/claude stderr for ElevenLabs 401/429 and Claude usage limits to route warnings.

These contracts are real and load-bearing but undocumented as a single surface and untyped. (See the consolidated coupling table in [01-problems.md](01-problems.md).)

---

## 8. State, config & data stores

| Store | Location | Owner | Holds |
|---|---|---|---|
| `.env` | repo root | app + user | `ELEVENLABS_API_KEY`, `NOTES_DIR_PATH` |
| `settings.json` | `<NOTES_DIR>` | app + user | `autoRecord`, device selection, `soapModel`, `templateModel`, `templateEffort`, `enableIcd`, `enableCdi`, `cdiMode` (doctors[] migrated out to DB; **invariant: `enableCdi` on ⟹ `enableIcd` on**) |
| `app.db` (SQLite, WAL) | `<NOTES_DIR>` | app only | `doctors`, `sessions`, `cases`, `processing_events`, `cdi_flags` (+ migrations) |
| `settings.doctors.backup.json` | `<NOTES_DIR>` | app once | one-time doctor backup at migration |
| `.template_job.json` | `<NOTES_DIR>` | app only | live/last background-job state |
| `.staging-marker` | install dir | installer | gitignored; flips STAGING badge/behavior |
| `.mcp.json` | `<NOTES_DIR>` | app only | ICD-10 MCP connector config (mirror of `notes-claude/.mcp.json`) |
| `.claude/` | `<NOTES_DIR>` | app (synced) | skills + standards, copied from repo `notes-claude/` every launch |
| `app.log` | `<NOTES_DIR>` | app appends | single log stream (main + all children) |

The **DB layer (`db/`) is already clean and modular** — a singleton connection, numbered SQL migrations gated by `PRAGMA user_version`, `try/catch` around every write (a failed DB write never breaks the pipeline), and one-time data migrations with backups. **This is the model the rest of the refactor should follow.** Files on disk remain canonical; the DB is a metadata + index store.

The **skills sync** is load-bearing: `notes-claude/` in the repo is the source of truth, copied to `<NOTES_DIR>/.claude/` on every launch and after every `git pull`. Never edit the runtime copy.

---

## 9. The code map today (where the bytes are)

| File | Lines | Role | Health |
|---|---:|---|---|
| `main.js` | **~3,550** | everything in the main process | ❌ monolith |
| `renderer/renderer.js` | **~1,660** | all main-window UI | ❌ monolith |
| `renderer/styles.css` | 1,265 | dark theme (single file) | ⚠ large |
| `python/md_to_docx.py` | 411 | markdown → docx | ⚠ duplicated (see below) |
| `python/record.py` | 378 | audio capture (Win/mac branches) | ⚠ |
| `renderer/index.html` | 360 | main-window markup | ⚠ |
| `renderer/status.css` | 260 | status-window styles | — |
| `notes-claude/scripts/md_to_docx.py` | 228 | **second copy** of md_to_docx | ❌ duplication |
| `db/cases.js` | 227 | cases table | ✅ clean module |
| `install*.ps1` | 221+244 | Windows installers | ⚠ heavy |
| `python/transcribe.py` | 140 | ElevenLabs STT | ⚠ |
| `renderer/status.js` | 141 | status-window UI | ⚠ dup rendering |
| `db/{init,doctors,sessions,events,cdi_flags}.js` | 122/108/52/67/79 | DB modules | ✅ clean |
| `python/extract_attachments.py` | 117 | combine prechart files | ⚠ |
| `tests/parseSkillManifest.test.js` | 117 | the **only** test | ⚠ lone |
| `preload.js` | 67 | IPC bridge | ✅ clean |
| `python/db_helper.py` | 42 | **scaffolded, unused** | ❌ dead |
| `parseSkillManifest.js` | 52 | manifest parser | ✅ clean, tested |

**The shape of the problem:** ~5,200 of ~10,400 LOC live in two files (`main.js` + `renderer.js`). The clean, testable parts (`db/`, `preload.js`, `parseSkillManifest.js`) are the small ones — and they prove the team already knows how to write good modules. The refactor is about making the big files look like the small ones.

`main.js` internal structure (by rough range; exact lines drift with commits): bootstrap/config/state/platform (~1–405) · recording+SOAP pipeline (~406–935) · post-processing engines ICD/CDI/docx (~936–1500) · template/prechart/auto-update jobs (~1500–2246) · windows/tray/lifecycle + in-memory status (~2247–2549) · one giant `registerIpcHandlers()` block, **44 handlers** (~2550–end).

---

## 10. Distribution, build & update — current reality

- **Build:** none. There is no build step, no bundler, no packaged artifact. The "app" is the git working tree run directly via `node_modules/electron/dist/electron.exe .`.
- **Install:** a ~11-step elevated PowerShell script (`install.ps1`) that winget-installs every dependency, clones the repo, `npm install` + `electron-rebuild`, registers a Task Scheduler autostart + Start-Menu shortcut + uninstall registry key, and tells the user to run `claude login` manually.
- **Update:** `git pull --ff-only` on every launch; if commits landed, re-sync skills and notify "restart to apply." Branch-agnostic (the clone's branch decides the channel).
- **Channels via branches:** `main` = production users; `staging` = devs running an installed build to exercise the update path; `develop` = integration. `cdi-v1` (current) is a feature branch about to merge to `develop`. Staging-ness is detected by a local `.staging-marker` file, never by branch name.
- **macOS:** secondary. `record.py` has a `sounddevice`/BlackHole branch and the app hides the dock icon, but there is no mac installer, no packaging, and several Windows-only conveniences (`attrib +h` file hiding, `py`/`python` resolution, Task Scheduler) simply no-op or don't apply.

**Net:** the current model works for a handful of closely-monitored users but cannot scale to "normal app" distribution. The redesign is in [04-distribution-and-updates.md](04-distribution-and-updates.md).

---

## 11. Production constraint (read before planning any migration)

The `main` branch is **installed and in active use by real scribes**, closely monitored. The refactor must not break their workflow. Acceptable migration cost: a ≤5-minute call where users quit/restart the app and run a few PowerShell commands; **worst case** a full uninstall/reinstall — *provided they keep using the same `~/Documents/AI Medical Notes` folder* (settings.json, app.db, Cases/, templates/). Any refactor step that touches on-disk formats, the DB schema, or the notes-dir layout must preserve or migrate that data. This constraint shapes the phasing in [03-migration-plan.md](03-migration-plan.md).

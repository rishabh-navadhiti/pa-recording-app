# 01 — Problems (what's wrong, and why it blocks the future)

> Distilled from a 13-agent subsystem analysis of the whole repo. Every claim here is grounded in a file:line the agents cited. This doc is the "why we're refactoring." The fixes are in [02-target-architecture.md](02-target-architecture.md); the ordering is in [03-migration-plan.md](03-migration-plan.md).
>
> Severity = impact on the three goals (maintainability, AI-testability, room-for-engines) **and** production risk. Two master tables (globals, contracts) lead — they're the root causes; everything else is downstream.

---

## The one-sentence diagnosis

`main.js` (3,530 lines) and `renderer.js` (1,632 lines) are two god-files coordinating through **~18 shared mutable globals** and **19 stringly-typed cross-process contracts**, with **<15% of the logic pure/testable** — so nothing can be unit-tested without booting Electron, and every new "engine" is copy-pasted rather than dropped in. The good news: the small modules the team already wrote (`db/`, `preload.js`, `parseSkillManifest.js`) prove the patterns to fix it are known; they just haven't been applied to the big files.

---

## Master table A — the ~18 shared mutable globals (root cause of untestability)

Every module-level mutable in `main.js`. These are the de-facto app state; every one of the ~50 functions can read/write them, which is exactly why nothing is isolatable.

| Global | Mutated by | The fix it forces |
|---|---|---|
| `currentState` | `setState` | a `StateMachine` with events, not a free var |
| `recordingProcess` + `tempMp3Path` | start/stop/discard-recording | a `RecorderController` owning the live child + stdin protocol |
| `patientNameResolver`, `doctorPickerResolver` | set in one IPC handler, **resolved in another** | the hardest anti-pattern here — a Promise stashed in a global so a *different* handler can resolve it; untestable, race-prone |
| `activeDoctorId`, `activeSessionId`, `activeSessionDir` | session handlers; **read inside spawn functions** | a `SessionStore` / `AppContext` threaded in (spawn funcs reaching back into session globals is the core coupling) |
| `pendingAudioDuration` | record.py stdout parse → consumed in stop-recording | side-channel via global between producer/consumer; should be returned, not stashed |
| `sessionRecordings` | 6 in-place mutators + 2 readers | a `RecordingsStore` with `serialize()` + `onChange` |
| `templateJobProc`, `templateJobStartMs`, `templateJobEventId` | 3 spawn funcs + cancel | a `JobRunner` (the "one at a time" invariant is implicit today) |
| `win`, `statusWin` | window factories | a guarded `renderer.send()` facade (~20 send sites, ~5 unguarded → crash risk at lines 459/464/592/672/2694) |
| `tray`, `isQuitting` | lifecycle | window/tray factory + lifecycle module |
| `NOTES_DIR`, `CASES_DIR`, `TEMPLATES_DIR`, `LOG_FILE` | `loadPaths` once + `change-notes-dir` | an injected `paths` object (the single most-read globals; `''` until `loadPaths` runs → ordering hazard) |
| `PYTHON` | resolved once in `whenReady` | a resolved value injected into a spawn helper (mutable `let` interpreter path is fragile) |

**Consequence:** spawn functions that *should* be pure, testable units (`spawnTranscription`, `spawnSoapGeneration`, the engines) reach back into `activeSessionId`, `NOTES_DIR`, `win`, and `sessionRecordings`. You cannot run one in a test without a real Electron window, a real SQLite file, and a real child process. **Killing these globals (via an injected `AppContext` + small stores) is the single highest-leverage move in the whole refactor.**

---

## Master table B — the 19 Node↔child string contracts (the system's real API, undocumented)

All cross-process coordination is shell-string prompts + stdout line-scraping, scattered as inline literals across 19 sites with no single source and no contract tests.

| # | Producer → Consumer | Contract | Fragility |
|---|---|---|---|
| 1 | main → generate-note | `generate a note using template "X" and transcript "Y"` | only `"` escaped (473); a path with a quote/backslash breaks it |
| 2 | generate-note → main | JSON manifest as last line | 3-layer parser + on-disk fallback (the reliable one) |
| 3 | main → add-icd-codes | `add ICD codes. Soap note: "<rel>".` | positional |
| 4 | add-icd-codes → main | `ICD_OK`/`ICD_SKIPPED`/`ICD_ERROR` stdout | substring match on combined stdout+stderr |
| 5 | main → cdi-review | `review cdi. Case: … Specialty: … Mode: … Doctor: … Standards: …` | **ordered positional markers**; a doctor name with `. ` could corrupt it |
| 6 | cdi-review → main | JSON manifest + `<case>_cdi.json` fallback | two-path recovery |
| 7 | main → create-doctor-profile | `create a doctor profile for "<name>" from source folder "<rel>"` | quote-delimited |
| 8 | main → update-doctor-profile | `… Doctor: … Template: … Corrections: <free text> CorrectionsFile: … Samples: …` | free-text mid-prompt; user text containing `Samples:` collides |
| 9 | main → edit-note | `edit note. Case: … Template: … Attachment: … Instructions: <free text>` | attachment path positional |
| 10 | edit-note → main | `BACKUP_OK: <path>` | single regex |
| 11 | record.py → main | `DURATION_SECONDS: <float>` | parsed in **two** Node sites (live + upload probe), duplicated regex |
| 12 | record.py → main | `ERROR: …` on stderr | generic prefix; any line starting "ERROR" misfires |
| 13 | main → record.py | `stop\n`/`pause\n`/`resume\n` to **stdin** | load-bearing protocol (Decision #1) — keep, but isolate |
| 14 | transcribe.py → main | stderr scanned for `401\|unauthorized` / `429\|quota` | ElevenLabs wording change silently breaks detection |
| 15 | md_to_docx.py → main | exit code + stdout path | cleaner (exit-code based) |
| 16 | extract_attachments.py → main | exit code + stdout path | OK |
| 17 | claude stream → main | `stream-json`: `ev.type==='result'`, `ev.usage`, `ev.total_cost_usd` | external CLI schema, undocumented/versioned |
| 18 | claude (all jobs) → main | rate-limit regex | **same regex literally duplicated 6×** (~580, ~1016, ~1201, ~1590, ~1729, ~2003; exact lines drift; count is verified) |
| 19 | claude (icd) → main | MCP-auth regex | matches prose in model output — false-positives on a note mentioning "401" |

**Consequence:** these are the product's actual integration surface, yet they live as scattered literals. A field-order change, a duplicated-regex edit-one-miss-five, or a patient name containing a shell metacharacter all break silently. **Fix: a `src/skills/contracts/` module** — `prompts.js` (typed builders, proper arg-encoding), `markers.js` (named regexes, single source), `manifest.js` (parser + per-engine validator) — with round-trip fixture tests. This is the highest test-ROI, lowest-prod-risk extraction.

---

## Safety bugs to fix first (independent of the refactor)

These are real defects the agents found while reading. Most are tiny, all are prod-relevant, and they should land as their own early commits (Phase 0) regardless of the larger work:

1. **Shell injection / corruption in `spawnClaude`** (main.js:~482–501) — `shell:true` + `prompt.replace(/"/g,'\\"')` only. Patient names, instructions, and **file paths** flow unescaped into a shell; a `$`, backtick, `;`, or backslash breaks or injects. *Fix:* spawn with an arg array, no `shell:true` — this happens properly in Phase 2 with the arg-array `claudeCliProvider`; opportunistically in Phase 0 if cheaply isolatable.
2. **Unguarded `win.webContents.send`** (~5 of 20 send sites) — lines 459, 464, 592, 672, and 2694 lack the `win && !win.isDestroyed()` guard the other ~15 sites have. The popup is a tray window that's usually closed; if transcription/SOAP fails while it's closed, main crashes. *Fix:* a single guarded `renderer.send()` facade.
3. **`open-soap-note` opens any renderer-supplied path** via `shell.openPath` (~3549) with no confinement to `CASES_DIR`.
4. **Inline `python -c` injection** in `process-audio-file` (~3403) — `audioDest` path is interpolated into a Python `-c` string; a path containing `"` breaks or injects Python.
5. **Migrations have no explicit transaction** (db/init.js `runMigrations`, bare `db.exec(sql)` per file) — a multi-statement migration that fails halfway commits partial DDL, and `ALTER TABLE ADD COLUMN`/`RENAME COLUMN` aren't idempotent, so the re-run throws "duplicate column" and **disables the whole DB layer**. This is the #1 production-migration risk and **must be hardened before any engine adds a table.** (Users just received the DB on `main` yesterday at `user_version=4` — get this right now.) *(Note: db/init.js carries a comment at the `db.exec` call claiming it runs in a transaction — that comment is aspirational; the code does not open one. Delete the comment as part of the fix.)*
6. **PII in `app.log`** — patient names, case slugs in every `[<caseTag>]` line, doctor names; plaintext, unrotated, beside the notes. Add a `redact()` layer.
7. **API key plaintext in repo `.env`**, read by both JS and Python, returned raw to the renderer (`getElevenLabsKey`). Move to OS keychain (DPAPI/Keychain) behind a `secretStore` when packaging.

---

## Per-subsystem problem summary

### main.js — the monolith (the bulk of the work)
- **God-functions:** `registerIpcHandlers()` ~979 lines / 44 handlers in one flat scope; `app.whenReady` ~185 lines doing ~10 jobs; `applyMultiPatientManifest` 207 lines / 7 responsibilities; `spawnCdiReview` 315 lines with 5 nested closures; `stop-recording` 104 lines / 6 responsibilities. Nearly the entire file (lines 2334–3530) is lexically nested inside the single-instance `if/else` — that's *why* it reads as a dump.
- **The latent engine pattern, copy-pasted:** `spawnIcdCoding`, `spawnCdiReview`, `spawnSoapGeneration` (+ transcribe/docx) all share a 7-step skeleton — surface UI stage → guard input → build prompt → `startEvent` → `spawnClaude` → classify+`finishEvent` → emit warning. The rate-limit regex, the service-warning block, the `patientFolderName ? updatePatientStatus : updateRecordingStatus` branch, and the DB try/catch boilerplate each appear 5–8×. **No engine abstraction exists.** This is the centerpiece (see 02 §"Engine framework").
- **Duplication hot-spots:** case-ingest (`stop-recording` vs `process-audio-file`); doctor resolution (3 inconsistent implementations); startup bootstrap (`whenReady` vs `change-notes-dir`, ~40 lines verbatim); 4 file-copy blocks; the recordings `serialize` projection (2×).
- **Inconsistent handler contracts:** 3 return styles (`{ok,error}`, bare string/null, bare value); ad-hoc/missing input validation.

### renderer.js — the second monolith
- ~1,660 lines, ~15 responsibilities, **no modules** (bare `<script>`); 106 `getElementById`, 74 `api.*` calls, all in one scope.
- `render(state)` (114 lines) **fuses the state machine with DOM construction**; `renderDoctorList` is a 150-line imperative builder; **4 copy-pasted file-list widgets**.
- Two competing visibility mechanisms (`.hidden` class vs inline `.style.display`) → real bugs. `settingsOpen` early-return **drops state pushes**. Rebinding `.onclick` on shared elements leaks closures.
- Feature-detects the IPC bridge in 4 places (`if (!api.x) return`) — a versioning smell.

### The IPC contract (preload + main)
- **44 `ipcMain.handle` channels + 8 event channels** (44 magic channel strings duplicated across preload and main with nothing keeping them in sync — the two surfaces currently *match*, but there is no mechanism enforcing that; a rename on one side is a silent hang on the other). **No validation/typing on any channel.** 44 flat methods, no namespacing. CLAUDE.md's IPC table is stale (`getBuildInfo`, `updateDoctorSpecialty` missing; `startPrechartJob` documented twice with conflicting arity; rows duplicated).

### The status window
- 91-line full-rebuild render (no diffing, loses scroll/focus); stage→label→color split across 3 files (main `STATUS_LABELS`, status.css classes, ad-hoc string literals) with no enum; **CDI is hard-coded** (`appendCdiUi`, flat `cdi*` fields) — does not generalize to N engines.

### Python workers
- **Two `md_to_docx.py` copies** (`python/` live 411 lines; `notes-claude/scripts/` stale 228 lines, dead) — delete the stale one.
- **Runtime `pip install --break-system-packages`** on ImportError inside the docx converter — a band-aid that mutates the user's global Python and only "fixes" one dep.
- `record_windows` 82-line mixed function; **macOS recording is second-class** (no 0-frames guard → silent empty MP3, no stop-in-callback, fixed 48 kHz, no device-name fallback). `transcribe.py` hardcodes `LOG_DIR=~/Documents/AI Medical Notes` (breaks for relocated notes folders). Brittle stdout contracts; no tests, no package boundary.

### Background jobs + auto-update
- Three job types share one ad-hoc lock + three globals (no queue, implicit "one at a time"). ~70% of the 3 spawn functions is identical. `checkForUpdates` is an **unguarded side-effect cascade with no rollback** (`git pull` → re-sync → `npm install` → `electron-rebuild`); a partial failure bricks `better-sqlite3` and the only safety net is the reinstall dialog. `copyDirSync` never deletes stale files (removed skills linger forever).

### DB layer (the good module, with 2 gaps)
- **The model to copy** (leaf modules, single `getDb()` seam, try/catch-everywhere, numbered migrations). Two real gaps: (a) **migrations not transactional** (see safety bug #6); (b) **the singleton isn't injectable**, so the layer can't be tested against an in-memory DB — the one seam (`__setDb(db)` / `initDbWith`) that would make all of `db/*` unit-testable in milliseconds.

### Skills + standards (the AI brain)
- **~200-line Python CDI renderer embedded inside the `cdi-review` prompt** (Step 8) — deterministic code the model must transcribe and run; burns tokens, can't be tested, drifts from its schema. Move to `python/render_cdi.py`.
- **Three different result protocols** across skills (JSON manifest / `ICD_OK:` markers / free prose / `Updated:` first line) — every new engine reinvents its return channel. Standardize on the manifest envelope.
- **Repo-internal leakage into runtime LLM context** — SKILL/standards files reference `main.js`, `parseSkillManifest`, the `cdi_flags` table, `app.log`, "(v1.1)"; `standards/README.md` hardcodes a **developer-machine absolute path** that ships to every user. `update-doctor-profile` recursively reads and "executes Steps 2–9 of" `create-doctor-profile/SKILL.md` (filesystem-level coupling). 5 skills duplicate a permission-setup heredoc that's a no-op under `--dangerously-skip-permissions`. Per-doctor data (real surnames) hardcoded in `orthopedics.md`.

### Distribution / build / update
See [04-distribution-and-updates.md](04-distribution-and-updates.md) in full. Headline: there's **no build artifact** — the "app" is a git working tree run via `electron.exe .`, requiring a ~4 GB dev toolchain + a manual `claude login` per machine, auto-updated by mutating the tree with `git pull` (no atomicity, no rollback, breaks on any force-push/local-edit/partial-rebuild).

---

## Cross-cutting gaps

- **Config sprawl:** 6 stores (`.env`, `settings.json`, `app.db`, `.template_job.json`, `.mcp.json`, `.staging-marker`) with no central layer; `readSettings()` called 20× (re-parsed each time); `MCP_CONFIG` is a *second* copy of `.mcp.json` (silent drift); `.env` read by both JS and Python.
- **Packaging blockers:** `__dirname`-rooted writable paths (`.env`, `.staging-marker`, `notes-claude`), the git-checkout assumption, and user-side `electron-rebuild` all assume a writable dev tree — incompatible with a signed `app.asar`.
- **Logging:** one flat `log()` (no levels, no structure, no rotation, no redaction); synchronous `appendFileSync` per line on the main thread. The real structured truth is already `processing_events` — lean on it.
- **Testing:** one test file (`parseSkillManifest.test.js`), no `"test"` script wired, no CI. ~85% of logic entangled with Electron/child_process/fs.
- **Dead code:** `python/db_helper.py` (unused), `notes-claude/draft/`, `notes-claude/scripts/md_to_docx.py` (stale), `launch.vbs` (abandoned for AV reasons).
- **Doc drift:** CLAUDE.md says `scribe_v1`; code uses `scribe_v2`. IPC table inaccurate. Re-baseline as part of the work.

---

## Why this blocks the future specifically

The roadmap ([docs/pa-planning/05-engines.md](../pa-planning/05-engines.md)) is **8+ more engines** (Workers Comp, Prior Auth, E/M scorer, SOAP validator, orders, patient summary, quality/feedback) plus an orchestrator. With today's structure, **each new engine means**: a new bespoke 100–300-line `spawnXxx` in the monolith, a 6th copy of the rate-limit regex, a new flat `xxx*` field set on the status entry + a new `appendXxxUi`, a new bespoke result protocol, a new hand-wired chain edit in two places, and zero tests. That doesn't scale to 8. The refactor's job is to make "add an engine" = **one descriptor file + one registry entry + one migration + one skill folder**, with the provider, status, persistence, and chaining all handled by shared infrastructure — and to make the provider itself swappable (you're still deciding Anthropic-API vs another vendor). That target is [02-target-architecture.md](02-target-architecture.md).

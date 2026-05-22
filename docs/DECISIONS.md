# Decisions

Append-only log of non-obvious technical choices. Latest at top. Don't edit old entries — supersede them with a new one if your view changes. Format:

```
## YYYY-MM-DD (initials) — <short title>
**Context:** what we were facing.
**Decision:** what we chose.
**Rejected:** what we didn't choose, briefly why.
**Implications:** what future code/docs need to respect.
```

---

## 2026-05-19 (rs) — CDI v1 ships as a standalone skill + markdown standards files

**Context:** Engine 1 (CDI Co-Pilot) is the next-week deliverable per Jayanth. Plan [docs/plans/2026-05-19-rs-cdi-v1-skill.md](plans/2026-05-19-rs-cdi-v1-skill.md) splits delivery into two PRs: Plan 1 = the skill + standards files (this entry), Plan 2 = app integration (`spawnCdiReview` in main.js, UI, DB writes — written *after* the skill is verified manually).

**Decision:** Ship CDI v1 as a `claude -p`-invocable skill at `notes-claude/skills/cdi-review/`, with reference content in a new `notes-claude/standards/` directory. The skill produces three outputs per case in the case folder: `<stem>_cdi.json` (canonical), `<stem>_cdi.md` (rendered from the JSON), and `<stem>_cdi.docx` (produced later by `python/md_to_docx.py`). The skill is **non-blocking** — a CDI failure must not break the downstream SOAP pipeline; the skill itself always tries to write *something*, even on parse error, so Plan 2's main.js always has a file to point to. v1 supports `orthopedics` only; other specialties produce a stub output with `error: "specialty not yet supported"` and exit cleanly (no generic universal-only fallback — settled in [docs/pa-planning/04-open-questions.md](pa-planning/04-open-questions.md) Round 2).

**Skill-level shape of standards consumption:** `standards/icd10_fy2026.md` (universal ICD-10), `standards/ahima_acdis_2026.md` (query compliance), `standards/specialties/<doctor.specialty>.md` (specialty-specific layered rules). Adding a specialty = drop a file. No code change. The standards files are designed to be reusable by future review engines (SOAP Validator, E/M Scorer, etc.) — each file's "Used by:" header tracks the dependency graph.

**Skill judgment calls made during implementation (consistent with the plan's "open items" latitude):**

- **Quality score formulas:** used the plan's defaults verbatim — `overall = max(0, 100 − 15C − 5W − 1S − 0O)`; specificity sub `= max(0, 100 − 12 * spec_flag_count)`; evidence sub `= round(avg(confidence) * evidence_factor)` where factor = 1.0 if every flag has ≥ 1 found AND ≥ 1 missing, else 0.85; completeness sub `= max(0, 100 − 12 * completeness − 8 * linkage)`. Simple, explainable, easy to retune after real-case testing.
- **Two-pass extraction prompting:** expressed as explicit two-step prompt instruction in `SKILL.md` Step 3 (Pass 1 = extract every Dx from HPI + transcript + objective + assessment + plan; Pass 2 = evaluate against rules). Not trusted to emerge from a single-shot prompt.
- **`medical_necessity_status` mapping:** explicitly defined — `supported` requires the note to address symptom duration + functional impact + prior-treatment outcome; `weak` if some elements present, others missing; `missing` if not addressed at all.
- **Example codes in `orthopedics.md`:** included a curated set against the common-traps section (G56.0x carpal tunnel, M65.3xx trigger finger, M17.1x knee OA, M75.1xx rotator cuff, etc.) — not exhaustive, but enough to anchor the LLM. Claude's training covers FY2026 codes well enough that an exhaustive listing would just bloat the standards file.
- **Standards file verbosity:** ~5 KB universal files, ~9 KB orthopedics pack. The LLM gets all three files plus the SOAP note plus transcript as context per invocation — concision matters, but ortho needs the room to cover Chapter 13 vs. 19, fracture coding, named tests, conservative therapy, and the 10 specificity traps.

**Rejected:** (1) Inline CDI rules in the skill prompt itself — would couple rule updates to skill edits; standards files let you bump the ICD-10 FY without touching the skill. (2) JSON-schema-driven validator step — overkill for v1; a single `python3 -m json.tool` validation pass plus one retry is sufficient. (3) Inpatient DRG-impact field in the schema — out of scope (we're outpatient); kept the field as `null` for forward-compat. (4) Generic universal-only fallback for unsupported specialties — rejected per Round 2 decision; CDI without a specialty pack risks more harm than help.

**Implications:**
- Don't edit content inside `<NOTES_DIR>/.claude/standards/` — it's overwritten from `notes-claude/standards/` on every app start (same as the skills sync). Edit the repo files.
- Adding a new specialty (cardiology, family medicine, ENT, etc.) requires only `notes-claude/standards/specialties/<name>.md` — no skill change. The skill's specialty gate in Step 1 checks for the file at runtime.
- Plan 2 will:
  - Add `spawnCdiReview` to main.js, mirroring the `spawnSoapGeneration` pattern (non-blocking).
  - Parse one of three terminal lines: `CDI_OK:`, `CDI_SKIPPED:`, `CDI_FAIL:`.
  - Extend `python/md_to_docx.py` for severity-coloured cells in the CDI docx.
  - Add per-doctor `specialty` + `enable_cdi` + `cdi_mode` settings (default: disabled until specialty is set).
  - Hide `*_cdi.md` and `*_cdi.json` on Windows (canonical view shows the docx only).
- **Test execution is not in this PR.** The implementing session documented six test scenarios in `notes-claude/skills/cdi-review/TESTS.md` as a checklist for the human to run after merge. Nested `claude -p` calls during implementation waste tokens, are slow, and don't catch the right issues — real-case verification by the user is the gate.

---

## 2026-05-18 (rs) — SQLite as a metadata + index store, not a content store

**Context:** App state lived in three places: the filesystem (case folders walked on every IPC call), `settings.json` (doctors array), and `app.log` (token usage as unqueryable text). Pre-chart "recent cases" rescanned the whole `Cases/` tree on every open. Token cost per case required grepping logs. Phase 2 features (CDI, evaluations) need queryable per-case state.

**Decision:** Introduce SQLite (`app.db` in `NOTES_DIR`) as a metadata + index store. Files on disk remain canonical (transcripts, soap notes, docx, MP3s). DB stores references to those files plus structured metadata and per-stage processing events with token usage. Four v1 tables: `doctors`, `sessions`, `cases`, `processing_events`. WAL mode, `better-sqlite3` in main process, `busy_timeout = 5000ms`. All write sites wrapped in `try/catch` — a failed DB write never blocks the recording pipeline. Schema versioned by `PRAGMA user_version`; migrations are numbered SQL files under `db/migrations/`. Doctors migrated from `settings.json` on first launch; backup written to `settings.doctors.backup.json`.

**Rejected:** Keeping everything in `settings.json` (not queryable, no relational history). Using a full ORM (unnecessary complexity for a local single-writer app). Storing file artifacts in the DB as blobs (breaks the "everything's a file in your notes folder" affordance for end users).

**Implications:** All doctor CRUD goes through `db/doctors.js`; `settings.json` no longer carries `doctors[]` after migration. Every spawn function (transcribe, soap, docx, template create/update, prechart) emits `startEvent`/`finishEvent` rows. `spawnClaude` passes the full parsed result event as a 4th `onClose` arg so token data reaches the DB. `record.py` prints `DURATION_SECONDS: <float>` on stop for `cases.audio_duration_seconds`.

## 2026-04-28 (rs) — `notes-claude/` is the source of truth for skills

**Context:** Skills live in `<NOTES_DIR>/.claude/skills/` at runtime so the local `claude` CLI can find them. But that folder is per-user data outside the repo, so edits there aren't versioned.

**Decision:** Bundle skills under `notes-claude/` in the repo. On every app start (and after every successful `git pull`), `copyDirSync` mirrors `notes-claude/` → `<NOTES_DIR>/.claude/`.

**Rejected:** Symlinking — fragile across Windows / shared drives. Telling users to clone into the notes-dir — couples app and data lifecycle.

**Implications:**
- Edit skills only in `notes-claude/`. Edits to `<NOTES_DIR>/.claude/` are silently overwritten on next launch.
- Adding a skill = drop a folder under `notes-claude/skills/`. No further wiring needed.
- The app's auto-update flow re-runs the sync after pulling, so users get new skills without restarting twice.

---

## 2026-04-28 (rs) — Template creation as a background job with persistent state

**Context:** AI template creation runs `claude -p` with Opus 4.7 at max effort — takes several minutes. The popup window can hide on blur, and users may close it during a job.

**Decision:** Treat it as a background job. Persist `{status, doctorName, lastname, startedAt, ...}` in `<NOTES_DIR>/.template_job.json`. Renderer reads on open + subscribes to `template-job-status` events. Only one job at a time (`templateJobProc !== null` lock). On startup, any `running` status from a prior run is rewritten to `failed` (the child died with the app).

**Rejected:** Modal in-popup progress — blocks the rest of the app. In-memory only — popup close loses state.

**Implications:** New long-running operations should follow the same pattern: a sentinel JSON file in NOTES_DIR + an IPC event channel + startup-cleanup of orphaned `running` states.

---

## 2026-04-28 (rs) — `settings.json` lives in `<NOTES_DIR>`, not in user prefs

**Context:** App config (doctors, models, audio device, autoRecord) needs somewhere to live.

**Decision:** Store as `<NOTES_DIR>/settings.json`. Travels with the notes folder if the user moves it. `NOTES_DIR_PATH` itself lives in `.env` since it has to be readable before settings can be loaded.

**Rejected:** `app.getPath('userData')` (Electron default) — orphans config when the user moves the notes folder; harder for the user to inspect/edit.

**Implications:** New persistent settings go in `DEFAULT_SETTINGS` ([main.js:77](../main.js#L77)). Don't scatter them across files.

---

## 2026-04-28 (rs) — Stop recording via stdin, not signal

**Context:** Stopping a recording must give Python time to flush WAV, convert to MP3 with pydub, and exit cleanly. On Windows, `process.kill()` translates to `TerminateProcess`, which doesn't run cleanup code.

**Decision:** `stop-recording` writes `stop\n` to the Python process's stdin. A reader thread inside `record.py` sets a `threading.Event` the recording loop polls. `pause` and `resume` use the same channel.

**Rejected:** `SIGTERM` / `SIGBREAK` — unreliable on Windows when fired from Node. `kill()` — no clean shutdown on Windows.

**Implications:**
- DO NOT replace the stdin write in `stop-recording` / `discard-recording` with `.kill()`.
- Any future control commands to record.py go through the same stdin protocol.
- `before-quit` is the one place we *do* `.kill()` — when the app is dying anyway and a clean shutdown isn't worth blocking on.

---

## 2026-04-28 (rs) — Platform-split audio capture: PyAudioWPatch + sounddevice

**Context:** `pyaudio` (the common Python audio lib) has no native WASAPI loopback. `pyaudiowpatch` is a maintained fork that does. On macOS, the standard solution is BlackHole + a Multi-Output Device, accessed via `sounddevice`. The two libs conflict if installed together.

**Decision:** `requirements.txt` uses platform markers — `pyaudiowpatch` only on win32, `sounddevice` only on darwin. `record.py` branches on `sys.platform`.

**Rejected:** Cross-platform abstraction (e.g. `python-soundcard`) — less reliable on Windows for loopback. Bundling a virtual driver on Windows — unnecessary, WASAPI loopback is built in.

**Implications:** Two code paths to keep aligned. When changing the recording loop (formats, stop semantics, error reporting), update *both* branches.

---

## 2026-04-28 (rs) — Non-blocking pipeline: return to SESSION_ACTIVE before transcription

**Context:** Scribes do back-to-back consultations. Waiting for transcription + SOAP generation between cases would dead-time them.

**Decision:** `stop-recording` builds the case folder, kicks off transcription, and immediately sets state back to `SESSION_ACTIVE`. The pipeline runs detached (each child only listens for its predecessor's `close`).

**Rejected:** Synchronous PROCESSING state until SOAP note ready — kills throughput. Job queue with explicit progress UI — overkill for a single-user app.

**Implications:**
- The state machine is intentionally lightweight — it only models user-controllable flow, not the pipeline.
- Errors from transcribe/soap/docx must surface via `service-warning` (or notifications) since the state has already moved on.
- Don't put pipeline status into `currentState` — it's case-scoped, not session-scoped.

---

## 2026-04-28 (rs) — Auto-update via `git pull` on startup

**Context:** Users are scribes, not engineers. They install once and the app should self-update.

**Decision:** Run `git pull --ff-only` in the repo on every launch. If new commits land, re-sync skills and notify the user to restart. All failures logged and ignored — never blocks startup.

**Rejected:** Electron auto-updater — overhead for a small, internal-distribution app. Manual update instructions — users won't follow them.

**Implications:** The repo dir must remain a clean working tree on user machines. If we ever ship a build that requires user-side data migration, we need a startup version-check that runs before the app uses the data.

---

## 2026-04-28 (rs) — Single bundled skill prompt format

**Context:** The skills (`generate-note`, `create-doctor-profile`) are invoked by string prompts to `claude -p`. Their parsing is regex-ish.

**Decision:** Keep the prompt format strict and documented in CLAUDE.md and ARCHITECTURE.md:
- `generate a note using template "X" and transcript "Y"` (template optional)
- `create a doctor profile for "<name>" from source folder "<rel>"`

**Implications:** Don't change the spawn-side string in main.js without updating Step 0/1 of the corresponding SKILL.md, and vice versa. They're a contract.

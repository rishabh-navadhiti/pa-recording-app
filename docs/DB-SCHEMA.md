# DB Schema — column-level reference

Canonical column-by-column reference for the SQLite database that backs the AI Medical Scribe app. Use this when writing debug queries, planning a migration, or making sense of an unexpected row.

For the high-level summary, see [ARCHITECTURE.md § DB schema overview](ARCHITECTURE.md#db-schema-overview). For *why* the DB exists at all and what's intentionally not in it, see the 2026-05-18 entry in [DECISIONS.md](DECISIONS.md).

---

## 1. Overview

| Aspect | Value |
|---|---|
| Path | `<NOTES_DIR>/app.db` (where `<NOTES_DIR>` is the user-picked notes folder, e.g. `~/Documents/AI Medical Notes/`) |
| Engine | SQLite, accessed via `better-sqlite3` from the Electron main process only |
| Journal mode | WAL (`PRAGMA journal_mode = WAL`) |
| Companion files | `app.db-wal`, `app.db-shm` (auto-managed; safe to delete when the app is closed) |
| FK enforcement | `PRAGMA foreign_keys = ON` |
| Busy timeout | 5000 ms |
| Schema version | Tracked via `PRAGMA user_version`. Latest = `3`. |
| Migration files | `db/migrations/NNN_<name>.sql`, run in numeric order, only when `file_version > user_version` |

**"DB never breaks the pipeline."** Every write in `db/*.js` is wrapped in `try/catch` and logs failures. If `app.db` is missing, locked, or otherwise unwritable, the recording → transcription → SOAP → ICD → CDI → DOCX pipeline still completes; only the metadata index is degraded. This is intentional — see DECISIONS.md (2026-05-18).

**"Safe to delete."** `app.db` is an index, not a content store. Canonical artifacts (transcripts, SOAP notes, MP3s, .docx) live as files in `<NOTES_DIR>/Cases/`. Deleting `app.db` while the app is closed is recoverable: on next launch, `db/init.js` recreates the schema from migrations, and `tryRestoreDoctorsFromBackup()` re-populates `doctors` from `<NOTES_DIR>/settings.doctors.backup.json` (written once during first-launch migration). Sessions/cases/events history is lost — accept the trade-off only if you mean to.

**Migration mechanics** (`db/init.js`):

1. On every app start, `initDb(notesDir)` opens the DB and calls `runMigrations(db)`.
2. `runMigrations` reads `PRAGMA user_version` (defaults to 0 on a fresh DB), lists `db/migrations/NNN_*.sql` sorted numerically, and `db.exec()`'s each file whose `NNN > user_version`.
3. Each migration file ends with `PRAGMA user_version = N;` to advance the marker. better-sqlite3 runs the whole file as one statement batch — no explicit transaction wrapping (WAL mode handles this correctly for the small DDL we have).
4. A separate one-time post-step (`migrateDoctorsFromSettings`) moves `settings.json.doctors[]` into the `doctors` table on first launch and writes `settings.doctors.backup.json`. Idempotent — checks `COUNT(*) FROM doctors` before doing anything.

**Inspection from the shell** (app must be closed or in read-only mode):

```bash
sqlite3 ~/Documents/AI\ Medical\ Notes/app.db 'PRAGMA user_version;'
sqlite3 ~/Documents/AI\ Medical\ Notes/app.db '.schema'
sqlite3 ~/Documents/AI\ Medical\ Notes/app.db 'PRAGMA table_info(cases);'
sqlite3 ~/Documents/AI\ Medical\ Notes/app.db 'PRAGMA foreign_key_list(cases);'
sqlite3 ~/Documents/AI\ Medical\ Notes/app.db 'PRAGMA index_list(cases);'
```

For interactive use, see [§ 5. Inspecting via Beekeeper Studio](#5-inspecting-via-beekeeper-studio) below.

---

## 2. ER diagram

```
┌──────────┐           ┌────────────┐
│ doctors  │           │  sessions  │
│──────────│           │────────────│
│ id (PK)  │◀──────────│ doctor_id  │  (FK, ON DELETE SET NULL)
│ ...      │           │ id (PK)    │
└──────────┘           │ ...        │
     ▲                 └────────────┘
     │                       ▲
     │                       │
     │                       │
     │                 ┌────────────────┐
     │                 │     cases      │
     │                 │────────────────│
     └─────────────────│ doctor_id  FK  │  (FK, ON DELETE SET NULL)
                       │ session_id FK  │  (FK, ON DELETE SET NULL)
                       │ id (PK)        │
                       │ case_dir UNIQ  │
                       │ ...            │
                       └────────────────┘
                              ▲    ▲
                              │    │
                              │    │
                ┌─────────────┘    └───────────────────┐
                │                                      │
       ┌─────────────────────┐               ┌──────────────────┐
       │ processing_events   │               │    cdi_flags     │
       │─────────────────────│               │──────────────────│
       │ case_id FK          │  (CASCADE)    │ case_id FK       │  (CASCADE)
       │ related_doctor_id FK│ (SET NULL)    │ cdi_run_id FK ───┼─→ processing_events.id (SET NULL)
       │ id (PK, autoinc)    │               │ id (PK, autoinc) │
       │ job_kind            │               │ flag_index       │
       │ ...                 │               │ ...              │
       └─────────────────────┘               └──────────────────┘
```

Foreign-key cardinality:

- A **doctor** has many **sessions** (via `sessions.doctor_id`); nullable — a session can exist with `doctor_id = NULL`.
- A **doctor** has many **cases** (via `cases.doctor_id`); nullable.
- A **session** has many **cases** (via `cases.session_id`); nullable — uploaded cases bypass the session machinery.
- A **case** has many **processing_events** (via `processing_events.case_id`); nullable on the event side — template-create / template-update events have no case.
- A **case** has many **cdi_flags** (via `cdi_flags.case_id`); NOT NULL on the flag side.
- A **processing_events** row may have many **cdi_flags** pointing to it via `cdi_flags.cdi_run_id`; nullable — the flag still exists if the event was never recorded.

---

## 3. Per-table reference

### 3.1 `doctors`

Per-doctor identity, template assignment, specialty (for CDI), and the CDI enable flag. The CDI on/off lives here as a column but is **not** the user-facing toggle — that's the global `enableCdi` in `settings.json`. This column is effectively dormant in v1; kept for forward-compatibility.

**Created by:** migration `001_init.sql`.
**Written by:** `db/doctors.js` — `upsertDoctor()`, `removeDoctor()`, `updateDoctorTemplate()`, `updateDoctorSpecialty()`. Initially populated by `migrateDoctorsFromSettings()` in `db/init.js` from the legacy `settings.json.doctors[]` array.

| Column | Type | Nullable | Default | Meaning |
|---|---|---|---|---|
| `id` | TEXT (PK) | no | — | Doctor ID. Preserves the **legacy string IDs from `settings.json`** (e.g. `"1779717259717"` — these were `Date.now()` timestamps). NEW doctors added after migration also use timestamp strings (see `add-doctor` IPC handler). Not UUIDs. |
| `name` | TEXT | no | — | Display name, e.g. `"Dr. Smith"` or `"Smith"`. Free text the user typed. |
| `lastname` | TEXT (UNIQUE) | no | — | Lowercase last name, e.g. `"smith"`. Derived by `extractLastname()` in main.js. Used to find the template file (`templates/<lastname>.md`) and embedded in skill prompts. |
| `specialty` | TEXT | yes | NULL | Lowercase specialty key matching a standards file (`notes-claude/standards/specialties/<specialty>.md`). v1: only `"orthopedics"` is supported. NULL = no specialty set → CDI gate fails → `cdi_status='skipped'`. Set via the Templates tab UI. |
| `template_path` | TEXT | yes | NULL | Absolute path to this doctor's template `.md` file, conventionally `<NOTES_DIR>/templates/<lastname>.md`. NULL is rare — only when a doctor was added but no template ever assigned. |
| `enable_cdi` | INTEGER (0/1) | no | `0` | Per-doctor CDI flag, dormant in v1. The user-facing CDI toggle is global (`settings.json` → `enableCdi`). Keep this at `0` unless a future feature surfaces it. |
| `created_at` | TEXT | no | — | ISO 8601 UTC timestamp at insertion. |
| `updated_at` | TEXT | no | — | ISO 8601 UTC timestamp; bumped on every update. |

**Indexes:**
- `idx_doctors_lastname` (UNIQUE on `lastname`) — fast lookup by `getDoctorByLastname()`; also enforces no two doctors share a lastname.

**Gotchas:**
- `doctors.id` is NOT a UUID. Legacy string IDs from `settings.json` survive verbatim (`"1779717259717"`). When debugging FKs, expect mixed-format IDs across tables: `doctors.id` is a timestamp string, while `sessions.id`, `cases.id` are full UUIDs (e.g. `"a3f1c4d8-..."`).
- `lastname` is **unique** by index. The migration runs `INSERT OR IGNORE`, so a duplicate-lastname doctor in `settings.json` would have been silently dropped — check the backup file if a doctor seems missing post-migration.
- Setting `specialty = ''` is treated as NULL (`updateDoctorSpecialty` trims to NULL).

---

### 3.2 `sessions`

A "session" = one Start Session → Stop Session cycle. Each session corresponds to one folder on disk (the recording folder), which may contain N cases (back-to-back recordings).

**Created by:** migration `001_init.sql`.
**Written by:** `db/sessions.js` — `startSession()` on `start-session` IPC, `endSession()` on `stop-session`, `bumpSessionCounters()` from case-status close handlers when a case reaches `completed` or `failed`.

| Column | Type | Nullable | Default | Meaning |
|---|---|---|---|---|
| `id` | TEXT (PK) | no | — | UUID (Node `crypto.randomUUID()`). |
| `session_folder` | TEXT (UNIQUE) | no | — | Absolute path to the session's recording folder on disk. Uniqueness enforced — re-using a session folder is not supported. |
| `doctor_id` | TEXT | yes | NULL | FK → `doctors.id`. Set when Start Session resolves a doctor. NULL only if the session was created before doctor selection (shouldn't happen in v1). |
| `started_at` | TEXT | no | — | ISO 8601 UTC at Start Session. |
| `ended_at` | TEXT | yes | NULL | ISO 8601 UTC at Stop Session. NULL = session still active or was abandoned (crash, force-quit). |
| `case_count` | INTEGER | no | `0` | Count of cases that reached a terminal state (completed OR failed) attributed to this session. Bumped by `bumpSessionCounters()` in case-status close handlers. |
| `failed_count` | INTEGER | no | `0` | Subset of `case_count` whose terminal state was `failed`. |
| `created_at` | TEXT | no | — | ISO 8601 UTC at row insertion. |
| `updated_at` | TEXT | no | — | ISO 8601 UTC; bumped on every update. |

**FK constraints:**
- `doctor_id` → `doctors.id` ON DELETE SET NULL. (Removing a doctor doesn't delete their session history; the link breaks.)

**Indexes:**
- `idx_sessions_started_at` (`started_at DESC`) — recent-sessions queries.
- `idx_sessions_doctor` (`doctor_id, started_at DESC`) — "sessions for doctor X by date".

**Gotchas:**
- `case_count` includes failed cases. `case_count - failed_count` is the success count.
- `ended_at IS NULL` for any in-flight or crashed session. Useful as a "did the app crash mid-session?" probe on next startup.
- Uploaded cases (`cases.source = 'upload'`) bypass sessions entirely → those cases have `cases.session_id = NULL`.

---

### 3.3 `cases`

The richest table. One row per case (a single patient encounter, or the audit row for a multi-patient recording). Tracks file paths to every artifact on disk, the pipeline status, and (since migration 003) the CDI summary fields.

**Created by:** migration `001_init.sql`; CDI columns added by migration `003_add_cdi_tables.sql`; `audio_duration_seconds` renamed to `audio_duration` (REAL → TEXT) in migration `002_rename_duration.sql`.
**Written by:** `db/cases.js` — `createCase()` (single-patient parent + uploads), `createChildCase()` (multi-patient child), `updateCaseAudio()`, `updateCasePaths()`, `setCaseStatus()`, `bumpCaseRevision()` (pre-chart), `updateCaseCdi()`.

| Column | Type | Nullable | Default | Meaning |
|---|---|---|---|---|
| `id` | TEXT (PK) | no | — | UUID. |
| `patient_name` | TEXT | yes | NULL | Sanitized patient name (lowercase, `_`-separated). NULL if the scribe skipped the name form. For multi-patient parent rows: the audit-row patient name is set to the parent recording-folder slug (rare to query). |
| `doctor_id` | TEXT | yes | NULL | FK → `doctors.id`. Carried from the session at case creation. Children inherit from parent. |
| `session_id` | TEXT | yes | NULL | FK → `sessions.id`. NULL for uploads. |
| `case_dir` | TEXT (UNIQUE) | no | — | Absolute path to the case's folder on disk, e.g. `<NOTES_DIR>/Cases/<patient>_<YYYY-MM-DD>/`. For multi-patient: parent row = recording folder; child rows = per-patient sub-folders next to it. |
| `source` | TEXT | no | — | `'recording'` (came from Start/Stop Recording) or `'upload'` (came from the audio-file upload flow). |
| `mp3_path` | TEXT | yes | NULL | Absolute path to the audio file. Populated by `createCase` from the renamed temp MP3. |
| `audio_duration` | TEXT | yes | NULL | Audio length as `HH:MM:SS`. Computed by `formatDuration()` in `db/cases.js` from the `DURATION_SECONDS: <float>` line that `record.py` prints on stop. NULL if the case is too early in the pipeline or `record.py` didn't emit the line. **NOTE: this column was a REAL named `audio_duration_seconds` in migration 001; renamed in migration 002.** |
| `audio_size_bytes` | INTEGER | yes | NULL | File size of `mp3_path` in bytes. |
| `transcript_path` | TEXT | yes | NULL | Absolute path to `transcript.md`. Populated when the transcribe step succeeds. |
| `transcript_docx_path` | TEXT | yes | NULL | Absolute path to `transcript.docx`. Populated when the transcript→docx step succeeds. |
| `soap_note_path` | TEXT | yes | NULL | Absolute path to `<case>_soap_note.md`. Populated by the soap-step success handler. **For multi-patient parent (audit) rows: stays NULL.** |
| `soap_docx_path` | TEXT | yes | NULL | Absolute path to `<case>_soap_note.docx`. Populated by the soap docx-conversion success handler. |
| `status` | TEXT | no | — | Pipeline status (see enum below). Initial = `'transcribing'`. |
| `revision` | INTEGER | no | `1` | Bumped by `bumpCaseRevision()` after each successful pre-chart edit (one revision per pre-chart). Starts at 1. |
| `recorded_at` | TEXT | no | — | ISO 8601 UTC at recording stop (single-patient) or at child-folder creation (multi-patient children inherit from parent). |
| `completed_at` | TEXT | yes | NULL | ISO 8601 UTC when status flipped to `completed` (i.e., docx success). NULL until then. |
| `last_edited_at` | TEXT | yes | NULL | ISO 8601 UTC of the most recent pre-chart success. NULL if the case has never been pre-charted. |
| `created_at` | TEXT | no | — | ISO 8601 UTC at row insertion. |
| `updated_at` | TEXT | no | — | ISO 8601 UTC; bumped on every update. |
| `cdi_status` | TEXT | yes | NULL | CDI run status (see enum below). NULL = CDI never attempted on this case. |
| `cdi_mode` | TEXT | yes | NULL | The CDI mode the run used: `'compliance'`, `'balanced'`, or `'aggressive'`. Reflects the global setting at the time of the run. |
| `cdi_json_path` | TEXT | yes | NULL | Absolute path to `<case>_cdi.json` — the canonical CDI output. Always written when `cdi_status IN ('completed', 'skipped')`. |
| `cdi_md_path` | TEXT | yes | NULL | Absolute path to `<case>_cdi.md` — the human-readable rendering. |
| `cdi_docx_path` | TEXT | yes | NULL | Absolute path to `<case>_cdi.docx`. Populated only on `cdi_status='completed'` after the CDI docx conversion succeeds. |
| `cdi_quality_score` | INTEGER | yes | NULL | Overall quality score from the CDI summary, 0–100. From `summary.overall_quality_score` in the CDI JSON. |
| `cdi_medical_necessity` | TEXT | yes | NULL | `'supported'`, `'weak'`, or `'missing'`. From `summary.medical_necessity_status`. |
| `cdi_claim_defense_readiness` | TEXT | yes | NULL | `'ready'`, `'needs_edits'`, or `'hold_for_review'`. From `summary.claim_defense_readiness`. |
| `cdi_clinician_approval_required` | INTEGER (0/1) | yes | `0` | From `summary.clinician_approval_required`. `1` = case has a `critical` flag or hard rule violation that mandates clinician sign-off. |

**FK constraints:**
- `doctor_id` → `doctors.id` ON DELETE SET NULL.
- `session_id` → `sessions.id` ON DELETE SET NULL.

**Indexes:**
- `idx_cases_recorded_at` (`recorded_at DESC`) — recent-cases listings (pre-chart, status window).
- `idx_cases_doctor_recorded` (`doctor_id, recorded_at DESC`) — per-doctor history.
- `idx_cases_session` (`session_id, recorded_at`) — list cases in a session in order.
- `idx_cases_status` (`status`) — find stuck / failed cases quickly.

**`status` enum (pipeline state):**

```
transcribing → generating_note → converting → completed
                                            ↓
                                          failed   (terminal; can happen at any earlier stage)
```

- `transcribing` — set at `createCase`. record.py done, MP3 in case folder, transcribe.py spawned.
- `generating_note` — set when transcribe.py exits 0. SOAP-generation skill spawned.
- `converting` — set when the SOAP `.md` is on disk. docx conversion(s) running. For multi-patient children, `createChildCase` inserts directly at `'converting'`.
- `completed` — set by docx success handler. `soap_docx_path` populated, `completed_at` set.
- `failed` — any stage's failure path sets this. Doesn't transition out (a re-attempt would require manual intervention or a future "resume" feature).

**`cdi_status` enum:**

| Value | Meaning |
|---|---|
| NULL | CDI never attempted on this case. (CDI was added in migration 003; pre-existing cases will have NULL forever unless rerun.) |
| `'running'` | CDI Claude invocation in flight. Set at spawn, before Claude returns. |
| `'completed'` | Skill emitted `CDI_OK:` terminal line; JSON + MD on disk; flags inserted into `cdi_flags`. |
| `'skipped'` | CDI was gated off (`enableCdi=false`, doctor has no specialty, or specialty has no standards file). Stub `_cdi.{json,md}` files written by main.js for UI consistency. |
| `'failed'` | Skill non-zero exit, no terminal line, or `CDI_FAIL:`. Best-effort: pipeline still continues to DOCX. |

**Gotchas:**

- **Multi-patient parent rows are audit rows.** `soap_note_path = NULL`, all `cdi_*` columns NULL, no `cdi_flags` rows. Children (next-to-parent sub-folders) carry the real data. Detect parents by `soap_note_path IS NULL AND source = 'recording'`. Detect children by their `case_dir` sitting adjacent to a parent's `case_dir` — or just by `soap_note_path IS NOT NULL`.
- **`audio_duration` is TEXT (`HH:MM:SS`)**, not a number. Migration 002 renamed the column away from `audio_duration_seconds` (REAL). Any old code or query that expects a numeric column will silently get `null`-coerced strings.
- **`revision` increments only on pre-chart success.** A failed pre-chart attempt does NOT bump it.
- **`completed_at` reflects SOAP docx, not CDI.** CDI runs sequentially between SOAP and docx, but `completed_at` is set by the docx success handler. So `completed_at IS NOT NULL` does NOT imply CDI succeeded — check `cdi_status` for that.
- **`mp3_path` for uploads** is the path inside the case folder (where the file was copied), not the original picker path.

---

### 3.4 `processing_events`

One row per spawned subprocess that does meaningful work — transcribe.py, the SOAP-generation Claude invocation, ICD coding, CDI review, docx conversion, pre-chart, template create/update. Captures wall-clock timing, model used, token usage, cost, and the error message (truncated) on failure.

**Created by:** migration `001_init.sql`. No CDI-specific columns — CDI just uses `job_kind = 'cdi'`.
**Written by:** `db/events.js` — `startEvent()` before each spawn, `finishEvent()` in the close handler.

| Column | Type | Nullable | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER (PK, AUTOINCREMENT) | no | — | Surrogate key. The only non-TEXT/non-UUID PK in the DB. Used as the FK target from `cdi_flags.cdi_run_id`. |
| `case_id` | TEXT | yes | NULL | FK → `cases.id`. NULL for template-create / template-update events (no case). For SOAP in multi-patient runs: attached to the **parent** case_id (one Claude invocation across all patients). ICD/CDI/docx events in multi-patient runs are **per-child**. |
| `job_kind` | TEXT | no | — | One of: `transcribe`, `soap`, `icd`, `cdi`, `docx`, `prechart`, `template_create`, `template_update`. Source of truth for "what was this process doing?". |
| `related_doctor_id` | TEXT | yes | NULL | FK → `doctors.id`. Set for template/CDI/ICD/prechart events so cost can be sliced per-doctor without joining `cases`. |
| `status` | TEXT | no | — | Lifecycle state (see enum below). Set to `'started'` by `startEvent()`. Updated by `finishEvent()` to `'success'` or `'failed'`. |
| `model_used` | TEXT | yes | NULL | The `--model` flag passed to `claude -p`, e.g. `'claude-sonnet-4-6'` or `'claude-opus-4-7'`. NULL for non-Claude events (transcribe, docx). |
| `effort` | TEXT | yes | NULL | The `CLAUDE_CODE_EFFORT_LEVEL` env var, e.g. `'high'` or `'max'`. NULL when not set. |
| `input_tokens` | INTEGER | yes | NULL | From the Claude CLI's `result` stream-json event (`usage.input_tokens`). NULL for non-Claude jobs or when the stream failed before the result event. |
| `output_tokens` | INTEGER | yes | NULL | Same source, `usage.output_tokens`. |
| `cache_read_tokens` | INTEGER | yes | NULL | `usage.cache_read_input_tokens`. |
| `cache_created_tokens` | INTEGER | yes | NULL | `usage.cache_creation_input_tokens`. |
| `cost_usd` | REAL | yes | NULL | `total_cost_usd` from the same result event. Same field used by `[<label>][usage]` log lines. |
| `num_turns` | INTEGER | yes | NULL | `num_turns` from the result event. Counts assistant turns. |
| `duration_ms` | INTEGER | yes | NULL | Wall-clock duration; for Claude jobs preferred to read from `duration_ms` in the result event; for non-Claude jobs computed from `Date.now() - wallStart`. |
| `error_message` | TEXT | yes | NULL | First 1024 chars of stderr (truncated by `finishEvent`). Populated when `status='failed'`. |
| `backup_path` | TEXT | yes | NULL | Absolute path to a backup file the job wrote, e.g. the `BACKUP_OK:` line from the edit-note (pre-chart) skill or the update-doctor-profile skill. |
| `started_at` | TEXT | no | — | ISO 8601 UTC at spawn. |
| `finished_at` | TEXT | yes | NULL | ISO 8601 UTC at close handler. NULL = job still running (or crashed without `finishEvent`). |

**FK constraints:**
- `case_id` → `cases.id` ON DELETE CASCADE. (Deleting a case removes its event history.)
- `related_doctor_id` → `doctors.id` ON DELETE SET NULL.

**Indexes:**
- `idx_events_case` (`case_id, started_at`) — full event timeline for one case.
- `idx_events_kind_started` (`job_kind, started_at DESC`) — "recent SOAP runs", "recent CDI runs".
- `idx_events_doctor_kind` (`related_doctor_id, job_kind, started_at DESC`) — per-doctor cost by job_kind.

**`status` enum:**

- `'started'` — inserted by `startEvent`. The job is running (or was running when the app crashed).
- `'success'` — set by `finishEvent` when the close handler considers the job a success. For CDI specifically, "success" can also mean "skill emitted CDI_SKIPPED cleanly".
- `'failed'` — set by `finishEvent` on any failure path. `error_message` is populated.

**`job_kind` enum** (exact strings used in `startEvent` calls — see [main.js:396](../main.js#L396) and friends):

| Value | What it is | Has `case_id`? |
|---|---|---|
| `transcribe` | python/transcribe.py invocation. | yes |
| `soap` | `generate-note` skill via `claude -p`. | yes (parent in multi-patient runs) |
| `icd` | `add-icd-codes` skill via `claude -p`. | yes (per child in multi-patient runs) |
| `cdi` | `cdi-review` skill via `claude -p`. | yes (per child in multi-patient runs) |
| `docx` | python/md_to_docx.py invocation. | yes |
| `prechart` | `edit-note` skill via `claude -p` (pre-chart sub-flow). | yes |
| `template_create` | `create-doctor-profile` skill. | **no** (`case_id = NULL`) |
| `template_update` | `update-doctor-profile` skill. | **no** (`case_id = NULL`) |

**Gotchas:**

- **Soap event in multi-patient runs is attached to the parent case_id** — there's only one Claude invocation that produces N patient notes. ICD, CDI, and docx events are per-child (one each per child case). When computing per-patient cost, the SOAP cost must be allocated/divided across siblings (or attributed wholly to the parent — depends on the question being asked).
- **`docx` events with `case_id = NULL` don't happen** in the current code — every docx spawn is attached to a case. But this is a convention, not a constraint.
- **`status = 'started'` with `finished_at IS NULL` after an app restart** means the process was killed by the crash. Old `started` rows are orphaned — they're not retroactively marked failed by startup code. If this matters for a dashboard, filter on `finished_at IS NULL AND started_at < datetime('now', '-1 hour')`.
- **`error_message` is truncated to 1024 chars.** Full stderr lives in `app.log`.

---

### 3.5 `cdi_flags`

The structured payload from a successful CDI run, one row per flag. Mirrors the `flags[]` array in the CDI JSON output exactly (see [cdi-review SKILL.md](../notes-claude/skills/cdi-review/SKILL.md) Step 3 / output schema).

**Created by:** migration `003_add_cdi_tables.sql`.
**Written by:** `db/cdi_flags.js` — `insertFlags()` (bulk-insert, called by `spawnCdiReview`'s success path), `deleteFlagsForCase()` (used when CDI is re-run on the same case — v1.1 feature, not active in v1).

| Column | Type | Nullable | Default | Meaning |
|---|---|---|---|---|
| `id` | INTEGER (PK, AUTOINCREMENT) | no | — | Surrogate key. |
| `case_id` | TEXT | no | — | FK → `cases.id`. The case row that owns the SOAP this flag is about. |
| `cdi_run_id` | INTEGER | yes | NULL | FK → `processing_events.id`. The CDI event row from this run. NULL if `startEvent` failed. |
| `flag_index` | INTEGER | no | — | 1-based position in the original `flags[]` array. Lets you reproduce the JSON order. |
| `type` | TEXT | no | — | `'critical'` / `'warning'` / `'suggestion'` / `'opportunity'`. Severity. `opportunity` only appears in `aggressive` mode. |
| `category` | TEXT | no | — | `'Specificity'` / `'Linkage'` / `'HCC'` / `'Completeness'` / `'Audit-defense'`. The clinical-documentation taxonomy bucket. |
| `title` | TEXT | no | — | Short flag title (≤ 12 words). Truncated to 1024 chars on insert. |
| `body` | TEXT | no | — | 1–3 sentence rationale. Cites a guideline reference. |
| `guideline_reference` | TEXT | yes | NULL | Pointer to the standards pack section (e.g. `'ICD-10-CM Sec IV.H'`, `'Ortho pack §3'`, `'AHIMA/ACDIS 2026 §2'`). |
| `current_code` | TEXT | yes | NULL | The ICD-10 code currently in the SOAP note that this flag would replace. NULL if no code is being replaced. |
| `suggested_codes` | TEXT | yes | NULL | **JSON-stringified array** of `{code, description}` objects. JSON.parse to read. Empty/`[]` is possible. |
| `confidence` | INTEGER | no | — | 0–100. The skill's confidence that this flag is correct. Mode-filtered: `compliance` ≥ 70, `balanced` ≥ 50, `aggressive` ≥ 30. |
| `evidence_found` | TEXT | yes | NULL | **JSON-stringified array** of verbatim/near-verbatim quotes from the note that support the flag. JSON.parse to read. 0–4 entries. |
| `evidence_missing` | TEXT | yes | NULL | **JSON-stringified array** of what would be needed to upgrade or defend the documentation. JSON.parse to read. 0–4 entries. |
| `created_at` | TEXT | no | — | ISO 8601 UTC at insertion (i.e., when the CDI run was successfully ingested). |

**FK constraints:**
- `case_id` → `cases.id` ON DELETE CASCADE. (Deleting a case removes its flags.)
- `cdi_run_id` → `processing_events.id` ON DELETE SET NULL.

**Indexes:**
- `idx_cdi_flags_case` (`case_id, created_at`) — all flags for a case, in insertion order.
- `idx_cdi_flags_run` (`cdi_run_id`) — all flags for one CDI invocation (when multiple runs exist on a case).
- `idx_cdi_flags_type` (`type`) — slice all critical flags across cases.

**Gotchas:**

- **Three columns are JSON-encoded TEXT, not native arrays/objects:** `suggested_codes`, `evidence_found`, `evidence_missing`. SQL queries must `json_extract()` (SQLite's JSON1 functions are compiled in by default) or fetch and `JSON.parse` in JS. Treat these as strings until you decode.
- **`drg_impact` field from the skill is dropped** — v1 is outpatient-only; the field is always null upstream and is not persisted to a column.
- **Re-runs are not handled in v1.** If CDI somehow runs twice on the same case (manual `claude -p` re-invocation), you'll get **two sets of flag rows on the same `case_id`**, distinguishable only by `cdi_run_id` or `created_at`. Use `MAX(cdi_run_id)` to dedupe. The `deleteFlagsForCase()` helper exists for the future v1.1 pre-chart-re-runs-CDI feature.
- **Multi-patient parent (audit) rows never get flags.** `case_id` always points to a single-patient case or a multi-patient child. Don't query `cdi_flags` joined to multi-patient parents expecting rows.

---

## 4. Common debug queries

Paste-ready SQL. All are read-only.

### 4.1 Everything about a single case

Substitute `'<case_id>'` with the actual UUID. Returns one row of case + doctor + session metadata, plus the full event timeline and CDI flag list.

```sql
-- Header: case + doctor + session
SELECT c.*,
       d.name AS doctor_name, d.lastname AS doctor_lastname, d.specialty,
       s.session_folder, s.started_at AS session_started, s.ended_at AS session_ended
FROM cases c
LEFT JOIN doctors  d ON d.id = c.doctor_id
LEFT JOIN sessions s ON s.id = c.session_id
WHERE c.id = '<case_id>';

-- Event timeline (one row per spawned subprocess, ordered by start time)
SELECT id, job_kind, status, model_used, effort,
       input_tokens, output_tokens, cache_read_tokens, cache_created_tokens,
       cost_usd, num_turns, duration_ms,
       started_at, finished_at, error_message
FROM processing_events
WHERE case_id = '<case_id>'
ORDER BY started_at;

-- CDI flags (newest first)
SELECT flag_index, type, category, title, confidence,
       guideline_reference, current_code, suggested_codes,
       evidence_found, evidence_missing, created_at
FROM cdi_flags
WHERE case_id = '<case_id>'
ORDER BY flag_index;
```

### 4.2 Multi-patient parent + all children for a session

Returns one parent (audit) row with `soap_note_path IS NULL` and the children with `soap_note_path IS NOT NULL`. Confirm the relationship by case_dir paths (children sit next to the parent).

```sql
SELECT id, patient_name, case_dir, status,
       soap_note_path,
       CASE WHEN soap_note_path IS NULL THEN 'parent (audit)' ELSE 'child' END AS role,
       recorded_at, completed_at
FROM cases
WHERE session_id = '<session_id>'
ORDER BY recorded_at, case_dir;
```

### 4.3 All events for a session (ordered)

Useful for reconstructing exactly what happened during one Start→Stop cycle.

```sql
SELECT e.started_at, e.job_kind, e.status, e.duration_ms, e.cost_usd,
       c.patient_name, c.case_dir, e.error_message
FROM processing_events e
LEFT JOIN cases c ON c.id = e.case_id
WHERE c.session_id = '<session_id>'
ORDER BY e.started_at;
```

### 4.4 Per-engine cost summary (last 30 days)

Slice cost and token usage by `job_kind`. Includes template create/update (no `case_id`).

```sql
SELECT job_kind,
       COUNT(*)              AS n_runs,
       SUM(cost_usd)         AS total_cost_usd,
       AVG(cost_usd)         AS avg_cost_usd,
       SUM(input_tokens)     AS total_input_tokens,
       SUM(output_tokens)    AS total_output_tokens,
       SUM(cache_read_tokens) AS total_cache_read,
       SUM(duration_ms) / 1000 AS total_seconds
FROM processing_events
WHERE started_at >= datetime('now', '-30 days')
  AND status = 'success'
GROUP BY job_kind
ORDER BY total_cost_usd DESC;
```

### 4.5 Per-doctor case count + average CDI quality score

Skips multi-patient parents (which have `cdi_quality_score IS NULL`). Doctors with no completed CDI runs show `NULL` for `avg_cdi_quality`.

```sql
SELECT d.name, d.lastname, d.specialty,
       COUNT(c.id) FILTER (WHERE c.soap_note_path IS NOT NULL)        AS cases_with_soap,
       COUNT(c.id) FILTER (WHERE c.cdi_status = 'completed')          AS cdi_completed,
       ROUND(AVG(c.cdi_quality_score), 1)                             AS avg_cdi_quality,
       COUNT(c.id) FILTER (WHERE c.cdi_clinician_approval_required=1) AS critical_cases
FROM doctors d
LEFT JOIN cases c ON c.doctor_id = d.id
GROUP BY d.id
ORDER BY cases_with_soap DESC;
```

### 4.6 CDI flags sorted by severity for a case

`type` is a string; ordering puts critical → opportunity. Use a CASE expression for explicit severity ranking.

```sql
SELECT flag_index, type, category, confidence, title, body,
       suggested_codes, current_code, guideline_reference
FROM cdi_flags
WHERE case_id = '<case_id>'
ORDER BY CASE type
           WHEN 'critical'    THEN 0
           WHEN 'warning'     THEN 1
           WHEN 'suggestion'  THEN 2
           WHEN 'opportunity' THEN 3
         END,
         confidence DESC;
```

### 4.7 Failed jobs in the last 24 hours

Surfaces jobs that hit the `'failed'` event status — anything from MCP auth errors to manifest parse failures.

```sql
SELECT e.started_at, e.finished_at, e.job_kind, e.duration_ms,
       c.patient_name, c.case_dir, e.error_message
FROM processing_events e
LEFT JOIN cases c ON c.id = e.case_id
WHERE e.status = 'failed'
  AND e.started_at >= datetime('now', '-24 hours')
ORDER BY e.started_at DESC;
```

### 4.8 Cases stuck in non-terminal status

After a crash, cases that were in flight can be left in `'transcribing'`, `'generating_note'`, or `'converting'`. These are orphans — the child processes are gone. v1 doesn't auto-clean these; this query finds them.

```sql
SELECT id, patient_name, case_dir, status, recorded_at, updated_at
FROM cases
WHERE status NOT IN ('completed', 'failed')
  AND updated_at < datetime('now', '-1 hour')   -- generous: real runs are minutes
ORDER BY updated_at;
```

### 4.9 Recent CDI runs needing review

Surfaces the cases where the CDI skill set `clinician_approval_required = 1` (i.e., found at least one `critical` flag or a hard rule violation).

```sql
SELECT c.patient_name, c.case_dir,
       c.cdi_quality_score, c.cdi_medical_necessity, c.cdi_claim_defense_readiness,
       c.cdi_status, c.cdi_mode, c.completed_at,
       d.name AS doctor
FROM cases c
LEFT JOIN doctors d ON d.id = c.doctor_id
WHERE c.cdi_clinician_approval_required = 1
ORDER BY c.completed_at DESC
LIMIT 50;
```

### 4.10 Schema sanity

Compare `user_version` against the highest migration number on disk. If they diverge, the migration runner failed silently.

```sql
PRAGMA user_version;            -- should match the highest NNN_*.sql file (currently 3)
PRAGMA foreign_key_check;       -- should return zero rows
PRAGMA integrity_check;         -- should return "ok"
```

---

## 5. Inspecting via Beekeeper Studio

1. **Connection type:** SQLite.
2. **Database file:** point at `<NOTES_DIR>/app.db`. The `app.db-wal` and `app.db-shm` companion files are auto-detected; don't pick them.
3. **Optional but recommended:** tick **Read-only** if you're just inspecting — prevents accidental writes that would race with the running app. Better-sqlite3 + WAL is concurrent-read-safe, so the app can keep running while you query.

Same applies to DB Browser for SQLite and other SQLite clients. To inspect from the shell while the app is running, use the `sqlite3` CLI in WAL-aware mode (it's the default in any recent sqlite3 build).

---

## 6. Update policy

When you add or alter a migration:

1. Bump the new file's trailing `PRAGMA user_version = N;`.
2. Update this file in the **same commit** as the migration: a new `### 3.X` subsection for new tables, or column-table rows + a "Created/Modified by: migration NNN" note for column adds/renames.
3. Keep [ARCHITECTURE.md § DB schema overview](ARCHITECTURE.md#db-schema-overview) as a tight 5-row teaser — that doc summarizes; this doc is the truth.
4. If the migration changes an enum (e.g. a new `cases.status` value or a new `job_kind`), update the corresponding "enum" subsection here.

Migrations are forward-only. There is no `down.sql`. If a column needs removing, write a new migration that recreates the table without it (SQLite's `ALTER TABLE ... DROP COLUMN` exists in 3.35+ but be deliberate about which sqlite version `better-sqlite3` ships).

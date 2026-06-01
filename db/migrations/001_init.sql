-- SQLite v1 schema for AI Medical Scribe
-- Applies when user_version = 0. Sets user_version = 1 at the end.

CREATE TABLE IF NOT EXISTS doctors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  lastname        TEXT NOT NULL,
  specialty       TEXT,
  template_path   TEXT,
  enable_cdi      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_lastname ON doctors (lastname);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  session_folder  TEXT NOT NULL UNIQUE,
  doctor_id       TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  case_count      INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_doctor     ON sessions (doctor_id, started_at DESC);

CREATE TABLE IF NOT EXISTS cases (
  id                      TEXT PRIMARY KEY,
  patient_name            TEXT,
  doctor_id               TEXT,
  session_id              TEXT,
  case_dir                TEXT NOT NULL UNIQUE,
  source                  TEXT NOT NULL,
  mp3_path                TEXT,
  audio_duration_seconds  REAL,
  audio_size_bytes        INTEGER,
  transcript_path         TEXT,
  transcript_docx_path    TEXT,
  soap_note_path          TEXT,
  soap_docx_path          TEXT,
  status                  TEXT NOT NULL,
  revision                INTEGER NOT NULL DEFAULT 1,
  recorded_at             TEXT NOT NULL,
  completed_at            TEXT,
  last_edited_at          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (doctor_id)  REFERENCES doctors(id)  ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_recorded_at      ON cases (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_doctor_recorded  ON cases (doctor_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_session          ON cases (session_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_cases_status           ON cases (status);

CREATE TABLE IF NOT EXISTS processing_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id              TEXT,
  job_kind             TEXT NOT NULL,
  related_doctor_id    TEXT,
  status               TEXT NOT NULL,
  model_used           TEXT,
  effort               TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_read_tokens    INTEGER,
  cache_created_tokens INTEGER,
  cost_usd             REAL,
  num_turns            INTEGER,
  duration_ms          INTEGER,
  error_message        TEXT,
  backup_path          TEXT,
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  FOREIGN KEY (case_id)           REFERENCES cases(id)   ON DELETE CASCADE,
  FOREIGN KEY (related_doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_case         ON processing_events (case_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_kind_started ON processing_events (job_kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_doctor_kind  ON processing_events (related_doctor_id, job_kind, started_at DESC);

PRAGMA user_version = 1;

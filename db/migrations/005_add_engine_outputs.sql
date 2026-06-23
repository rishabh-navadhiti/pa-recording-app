-- PA Engines v0.2 — generic per-engine output index.
--
-- `engine_outputs` is where NEW engine descriptors (em-score, patient-summary)
-- record each run. It is deliberately NOT a set of per-engine columns on
-- `cases`: bolting `em_*` / `patient_summary_*` onto `cases` the way `cdi_*`
-- was (migration 003) is the "cdi_* splatter" we don't want repeated for every
-- future engine. Instead each run is one row keyed by (case_id, engine), with a
-- small `summary_json` blob carrying the headline fields list views need.
--
-- The two existing engines keep their established storage: ICD codes live in
-- the SOAP .md, and CDI keeps its `cases.cdi_*` columns + `cdi_flags` table.
-- Only the v0.2 engines write here.
--
--   case_id      — the case row this output belongs to (CASCADE on delete).
--   engine       — engine id, e.g. 'em-score' | 'patient-summary'.
--   status       — terminal run status: 'ok' | 'skipped' | 'failed'.
--   json_path    — abs path to the on-disk JSON the engine wrote (nullable).
--   summary_json — compact headline fields for list views (JSON text, nullable).
--   event_id     — processing_events.id for this run (nullable; SET NULL on delete).

CREATE TABLE IF NOT EXISTS engine_outputs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     TEXT,
  engine      TEXT NOT NULL,        -- 'em-score' | 'patient-summary'
  status      TEXT NOT NULL,        -- 'ok' | 'skipped' | 'failed'
  json_path   TEXT,
  summary_json TEXT,                -- compact headline fields for list views
  event_id    INTEGER,              -- processing_events.id (nullable)
  created_at  TEXT NOT NULL,
  FOREIGN KEY (case_id)  REFERENCES cases(id)              ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES processing_events(id)  ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_engine_outputs_case ON engine_outputs (case_id, engine, created_at DESC);

PRAGMA user_version = 5;

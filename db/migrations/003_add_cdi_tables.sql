-- CDI v1 — Plan 2 Phase 2: add per-case CDI columns + flags table.
--
-- The cdi_* columns on `cases` denormalize the summary fields from a CDI run
-- so the floating status window can render at-a-glance without joining
-- `cdi_flags`. Per-row attribution mirrors `soap_note_path` / `soap_docx_path`:
-- single-patient runs populate the one case row; multi-patient runs populate
-- each child row independently; multi-patient parent (audit) rows stay NULL.
--
-- The cdi_flags table stores the per-flag payload from each successful CDI
-- run, attached to the case row that owns the SOAP it flagged. Parent (audit)
-- rows in multi-patient runs never get cdi_flags entries.

ALTER TABLE cases ADD COLUMN cdi_json_path TEXT;
ALTER TABLE cases ADD COLUMN cdi_md_path TEXT;
ALTER TABLE cases ADD COLUMN cdi_docx_path TEXT;
ALTER TABLE cases ADD COLUMN cdi_quality_score INTEGER;
ALTER TABLE cases ADD COLUMN cdi_medical_necessity TEXT;
ALTER TABLE cases ADD COLUMN cdi_claim_defense_readiness TEXT;
ALTER TABLE cases ADD COLUMN cdi_clinician_approval_required INTEGER DEFAULT 0;
ALTER TABLE cases ADD COLUMN cdi_mode TEXT;
ALTER TABLE cases ADD COLUMN cdi_status TEXT;

CREATE TABLE IF NOT EXISTS cdi_flags (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id             TEXT NOT NULL,
  cdi_run_id          INTEGER,
  flag_index          INTEGER NOT NULL,
  type                TEXT NOT NULL,
  category            TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  guideline_reference TEXT,
  current_code        TEXT,
  suggested_codes     TEXT,
  confidence          INTEGER NOT NULL,
  evidence_found      TEXT,
  evidence_missing    TEXT,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (case_id)    REFERENCES cases(id)              ON DELETE CASCADE,
  FOREIGN KEY (cdi_run_id) REFERENCES processing_events(id)  ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cdi_flags_case ON cdi_flags (case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cdi_flags_run  ON cdi_flags (cdi_run_id);
CREATE INDEX IF NOT EXISTS idx_cdi_flags_type ON cdi_flags (type);

PRAGMA user_version = 3;

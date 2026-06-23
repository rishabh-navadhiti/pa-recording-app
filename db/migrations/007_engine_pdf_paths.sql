-- Per-case combined review PDF path (cdi_pdf_path) on cases.
-- Generic pdf_path on engine_outputs for em-score and patient-summary PDFs.
ALTER TABLE cases ADD COLUMN cdi_pdf_path TEXT;
ALTER TABLE engine_outputs ADD COLUMN pdf_path TEXT;

PRAGMA user_version = 7;

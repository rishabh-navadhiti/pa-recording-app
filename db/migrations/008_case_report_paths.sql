-- Combined engine-output report (the "Clinical Cockpit" HTML→PDF render).
-- Each case gets ONE combined report rendered from whatever engine JSONs ran
-- (CDI + E/M + patient-summary). Two columns hold the rendered artifacts:
--   report_html_path — abs path to <stem>_report.html (self-contained, shareable).
--   report_pdf_path  — abs path to <stem>_report.pdf (printToPDF; null if render failed).
--
-- The columns are added idempotently by ensureCaseColumns() in db/init.js, NOT by a
-- raw `ALTER TABLE ADD COLUMN` here. Why: a dev DB that ran an earlier (discarded)
-- branch of this feature may ALREADY have one of these columns while still at
-- user_version=7. A raw ALTER would then throw "duplicate column name", roll back the
-- whole migration, and take the entire DB offline (initDb sets _db=null on a migration
-- throw → app reports "no doctors"). SQLite has no `ADD COLUMN IF NOT EXISTS`, so this
-- migration only advances the version; ensureCaseColumns (check-then-add, runs every
-- launch) is the crash-proof authority that guarantees both columns exist — the same
-- pattern migration 007's columns use.

PRAGMA user_version = 8;

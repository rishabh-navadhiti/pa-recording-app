-- CDI v1 refinement (2026-05-27): per-flag schema additions surfaced by
-- real-case testing on Stephanie + Guardo.
--
-- 1. `action` — a required one-line imperative TL;DR per flag (what to do).
--    NOT NULL DEFAULT '' so pre-migration cdi_flags rows (which predate the
--    field) get '' rather than blocking the migration. No backfill — those
--    rows are from earlier dev test runs.
-- 2. `reimbursement_impact` — nullable. Replaces the JSON-only `drg_impact`
--    field (which was never a DB column and was always null on outpatient
--    cases). Mostly null; populated only when a flag carries a real
--    reimbursement signal (E/M level, HCC capture, modifier).

ALTER TABLE cdi_flags ADD COLUMN action TEXT NOT NULL DEFAULT '';
ALTER TABLE cdi_flags ADD COLUMN reimbursement_impact TEXT;

PRAGMA user_version = 4;

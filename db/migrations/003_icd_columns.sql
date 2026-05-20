-- Add ICD-10 status column to cases table.
ALTER TABLE cases ADD COLUMN icd_status TEXT;

PRAGMA user_version = 3;

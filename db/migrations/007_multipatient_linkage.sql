-- Multi-patient case linkage.
-- parent_case_id: set on each child row pointing to the recording (audit) parent.
-- multi_patient:  set to 1 on the parent (recording) row when the run was multi-patient.
ALTER TABLE cases ADD COLUMN parent_case_id TEXT NULL REFERENCES cases(id);
ALTER TABLE cases ADD COLUMN multi_patient INTEGER NOT NULL DEFAULT 0;

PRAGMA user_version = 7;

'use strict'

// Shared manifest fixture strings for unit tests.
// These are the raw text outputs from skills (the strings parseSkillManifest receives).

const SINGLE_OK = '{"schema_version":1,"skill":"generate-note","status":"ok","multi_patient":false,"summary":"Generated SOAP note for Jane Doe.","recording_folder":"/Users/scribe/Documents/AI Medical Notes/Cases/2026-05-22/jane_doe_2026-05-22","cases":[{"patient_name":"Jane Doe","doctor_lastname":"sabbag","visit_type":"pr2_follow_up","chief_complaint":"Left wrist pain s/p ORIF","soap_note_md":"/Users/scribe/Documents/AI Medical Notes/Cases/2026-05-22/jane_doe_2026-05-22/jane_doe_2026-05-22_soap_note.md","placeholders":[],"warnings":[],"status":"ok"}],"warnings":[]}'

const MULTI_OK = '{"schema_version":1,"skill":"generate-note","status":"ok","multi_patient":true,"summary":"3 SOAP notes","recording_folder":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10","cases":[{"patient_name":"Jane Doe","doctor_lastname":"spencer","visit_type":"follow_up","chief_complaint":"x","soap_note_md":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10/jane_doe_soap_note.md","placeholders":[],"warnings":[],"status":"ok"},{"patient_name":"John Smith","doctor_lastname":"spencer","visit_type":"new_patient","chief_complaint":"y","soap_note_md":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10/john_smith_soap_note.md","placeholders":[],"warnings":[],"status":"ok"}],"warnings":[]}'

const CDI_OK = '{"schema_version":1,"skill":"cdi-review","status":"ok","json_path":"/abs/path/Cases/2026-05-22/jane_doe_2026-05-22/jane_doe_2026-05-22_cdi.json","md_path":"/abs/path/Cases/2026-05-22/jane_doe_2026-05-22/jane_doe_2026-05-22_cdi.md","flag_count":2,"flag_counts":{"critical":0,"high":1,"medium":1,"low":0},"quality_score":72,"medical_necessity_status":"supported","claim_defense_readiness":"adequate","clinician_approval_required":false,"icd_validated":true}'

const CDI_SKIPPED = '{"schema_version":1,"skill":"cdi-review","status":"skipped","skipped_reason":"specialty not configured"}'

module.exports = { SINGLE_OK, MULTI_OK, CDI_OK, CDI_SKIPPED }

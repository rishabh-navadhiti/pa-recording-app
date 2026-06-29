'use strict'

const { STATUS_LABELS } = require('../src/shared/pipeline-status')

/**
 * In-memory store for the current session's recording pipeline statuses.
 * Replaces the `sessionRecordings` global and its 6 mutator functions.
 *
 * Each entry shape:
 * {
 *   caseTag: string,         // used as the unique key throughout
 *   displayName: string|null,
 *   startedAt: number,       // Date.now()
 *   status: string,
 *   soapDocxPath?: string,
 *   cdiStatus?: string,
 *   cdiFlagCount?: number,
 *   cdiQualityScore?: number,
 *   cdiDocxPath?: string,
 *   cdiSkipReason?: string,
 *   cdiClinicianApprovalRequired?: boolean,
 *   patients?: Array<PatientEntry>,
 * }
 *
 * @param {object} opts
 * @param {Function} [opts.onChange]  Called with the serialized payload after every mutation.
 * @returns {RecordingsStore}
 */
function createRecordingsStore({ onChange } = {}) {
  let entries = []

  function notify() {
    if (onChange) onChange(serialize())
  }

  function find(caseTag) {
    return entries.find(r => r.caseTag === caseTag) || null
  }

  /**
   * Project the raw entries into the payload the renderer expects:
   * add statusLabel, map patient statusLabels.
   */
  function serialize() {
    return entries.map(r => ({
      ...r,
      statusLabel: STATUS_LABELS[r.status] || r.status,
      patients: r.patients
        ? r.patients.map(p => ({ ...p, statusLabel: STATUS_LABELS[p.status] || p.status }))
        : null
    }))
  }

  return {
    add({ caseTag, displayName, multiPatient, patientName }) {
      entries.push({
        caseTag,
        displayName:   displayName   || null,
        multiPatient:  !!multiPatient,
        patientName:   patientName   || null,
        startedAt: Date.now(),
        status: 'transcribing',
      })
      notify()
    },

    updateStatus(caseTag, status) {
      const r = find(caseTag)
      if (r) { r.status = status; notify() }
    },

    setPatients(caseTag, patients) {
      const r = find(caseTag)
      if (r) { r.patients = patients; notify() }
    },

    updatePatientStatus(caseTag, patientFolderName, status) {
      const r = find(caseTag)
      if (!r || !r.patients) return
      const p = r.patients.find(p => p.folderName === patientFolderName)
      if (p) {
        p.status = status
        // Roll up: parent completes when ALL patients are done (completed or failed).
        const allDone = r.patients.every(p => p.status === 'completed' || p.status === 'failed')
        if (allDone) r.status = r.patients.some(p => p.status === 'completed') ? 'completed' : 'failed'
        notify()
      }
    },

    setCdi(caseTag, update) {
      const r = find(caseTag)
      if (r) { Object.assign(r, update); notify() }
    },

    setPatientCdi(caseTag, patientFolderName, update) {
      const r = find(caseTag)
      if (!r || !r.patients) return
      const p = r.patients.find(p => p.folderName === patientFolderName)
      if (p) { Object.assign(p, update); notify() }
    },

    setDocxPath(caseTag, docxPath) {
      const r = find(caseTag)
      if (r) { r.soapDocxPath = docxPath; notify() }
    },

    // Combined-report (Clinical Cockpit) paths — set by src/pipeline/report.js.
    // Mirror setCdi/setPatientCdi: merge { reportPdfPath, reportHtmlPath } onto
    // the entry so the status window can show an "Open Report" button.
    setReport(caseTag, update) {
      const r = find(caseTag)
      if (r) { Object.assign(r, update); notify() }
    },

    setPatientReport(caseTag, patientFolderName, update) {
      const r = find(caseTag)
      if (!r || !r.patients) return
      const p = r.patients.find(p => p.folderName === patientFolderName)
      if (p) { Object.assign(p, update); notify() }
    },

    // Raw entry lookup by caseTag (used by generateSoapViaApi to read the
    // multiPatient flag + entered patientName written at ingest time).
    find,

    serialize,

    clear() { entries = []; notify() },

    // Raw access for the get-session-recordings IPC handler (returns same
    // shape as the onChange payload so the two code paths stay in sync).
    getAll() { return serialize() },
  }
}

module.exports = { createRecordingsStore }

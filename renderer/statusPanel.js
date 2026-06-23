// Floating status-window renderer (ESM). Extracted verbatim from status.js;
// the only change is routing IPC through the shared client instead of bare
// window.api. Renders the per-case pipeline status with the flat cdi* fields
// and the multi-patient patients[] hierarchy.
//
// NOTE: kept the flat cdi* shape deliberately — generalizing to a per-engine
// reviews[] array waits until a 2nd review engine exists (premature otherwise).

import { ipc } from './ipc/client.js'

// "Open Note" button when the SOAP docx is ready.
function appendOpenNoteBtn(statusRow, docxPath) {
  if (!docxPath) return
  const btn = document.createElement('button')
  btn.className = 'open-btn'
  btn.textContent = 'Open'
  btn.title = 'Open SOAP note'
  btn.addEventListener('click', () => ipc.openSoapNote(docxPath))
  statusRow.appendChild(btn)
}

// "CDI" button + approval-required badge, driven by the cdi* fields on each
// recording / patient entry (set by main.js's setRecordingCdi / setPatientCdi).
function appendCdiUi(statusRow, entry) {
  if (entry.cdiClinicianApprovalRequired) {
    const badge = document.createElement('span')
    badge.className = 'cdi-approval-badge'
    badge.textContent = '⚠ Review'
    badge.title = 'CDI flagged ≥ 1 critical issue — clinician approval required before submission'
    statusRow.appendChild(badge)
  }
  if (entry.cdiDocxPath) {
    const cdiBtn = document.createElement('button')
    cdiBtn.className = 'open-btn open-btn--cdi'
    const flagCount = entry.cdiFlagCount != null ? entry.cdiFlagCount : '?'
    const qScore = entry.cdiQualityScore != null ? entry.cdiQualityScore : '?'
    cdiBtn.textContent = 'CDI'
    cdiBtn.title = `Open CDI review · ${flagCount} flags · quality ${qScore}/100`
    cdiBtn.addEventListener('click', () => ipc.openSoapNote(entry.cdiDocxPath))
    statusRow.appendChild(cdiBtn)
  }
  if (entry.cdiPdfPath) {
    const pdfBtn = document.createElement('button')
    pdfBtn.className = 'open-btn open-btn--review'
    pdfBtn.textContent = 'Review'
    pdfBtn.title = 'Open combined review PDF (CDI · E/M · Patient summary)'
    pdfBtn.addEventListener('click', () => ipc.openSoapNote(entry.cdiPdfPath))
    statusRow.appendChild(pdfBtn)
  }
}

export function renderRecordings(recordings) {
  const list = document.getElementById('recording-list')
  if (!list) return

  if (!recordings || recordings.length === 0) {
    list.innerHTML = '<div id="no-recordings">No recordings this session</div>'
    return
  }

  list.innerHTML = ''
  recordings.slice().reverse().forEach(rec => {
    const item = document.createElement('div')
    item.className = 'recording-item'

    if (rec.patients && rec.patients.length > 0) {
      // Multi-patient hierarchical view
      const header = document.createElement('div')
      header.className = 'recording-header'

      const nameEl = document.createElement('span')
      nameEl.className = 'recording-name'
      nameEl.textContent = rec.displayName
      nameEl.title = rec.caseTag

      const countBadge = document.createElement('span')
      countBadge.className = 'patient-count'
      countBadge.textContent = rec.patients.length

      header.appendChild(nameEl)
      header.appendChild(countBadge)
      item.appendChild(header)

      rec.patients.forEach(patient => {
        const patientRow = document.createElement('div')
        patientRow.className = 'patient-row'

        const patientName = document.createElement('div')
        patientName.className = 'patient-name'
        patientName.textContent = patient.name

        const statusRow = document.createElement('div')
        statusRow.className = `patient-status status-${patient.status}`

        const dot = document.createElement('span')
        dot.className = 'status-dot'

        const label = document.createElement('span')
        label.textContent = patient.statusLabel || patient.status

        statusRow.appendChild(dot)
        statusRow.appendChild(label)

        if (patient.status === 'completed') appendOpenNoteBtn(statusRow, patient.soapDocxPath)
        appendCdiUi(statusRow, patient)

        patientRow.appendChild(patientName)
        patientRow.appendChild(statusRow)
        item.appendChild(patientRow)
      })
    } else {
      // Single-patient flat view
      const nameRow = document.createElement('div')
      nameRow.className = 'recording-name'
      nameRow.textContent = rec.displayName
      nameRow.title = rec.caseTag

      const statusRow = document.createElement('div')
      statusRow.className = `recording-status status-${rec.status}`

      const dot = document.createElement('span')
      dot.className = 'status-dot'

      const label = document.createElement('span')
      label.textContent = rec.statusLabel

      statusRow.appendChild(dot)
      statusRow.appendChild(label)

      if (rec.status === 'completed') appendOpenNoteBtn(statusRow, rec.soapDocxPath)
      appendCdiUi(statusRow, rec)

      item.appendChild(nameRow)
      item.appendChild(statusRow)
    }

    list.appendChild(item)
  })
}

// ---- bootstrap (only when running in the real window, not under jsdom import) ----
const closeBtn = typeof document !== 'undefined' && document.getElementById('btn-close')
if (closeBtn) closeBtn.addEventListener('click', () => ipc.closeStatusWindow())
if (typeof window !== 'undefined' && window.api) {
  ipc.onRecordingStatusUpdate(renderRecordings)
  ipc.getSessionRecordings().then(renderRecordings).catch(console.error)
}

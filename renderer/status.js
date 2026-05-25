'use strict'

// Append an "Open Note" button to the status row when the SOAP docx is ready.
function appendOpenNoteBtn(statusRow, docxPath) {
  if (!docxPath) return
  const btn = document.createElement('button')
  btn.className = 'open-btn'
  btn.textContent = 'Open'
  btn.title = 'Open SOAP note'
  btn.addEventListener('click', () => api.openSoapNote(docxPath))
  statusRow.appendChild(btn)
}

// Append a "CDI" button + approval-required badge when the CDI docx is ready
// or its review surfaced a critical flag. Driven by the cdi* fields on each
// recording / patient entry (populated by main.js's setRecordingCdi /
// setPatientCdi helpers).
function appendCdiUi(statusRow, entry) {
  // Approval-required badge — shows the moment CDI completes, even before
  // its docx is ready. Visual prompt that a clinician must review before
  // the note is shippable.
  if (entry.cdiClinicianApprovalRequired) {
    const badge = document.createElement('span')
    badge.className = 'cdi-approval-badge'
    badge.textContent = '⚠ Review'
    badge.title = 'CDI flagged ≥ 1 critical issue — clinician approval required before submission'
    statusRow.appendChild(badge)
  }

  // Open CDI Review button — only when the cdi docx exists on disk.
  if (entry.cdiDocxPath) {
    const cdiBtn = document.createElement('button')
    cdiBtn.className = 'open-btn open-btn--cdi'
    const flagCount = entry.cdiFlagCount != null ? entry.cdiFlagCount : '?'
    const qScore = entry.cdiQualityScore != null ? entry.cdiQualityScore : '?'
    cdiBtn.textContent = 'CDI'
    cdiBtn.title = `Open CDI review · ${flagCount} flags · quality ${qScore}/100`
    cdiBtn.addEventListener('click', () => api.openSoapNote(entry.cdiDocxPath))
    statusRow.appendChild(cdiBtn)
  }
}

function renderRecordings(recordings) {
  const list = document.getElementById('recording-list')

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

        if (patient.status === 'completed') {
          appendOpenNoteBtn(statusRow, patient.soapDocxPath)
        }
        appendCdiUi(statusRow, patient)

        patientRow.appendChild(patientName)
        patientRow.appendChild(statusRow)
        item.appendChild(patientRow)
      })
    } else {
      // Single patient flat view
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

      if (rec.status === 'completed') {
        appendOpenNoteBtn(statusRow, rec.soapDocxPath)
      }
      appendCdiUi(statusRow, rec)

      item.appendChild(nameRow)
      item.appendChild(statusRow)
    }

    list.appendChild(item)
  })
}

document.getElementById('btn-close').addEventListener('click', () => {
  api.closeStatusWindow()
})

api.onRecordingStatusUpdate(renderRecordings)

api.getSessionRecordings().then(renderRecordings).catch(console.error)

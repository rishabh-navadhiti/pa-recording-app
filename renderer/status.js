'use strict'

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

        if (patient.status === 'completed' && patient.soapDocxPath) {
          const btn = document.createElement('button')
          btn.className = 'open-btn'
          btn.textContent = 'Open'
          btn.addEventListener('click', () => api.openSoapNote(patient.soapDocxPath))
          statusRow.appendChild(btn)
        }

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

      if (rec.status === 'completed' && rec.soapDocxPath) {
        const btn = document.createElement('button')
        btn.className = 'open-btn'
        btn.textContent = 'Open'
        btn.addEventListener('click', () => api.openSoapNote(rec.soapDocxPath))
        statusRow.appendChild(btn)
      }

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

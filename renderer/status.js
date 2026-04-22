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
    item.appendChild(nameRow)
    item.appendChild(statusRow)
    list.appendChild(item)
  })
}

document.getElementById('btn-close').addEventListener('click', () => {
  api.closeStatusWindow()
})

api.onRecordingStatusUpdate(renderRecordings)

api.getSessionRecordings().then(renderRecordings).catch(console.error)

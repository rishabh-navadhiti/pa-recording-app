// Pre-chart tab — extracted verbatim from renderer.js lines 430-609.
// Doctor + patient-case dropdowns, instructions textarea, attachments
// (rendered via the shared renderFileList component), and Start.
//
// refreshPrechartTab() repopulates the dropdowns + resets the form; it's invoked
// by the router when the Pre-chart tab is opened. After a successful start the
// original reset the form and refreshed the shared job banner — the banner
// refresh arrives via the onJobStarted callback (router wiring).
//
// The original's bespoke renderPrechartFiles is replaced by renderFileList
// (identical CSS classes + empty text). All show/hide goes through setVisible.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'
import { renderFileList } from '../components/fileListField.js'

export function createPrechartView() {
  let prechartView, prechartDoctorSelect, prechartCaseSelect, btnPrechartBrowseCase,
      prechartInstructions, prechartFilesEl, btnPrechartAddFiles, btnPrechartStart,
      prechartError, prechartChartRow, prechartChart
  let onJobStartedCb = null

  let prechartFiles = []

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function renderPrechartFiles() {
    renderFileList({
      container: prechartFilesEl,
      files: prechartFiles,
      onChange: updatePrechartStartEnabled,
    })
  }

  function updatePrechartStartEnabled() {
    if (!btnPrechartStart) return
    const hasDoctor = prechartDoctorSelect && prechartDoctorSelect.value
    const hasCase = prechartCaseSelect && prechartCaseSelect.value
    const hasInstructions = prechartInstructions && prechartInstructions.value.trim()
    const hasFiles = prechartFiles.length > 0
    btnPrechartStart.disabled = !hasDoctor || !hasCase || !(hasInstructions || hasFiles)
  }

  function showPrechartError(msg) {
    if (!prechartError) return
    prechartError.textContent = msg
    setVisible(prechartError, true)
  }

  function hidePrechartError() {
    if (prechartError) setVisible(prechartError, false)
  }

  async function refreshPrechartTab() {
    if (!prechartView) return
    prechartFiles = []
    if (prechartInstructions) prechartInstructions.value = ''
    hidePrechartError()
    renderPrechartFiles()
    updatePrechartStartEnabled()
    try {
      const s = await ipc.getSettings()
      if (prechartChartRow) prechartChartRow.classList.toggle('hidden', !s.enableCostiganCdi)
    } catch {}
    if (prechartChart) prechartChart.value = ''

    // Populate the doctor dropdown (only doctors with a template path)
    if (prechartDoctorSelect) {
      prechartDoctorSelect.innerHTML = '<option value="">Select doctor…</option>'
      try {
        const doctors = await ipc.getDoctors()
        doctors.filter(d => d.templatePath).forEach(d => {
          const opt = document.createElement('option')
          opt.value = d.id
          opt.textContent = d.name
          prechartDoctorSelect.appendChild(opt)
        })
      } catch (e) {
        console.error('getDoctors failed', e)
      }
    }

    // Populate the recent-cases dropdown
    if (prechartCaseSelect) {
      prechartCaseSelect.innerHTML = '<option value="">Select patient…</option>'
      try {
        const cases = await ipc.listRecentPatientCases()
        cases.forEach(c => {
          const opt = document.createElement('option')
          opt.value = c.caseDir
          const labelDate = c.date ? `  ·  ${c.date}` : ''
          opt.textContent = `${c.patient}${labelDate}`
          prechartCaseSelect.appendChild(opt)
        })
      } catch (e) {
        console.error('listRecentPatientCases failed', e)
      }
    }
  }

  return {
    mount(root, ctx = {}) {
      onJobStartedCb = ctx.onJobStarted || null

      prechartView          = root.querySelector('#prechart-view')
      prechartDoctorSelect  = root.querySelector('#prechart-doctor-select')
      prechartCaseSelect    = root.querySelector('#prechart-case-select')
      btnPrechartBrowseCase = root.querySelector('#btn-prechart-browse-case')
      prechartInstructions  = root.querySelector('#prechart-instructions')
      prechartFilesEl       = root.querySelector('#prechart-files')
      btnPrechartAddFiles   = root.querySelector('#btn-prechart-add-files')
      btnPrechartStart      = root.querySelector('#btn-prechart-start')
      prechartError         = root.querySelector('#prechart-error')
      prechartChartRow      = root.querySelector('#prechart-chart-row')
      prechartChart         = root.querySelector('#prechart-chart')

      if (prechartDoctorSelect) {
        on(prechartDoctorSelect, 'change', updatePrechartStartEnabled)
      }

      if (prechartCaseSelect) {
        on(prechartCaseSelect, 'change', updatePrechartStartEnabled)
      }

      if (prechartInstructions) {
        on(prechartInstructions, 'input', updatePrechartStartEnabled)
      }

      if (btnPrechartBrowseCase) {
        on(btnPrechartBrowseCase, 'click', async () => {
          btnPrechartBrowseCase.disabled = true
          try {
            const res = await ipc.browsePatientCaseFolder()
            if (!res.ok) {
              if (res.error && res.error !== 'cancelled') showPrechartError(res.error)
              return
            }
            // Add the picked folder as a new option (or pick existing one)
            let opt = Array.from(prechartCaseSelect.options).find(o => o.value === res.caseDir)
            if (!opt) {
              opt = document.createElement('option')
              opt.value = res.caseDir
              opt.textContent = res.caseDir.split(/[\\/]/).pop()
              prechartCaseSelect.appendChild(opt)
            }
            prechartCaseSelect.value = res.caseDir
            hidePrechartError()
            updatePrechartStartEnabled()
          } finally {
            btnPrechartBrowseCase.disabled = false
          }
        })
      }

      if (btnPrechartAddFiles) {
        on(btnPrechartAddFiles, 'click', async () => {
          btnPrechartAddFiles.disabled = true
          try {
            const paths = await ipc.browsePrechartFiles()
            if (Array.isArray(paths) && paths.length > 0) {
              const set = new Set(prechartFiles)
              paths.forEach(p => set.add(p))
              prechartFiles = Array.from(set)
              renderPrechartFiles()
              updatePrechartStartEnabled()
            }
          } finally {
            btnPrechartAddFiles.disabled = false
          }
        })
      }

      if (btnPrechartStart) {
        on(btnPrechartStart, 'click', async () => {
          hidePrechartError()
          const doctorId = prechartDoctorSelect ? prechartDoctorSelect.value : ''
          const caseDir = prechartCaseSelect ? prechartCaseSelect.value : ''
          const instructions = prechartInstructions ? prechartInstructions.value : ''
          if (!doctorId) {
            showPrechartError('Select a doctor first.')
            return
          }
          if (!caseDir) {
            showPrechartError('Select a patient case first.')
            return
          }
          if (!instructions.trim() && prechartFiles.length === 0) {
            showPrechartError('Provide instructions or attach at least one file.')
            return
          }
          btnPrechartStart.disabled = true
          const chartText = prechartChart ? prechartChart.value : ''
          const res = await ipc.startPrechartJob(doctorId, caseDir, instructions, prechartFiles, chartText)
          if (!res || !res.ok) {
            showPrechartError((res && res.error) || 'Failed to start')
            btnPrechartStart.disabled = false
            return
          }
          // Reset the form for the next run; banner will show progress on any tab.
          refreshPrechartTab()
          if (onJobStartedCb) onJobStartedCb()
        })
      }
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    refreshPrechartTab,
  }
}

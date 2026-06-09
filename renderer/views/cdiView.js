// CDI tab — manual cdi-review on a user-supplied SOAP note.
// Pattern mirrors prechartView.js exactly: listener tracking via on(), cleanup in unmount().
//
// refreshCdiTab() repopulates the doctor dropdown (filtered to CDI-eligible doctors).
// Called by the router when the CDI tab is opened — but it PRESERVES an in-flight
// run or a completed-but-unsaved report (it doesn't blow them away on re-entry).
//
// Input is mutually exclusive (D9): choosing a file clears the textarea and vice-versa.
// Run → ipc.startCdiReview(); progress via the shared job banner (type:'cdi').
// On success the banner emits type:'cdi' status:'success'; the tab then shows
// Save / Close buttons.
//
// Held-report lifecycle: a completed report STAYS (Save + Close on the tab) until
// the user saves it, closes it, or starts the NEXT CDI run — at which point main.js
// discards the previous report's temp folder. Leaving the tab does NOT discard it.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'
import { CDI_MODES } from '../constants.js'

export function createCdiView() {
  let cdiView, cdiDoctorSelect, cdiModeSelect,
      cdiPasteArea, cdiFileRow, cdiFileName, btnCdiAddFile, btnCdiClearFile,
      btnCdiRun, cdiError, cdiSuccessRow, btnCdiSave, btnCdiDiscard

  let selectedFilePath = null
  // A completed report is held main-side (temp .docx) awaiting Save/Close.
  // It survives tab navigation and is only discarded on Save, Close, or next run.
  let reportReady = false
  // True while a CDI run is in flight (between Run and success/failed).
  let isRunning = false

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function showError(msg) {
    if (!cdiError) return
    cdiError.textContent = msg
    setVisible(cdiError, true)
  }

  function hideError() {
    if (cdiError) setVisible(cdiError, false)
  }

  function updateRunEnabled() {
    if (!btnCdiRun) return
    const hasDoctor = cdiDoctorSelect && cdiDoctorSelect.value
    const hasPaste  = cdiPasteArea && cdiPasteArea.value.trim()
    const hasFile   = !!selectedFilePath
    btnCdiRun.disabled = !hasDoctor || !(hasPaste || hasFile)
  }

  function setFile(filePath) {
    selectedFilePath = filePath
    if (filePath) {
      const name = filePath.split(/[\\/]/).pop()
      if (cdiFileName) cdiFileName.textContent = name
      if (cdiPasteArea) {
        cdiPasteArea.value = ''
        cdiPasteArea.disabled = true
        cdiPasteArea.placeholder = 'File selected — clear it to paste instead.'
      }
      if (cdiFileRow) setVisible(cdiFileRow, true)
    } else {
      if (cdiFileName) cdiFileName.textContent = ''
      if (cdiPasteArea) {
        cdiPasteArea.disabled = false
        cdiPasteArea.placeholder = 'Paste the ICD-coded SOAP note here…'
      }
      if (cdiFileRow) setVisible(cdiFileRow, false)
    }
    updateRunEnabled()
  }

  function resetForm() {
    if (cdiPasteArea) { cdiPasteArea.value = ''; cdiPasteArea.disabled = false }
    setFile(null)
    hideError()
    showSuccessRow(false)
    updateRunEnabled()
  }

  function showSuccessRow(visible) {
    if (cdiSuccessRow) setVisible(cdiSuccessRow, visible)
    if (btnCdiRun)     setVisible(btnCdiRun, !visible)
  }

  async function refreshCdiTab() {
    if (!cdiView) return

    // Preserve an in-flight run or a completed-but-unsaved report across tab
    // re-entry — only reset the form when the tab is idle.
    if (!isRunning && !reportReady) {
      resetForm()
    } else if (reportReady) {
      // Returning to the tab with a held report — re-show the Save/Close row.
      showSuccessRow(true)
    } else if (isRunning) {
      // Returning mid-run — keep Run hidden/disabled; banner shows progress.
      showSuccessRow(false)
      if (btnCdiRun) btnCdiRun.disabled = true
    }

    // Populate doctor dropdown (CDI-eligible only: specialty set + standards pack)
    if (cdiDoctorSelect) {
      cdiDoctorSelect.innerHTML = '<option value="">Select doctor…</option>'
      try {
        const doctors = await ipc.getCdiDoctors()
        if (doctors && doctors.length > 0) {
          doctors.forEach(d => {
            const opt = document.createElement('option')
            opt.value = d.id
            opt.textContent = d.name
            cdiDoctorSelect.appendChild(opt)
          })
        } else {
          const opt = document.createElement('option')
          opt.value = ''
          opt.disabled = true
          opt.textContent = 'No doctors with CDI-supported specialties'
          cdiDoctorSelect.appendChild(opt)
        }
      } catch (e) {
        console.error('getCdiDoctors failed', e)
      }
    }

    // Populate mode dropdown from shared CDI_MODES constant
    if (cdiModeSelect) {
      cdiModeSelect.innerHTML = ''
      CDI_MODES.forEach(m => {
        const opt = document.createElement('option')
        opt.value = m.value
        opt.textContent = m.label
        cdiModeSelect.appendChild(opt)
      })
      cdiModeSelect.value = 'balanced'
    }

    // Don't re-enable Run while a run is in flight or a report is held — those
    // states own the button visibility/enabled-ness.
    if (!isRunning && !reportReady) updateRunEnabled()
  }

  // Called by app.js when a template-job-status event arrives with type:'cdi'
  function handleJobStatus(job) {
    if (!job || job.type !== 'cdi') return
    if (job.status === 'running') {
      isRunning = true
      reportReady = false
      if (btnCdiRun) btnCdiRun.disabled = true
    } else if (job.status === 'success') {
      isRunning = false
      reportReady = true
      showSuccessRow(true)
      hideError()
    } else if (job.status === 'failed') {
      isRunning = false
      reportReady = false
      showSuccessRow(false)
      showError(job.error || 'CDI review failed.')
      if (btnCdiRun) btnCdiRun.disabled = false
    }
  }

  return {
    mount(root) {
      cdiView          = root.querySelector('#tab-cdi')
      cdiDoctorSelect  = root.querySelector('#cdi-doctor-select')
      cdiModeSelect    = root.querySelector('#cdi-tab-mode-select')
      cdiPasteArea     = root.querySelector('#cdi-paste')
      cdiFileRow       = root.querySelector('#cdi-file-row')
      cdiFileName      = root.querySelector('#cdi-file-name')
      btnCdiAddFile    = root.querySelector('#btn-cdi-add-file')
      btnCdiClearFile  = root.querySelector('#btn-cdi-clear-file')
      btnCdiRun        = root.querySelector('#btn-cdi-run')
      cdiError         = root.querySelector('#cdi-error')
      cdiSuccessRow    = root.querySelector('#cdi-success-row')
      btnCdiSave       = root.querySelector('#btn-cdi-save')
      btnCdiDiscard    = root.querySelector('#btn-cdi-discard')

      on(cdiDoctorSelect, 'change', updateRunEnabled)
      on(cdiModeSelect,   'change', () => {})

      if (cdiPasteArea) {
        on(cdiPasteArea, 'input', () => {
          // Pasting clears file selection (D9)
          if (cdiPasteArea.value.trim() && selectedFilePath) {
            setFile(null)
          }
          updateRunEnabled()
        })
      }

      if (btnCdiAddFile) {
        on(btnCdiAddFile, 'click', async () => {
          btnCdiAddFile.disabled = true
          try {
            const filePath = await ipc.browseCdiSoapFile()
            if (filePath) setFile(filePath)
          } finally {
            btnCdiAddFile.disabled = false
          }
        })
      }

      if (btnCdiClearFile) {
        on(btnCdiClearFile, 'click', () => setFile(null))
      }

      if (btnCdiRun) {
        on(btnCdiRun, 'click', async () => {
          hideError()
          const doctorId = cdiDoctorSelect ? cdiDoctorSelect.value : ''
          const mode     = cdiModeSelect   ? cdiModeSelect.value   : 'balanced'
          const paste    = cdiPasteArea    ? cdiPasteArea.value     : ''
          if (!doctorId) { showError('Select a doctor first.'); return }
          if (!paste.trim() && !selectedFilePath) { showError('Provide a SOAP note.'); return }

          btnCdiRun.disabled = true
          isRunning = true
          reportReady = false
          const res = await ipc.startCdiReview(doctorId, mode, paste, selectedFilePath || '')
          if (!res || !res.ok) {
            isRunning = false
            showError((res && res.error) || 'Failed to start CDI review.')
            btnCdiRun.disabled = false
          }
          // On success: job is running; banner handles progress; handleJobStatus handles completion.
        })
      }

      if (btnCdiSave) {
        on(btnCdiSave, 'click', async () => {
          btnCdiSave.disabled = true
          const res = await ipc.saveCdiReport()
          btnCdiSave.disabled = false
          if (!res || !res.ok) {
            // Save dialog cancelled — keep the report held so the user can retry.
            if (res && res.error && res.error !== 'cancelled') showError(res.error)
            return
          }
          // Save succeeded — the temp report was copied out + cleaned up main-side.
          reportReady = false
          resetForm()
        })
      }

      if (btnCdiDiscard) {
        on(btnCdiDiscard, 'click', async () => {
          reportReady = false
          await ipc.discardCdiReport()
          resetForm()
        })
      }
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    refreshCdiTab,
    handleJobStatus,
  }
}

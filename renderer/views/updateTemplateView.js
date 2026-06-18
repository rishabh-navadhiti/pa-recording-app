// Templates tab — "Update with AI" sub-view. Extracted verbatim from
// renderer.js lines 1308-1480 (corrections-file + sample-files state,
// renderUpdateCorrectionsFile, renderUpdateTemplateFiles, validateUpdateForm,
// show/hide subview, Start handler).
//
// The multi-file sample list uses the shared renderFileList. The single
// corrections-file widget stays bespoke (it's a nullable single path, not an
// array). startTemplateUpdate returns an error STRING (truthy = failure) — this
// quirk is preserved exactly.
//
// After a successful start the original hid the subview + refreshed the job
// banner; those arrive via the onStarted callback. All show/hide uses setVisible.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'
import { renderFileList } from '../components/fileListField.js'

export function createUpdateTemplateView() {
  let btnTemplateUpdateAi, templateListView, updateTemplateView, btnUpdateTemplateBack,
      updateTemplateDoctorSel, updateTemplateCorrections, updateTemplateCorrectionsFileEl,
      btnUpdateTemplateAddCorrectionsFile, updateTemplateFilesEl, btnUpdateTemplateAddFiles,
      btnUpdateTemplateStart, updateTemplateError
  let onStartedCb = null

  let updateTemplateCorrectionsFile = null
  let updateTemplateSampleFiles     = []

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  // Single corrections file — bespoke (nullable single path, not an array).
  function renderUpdateCorrectionsFile() {
    if (!updateTemplateCorrectionsFileEl) return
    if (!updateTemplateCorrectionsFile) {
      updateTemplateCorrectionsFileEl.classList.add('create-template-files-empty')
      updateTemplateCorrectionsFileEl.textContent = 'No file added'
      return
    }
    updateTemplateCorrectionsFileEl.classList.remove('create-template-files-empty')
    updateTemplateCorrectionsFileEl.innerHTML = ''
    const row = document.createElement('div')
    row.className = 'create-template-file-row'
    const name = document.createElement('span')
    name.className = 'create-template-file-name'
    name.textContent = updateTemplateCorrectionsFile.split(/[\\/]/).pop()
    name.title = updateTemplateCorrectionsFile
    const rm = document.createElement('button')
    rm.className = 'create-template-file-remove'
    rm.textContent = '✕'
    rm.title = 'Remove'
    rm.addEventListener('click', () => {
      updateTemplateCorrectionsFile = null
      renderUpdateCorrectionsFile()
      validateUpdateForm()
    })
    row.appendChild(name)
    row.appendChild(rm)
    updateTemplateCorrectionsFileEl.appendChild(row)
  }

  function renderUpdateTemplateFiles() {
    renderFileList({
      container: updateTemplateFilesEl,
      files: updateTemplateSampleFiles,
      onChange: validateUpdateForm,
    })
  }

  function showSubview() {
    updateTemplateCorrectionsFile = null
    updateTemplateSampleFiles = []
    if (updateTemplateDoctorSel) updateTemplateDoctorSel.innerHTML = '<option value="">Select doctor…</option>'
    if (updateTemplateCorrections) updateTemplateCorrections.value = ''
    if (updateTemplateError) setVisible(updateTemplateError, false)
    if (btnUpdateTemplateStart) btnUpdateTemplateStart.disabled = true
    renderUpdateCorrectionsFile()
    renderUpdateTemplateFiles()
    if (templateListView) setVisible(templateListView, false)
    if (updateTemplateView) setVisible(updateTemplateView, true)
  }

  function hideSubview() {
    if (updateTemplateView) setVisible(updateTemplateView, false)
    if (templateListView) setVisible(templateListView, true)
  }

  function validateUpdateForm() {
    if (!btnUpdateTemplateStart) return
    const hasDoctor = updateTemplateDoctorSel && updateTemplateDoctorSel.value
    const hasCorrections = updateTemplateCorrections && updateTemplateCorrections.value.trim()
    const hasFile = !!updateTemplateCorrectionsFile
    const hasSamples = updateTemplateSampleFiles.length > 0
    btnUpdateTemplateStart.disabled = !(hasDoctor && (hasCorrections || hasFile || hasSamples))
  }

  return {
    mount(root, ctx = {}) {
      onStartedCb = ctx.onStarted || null

      btnTemplateUpdateAi                 = root.querySelector('#btn-template-update-ai')
      templateListView                    = root.querySelector('#template-list-view')
      updateTemplateView                  = root.querySelector('#update-template-view')
      btnUpdateTemplateBack               = root.querySelector('#btn-update-template-back')
      updateTemplateDoctorSel             = root.querySelector('#update-template-doctor-select')
      updateTemplateCorrections           = root.querySelector('#update-template-corrections')
      updateTemplateCorrectionsFileEl     = root.querySelector('#update-template-corrections-file')
      btnUpdateTemplateAddCorrectionsFile = root.querySelector('#btn-update-template-add-corrections-file')
      updateTemplateFilesEl               = root.querySelector('#update-template-files')
      btnUpdateTemplateAddFiles           = root.querySelector('#btn-update-template-add-files')
      btnUpdateTemplateStart              = root.querySelector('#btn-update-template-start')
      updateTemplateError                 = root.querySelector('#update-template-error')

      if (btnTemplateUpdateAi) {
        on(btnTemplateUpdateAi, 'click', async () => {
          showSubview()
          if (!ipc.getDoctorsWithTemplates) return
          const doctors = await ipc.getDoctorsWithTemplates()
          if (!updateTemplateDoctorSel) return
          updateTemplateDoctorSel.innerHTML = '<option value="">Select doctor…</option>'
          doctors.forEach(name => {
            const opt = document.createElement('option')
            opt.value = name
            opt.textContent = name
            updateTemplateDoctorSel.appendChild(opt)
          })
        })
      }

      if (btnUpdateTemplateBack) {
        on(btnUpdateTemplateBack, 'click', hideSubview)
      }

      if (updateTemplateDoctorSel) {
        on(updateTemplateDoctorSel, 'change', validateUpdateForm)
      }

      if (updateTemplateCorrections) {
        on(updateTemplateCorrections, 'input', validateUpdateForm)
      }

      if (btnUpdateTemplateAddCorrectionsFile) {
        on(btnUpdateTemplateAddCorrectionsFile, 'click', async () => {
          if (!ipc.browseCorrectionsFile) return
          const filePath = await ipc.browseCorrectionsFile()
          if (filePath) {
            updateTemplateCorrectionsFile = filePath
            renderUpdateCorrectionsFile()
            validateUpdateForm()
          }
        })
      }

      if (btnUpdateTemplateAddFiles) {
        on(btnUpdateTemplateAddFiles, 'click', async () => {
          const paths = await ipc.browseNotesFiles()
          if (Array.isArray(paths) && paths.length > 0) {
            const set = new Set(updateTemplateSampleFiles)
            paths.forEach(p => set.add(p))
            updateTemplateSampleFiles = Array.from(set)
            renderUpdateTemplateFiles()
            validateUpdateForm()
          }
        })
      }

      if (btnUpdateTemplateStart) {
        on(btnUpdateTemplateStart, 'click', async () => {
          if (updateTemplateError) setVisible(updateTemplateError, false)
          const doctorName  = updateTemplateDoctorSel ? updateTemplateDoctorSel.value : ''
          const corrections = updateTemplateCorrections ? updateTemplateCorrections.value.trim() : ''
          if (!doctorName) return

          btnUpdateTemplateStart.disabled = true
          const err = await ipc.startTemplateUpdate(
            doctorName,
            corrections,
            updateTemplateCorrectionsFile,
            updateTemplateSampleFiles
          )
          if (err) {
            if (updateTemplateError) {
              updateTemplateError.textContent = err
              setVisible(updateTemplateError, true)
            }
            btnUpdateTemplateStart.disabled = false
            return
          }
          hideSubview()
          if (onStartedCb) onStartedCb()
        })
      }
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    hideSubview,
  }
}

// Templates tab — "Create with AI" sub-view. Extracted verbatim from
// renderer.js lines 1182-1302 (createTemplateFiles state + show/hide subview +
// renderCreateTemplateFiles + validation + Start handler).
//
// The bespoke renderCreateTemplateFiles is replaced by the shared renderFileList
// (identical CSS classes + empty text). The subview show/hide toggles
// #template-list-view ↔ #create-template-view via setVisible. After a
// successful start the original hid the subview + refreshed the job banner;
// those owner actions arrive via callbacks (onStarted) supplied by templatesView.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'
import { renderFileList } from '../components/fileListField.js'

export function createCreateTemplateView() {
  let templateListView, createTemplateView, btnCreateTemplateBack,
      createTemplateDoctorInput, createTemplateFilesEl, btnCreateTemplateAddFiles,
      btnCreateTemplateStart, createTemplateError, btnTemplateCreateAi
  let onStartedCb = null

  let createTemplateFiles = []

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function renderCreateTemplateFiles() {
    renderFileList({
      container: createTemplateFilesEl,
      files: createTemplateFiles,
      onChange: updateCreateTemplateStartEnabled,
    })
  }

  function updateCreateTemplateStartEnabled() {
    if (!btnCreateTemplateStart) return
    const name = (createTemplateDoctorInput?.value || '').trim()
    btnCreateTemplateStart.disabled = !name || createTemplateFiles.length === 0
  }

  function showCreateTemplateError(msg) {
    if (!createTemplateError) return
    createTemplateError.textContent = msg
    setVisible(createTemplateError, true)
  }

  function hideCreateTemplateError() {
    if (createTemplateError) setVisible(createTemplateError, false)
  }

  function showSubview() {
    createTemplateFiles = []
    if (createTemplateDoctorInput) createTemplateDoctorInput.value = ''
    renderCreateTemplateFiles()
    hideCreateTemplateError()
    if (btnCreateTemplateStart) btnCreateTemplateStart.disabled = true
    if (templateListView)     setVisible(templateListView, false)
    if (createTemplateView)   setVisible(createTemplateView, true)
    if (createTemplateDoctorInput) createTemplateDoctorInput.focus()
  }

  function hideSubview() {
    if (createTemplateView) setVisible(createTemplateView, false)
    if (templateListView)   setVisible(templateListView, true)
  }

  return {
    mount(root, ctx = {}) {
      onStartedCb = ctx.onStarted || null

      templateListView          = root.querySelector('#template-list-view')
      createTemplateView        = root.querySelector('#create-template-view')
      btnCreateTemplateBack     = root.querySelector('#btn-create-template-back')
      createTemplateDoctorInput = root.querySelector('#create-template-doctor-input')
      createTemplateFilesEl     = root.querySelector('#create-template-files')
      btnCreateTemplateAddFiles = root.querySelector('#btn-create-template-add-files')
      btnCreateTemplateStart    = root.querySelector('#btn-create-template-start')
      createTemplateError       = root.querySelector('#create-template-error')
      btnTemplateCreateAi       = root.querySelector('#btn-template-create-ai')

      if (btnCreateTemplateBack) {
        on(btnCreateTemplateBack, 'click', hideSubview)
      }

      if (btnTemplateCreateAi) {
        on(btnTemplateCreateAi, 'click', showSubview)
      }

      if (createTemplateDoctorInput) {
        on(createTemplateDoctorInput, 'input', updateCreateTemplateStartEnabled)
      }

      if (btnCreateTemplateAddFiles) {
        on(btnCreateTemplateAddFiles, 'click', async () => {
          btnCreateTemplateAddFiles.disabled = true
          try {
            const paths = await ipc.browseNotesFiles()
            if (Array.isArray(paths) && paths.length > 0) {
              // De-duplicate against already-added files
              const set = new Set(createTemplateFiles)
              paths.forEach(p => set.add(p))
              createTemplateFiles = Array.from(set)
              renderCreateTemplateFiles()
              updateCreateTemplateStartEnabled()
            }
          } finally {
            btnCreateTemplateAddFiles.disabled = false
          }
        })
      }

      if (btnCreateTemplateStart) {
        on(btnCreateTemplateStart, 'click', async () => {
          hideCreateTemplateError()
          const name = (createTemplateDoctorInput.value || '').trim()
          if (!name) {
            showCreateTemplateError('Doctor name is required')
            return
          }
          if (createTemplateFiles.length === 0) {
            showCreateTemplateError('Add at least one source file')
            return
          }

          btnCreateTemplateStart.disabled = true
          const res = await ipc.startTemplateCreation(name, createTemplateFiles)
          if (!res.ok) {
            showCreateTemplateError(res.error || 'Failed to start')
            btnCreateTemplateStart.disabled = false
            return
          }
          // Return to the list view; the job banner will show progress
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

    // Templates tab resets the open sub-view when re-entered (original showTab).
    hideSubview,
  }
}

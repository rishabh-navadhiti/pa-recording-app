// Templates tab orchestrator — the list view (doctor list + add-doctor row +
// Create/Update buttons) plus the Create-with-AI and Update-with-AI sub-views.
// Extracted from renderer.js lines 1157-1176 (add-doctor) + composes the
// doctorList component, createTemplateView, and updateTemplateView.
//
// onEnter() is the original showTab('templates') body: reset any open sub-view,
// re-render the doctor list, and refresh the shared job banner.
//
// Cross-view services arrive via ctx:
//   - ctx.clearDoctorWarning(): hide the "no doctor" config warning (warnings view).
//   - ctx.refreshJobBanner():   refresh the shared banner (jobBanner view).

import { ipc } from '../ipc/client.js'
import { renderDoctorList } from './doctorList.js'
import { createCreateTemplateView } from './createTemplateView.js'
import { createUpdateTemplateView } from './updateTemplateView.js'

export function createTemplatesView() {
  let templateDoctorListEl, newTemplateDoctorInput, btnAddTemplateDoctor
  let clearDoctorWarning = null
  let refreshJobBanner = null

  const createView = createCreateTemplateView()
  const updateView = createUpdateTemplateView()

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  // Original removeBtn handler cleared the warning when doctors remain; the
  // doctorList component calls this after a successful removal + re-render.
  async function onDoctorRemoved() {
    const cfg = await ipc.getConfigStatus()
    if (!cfg.noDoctors && clearDoctorWarning) clearDoctorWarning()
  }

  function renderList() {
    return renderDoctorList(templateDoctorListEl, { onDoctorRemoved })
  }

  // showTab('templates') body.
  function onEnter() {
    // Reset any open sub-view when re-entering the templates tab
    createView.hideSubview()
    renderList()
    if (refreshJobBanner) refreshJobBanner()
  }

  return {
    mount(root, ctx = {}) {
      clearDoctorWarning = ctx.clearDoctorWarning || null
      refreshJobBanner   = ctx.refreshJobBanner || null

      templateDoctorListEl  = root.querySelector('#template-doctor-list')
      newTemplateDoctorInput = root.querySelector('#new-template-doctor-input')
      btnAddTemplateDoctor  = root.querySelector('#btn-add-template-doctor')

      // Sub-views fire ctx.refreshJobBanner after a successful start.
      const subCtx = { onStarted: refreshJobBanner || (() => {}) }
      createView.mount(root, subCtx)
      updateView.mount(root, subCtx)

      // --- Add doctor from Templates tab ---
      if (btnAddTemplateDoctor) {
        on(btnAddTemplateDoctor, 'click', async () => {
          const name = (newTemplateDoctorInput.value || '').trim()
          if (!name) { newTemplateDoctorInput.focus(); return }
          btnAddTemplateDoctor.disabled = true
          const res = await ipc.addDoctor(name)
          btnAddTemplateDoctor.disabled = false
          if (res.ok) {
            newTemplateDoctorInput.value = ''
            await renderList()
            if (clearDoctorWarning) clearDoctorWarning()
          }
        })
      }
      if (newTemplateDoctorInput) {
        on(newTemplateDoctorInput, 'keydown', e => {
          if (e.key === 'Enter') btnAddTemplateDoctor.click()
        })
      }
    },

    update() { /* state-independent */ },

    unmount() {
      createView.unmount()
      updateView.unmount()
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    // Called by the router on tab switch + by jobBanner success (refresh list).
    onEnter,
    renderList,
  }
}

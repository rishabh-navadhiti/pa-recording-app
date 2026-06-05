// Doctor list with inline view/edit modes — extracted verbatim from
// renderer.js lines 774-923 (renderDoctorList + renderViewMode/renderEditMode).
//
// Shared component used by both the Settings view and the Templates tab.
// Renders each doctor as a row with name / template / specialty and ✎ edit +
// ✕ remove controls; the edit mode swaps in a name input, change-template
// button, specialty dropdown, and Save/Cancel.
//
// The original referenced module-level `warnDoctor` + updateConfigWarningsVisibility
// inside the remove handler. Those are now injected via the optional
// `onDoctorRemoved` callback so this component has no hidden coupling.

import { ipc } from '../ipc/client.js'
import { DOCTOR_SPECIALTIES, specialtyLabel } from '../constants.js'

/**
 * @param {HTMLElement} containerEl  The list container to render into.
 * @param {object}      [opts]
 * @param {Function}    [opts.onDoctorRemoved]  async () => void — called after a
 *        successful removal + re-render (original cleared the "no doctor" warning).
 */
export async function renderDoctorList(containerEl, opts = {}) {
  const el = containerEl
  if (!el) return
  const { onDoctorRemoved } = opts
  const doctors = await ipc.getDoctors()
  el.innerHTML = ''
  if (doctors.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'doctor-empty'
    empty.textContent = 'No doctors added yet'
    el.appendChild(empty)
    return
  }
  doctors.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'doctor-row'

    function renderViewMode() {
      row.innerHTML = ''
      row.classList.remove('doctor-row--editing')

      const nameSpan = document.createElement('span')
      nameSpan.className = 'doctor-name'
      nameSpan.textContent = doc.name

      let templateEl
      if (doc.templatePath) {
        templateEl = document.createElement('span')
        templateEl.className = 'doctor-template'
        templateEl.textContent = doc.templatePath.split(/[\\/]/).pop()
      } else {
        templateEl = document.createElement('button')
        templateEl.className = 'doctor-select-template'
        templateEl.textContent = 'Select Template'
        templateEl.addEventListener('click', async () => {
          const res = await ipc.updateDoctorTemplate(doc.id)
          if (res.ok) { doc.templatePath = res.doctor.templatePath; renderViewMode() }
        })
      }

      const editBtn = document.createElement('button')
      editBtn.className = 'doctor-edit'
      editBtn.textContent = '✎'
      editBtn.title = 'Edit doctor'
      editBtn.addEventListener('click', () => renderEditMode())

      const removeBtn = document.createElement('button')
      removeBtn.className = 'doctor-remove'
      removeBtn.textContent = '✕'
      removeBtn.title = 'Remove doctor'
      removeBtn.addEventListener('click', async () => {
        await ipc.removeDoctor(doc.id)
        await renderDoctorList(el, opts)
        if (onDoctorRemoved) await onDoctorRemoved()
      })

      row.appendChild(nameSpan)
      row.appendChild(templateEl)
      if (doc.specialty) {
        const specSpan = document.createElement('span')
        specSpan.className = 'doctor-specialty'
        specSpan.textContent = specialtyLabel(doc.specialty)
        specSpan.title = `Specialty: ${specialtyLabel(doc.specialty)}`
        row.appendChild(specSpan)
      }
      row.appendChild(editBtn)
      row.appendChild(removeBtn)
    }

    function renderEditMode() {
      row.innerHTML = ''
      row.classList.add('doctor-row--editing')

      const nameInput = document.createElement('input')
      nameInput.className = 'doctor-edit-name-input'
      nameInput.value = doc.name
      nameInput.placeholder = 'Doctor name'

      const templateLabel = document.createElement('span')
      templateLabel.className = 'doctor-edit-template-label'
      templateLabel.textContent = doc.templatePath ? doc.templatePath.split(/[\\/]/).pop() : 'No template'

      const changeTemplateBtn = document.createElement('button')
      changeTemplateBtn.className = 'doctor-edit-change-template'
      changeTemplateBtn.textContent = 'Change Template'
      changeTemplateBtn.addEventListener('click', async () => {
        const res = await ipc.updateDoctorTemplate(doc.id)
        if (res.ok) {
          doc.templatePath = res.doctor.templatePath
          templateLabel.textContent = doc.templatePath.split(/[\\/]/).pop()
        }
      })

      // Specialty dropdown — closed enum from CDI v1 plan §E. Lowercase value
      // is what gets persisted; the skill loads
      // standards/specialties/<value>.md and emits CDI_SKIPPED when the file
      // is missing (only orthopedics.md exists in v1).
      const specialtySelect = document.createElement('select')
      specialtySelect.className = 'doctor-edit-specialty'
      const blankOpt = document.createElement('option')
      blankOpt.value = ''
      blankOpt.textContent = 'Specialty…'
      specialtySelect.appendChild(blankOpt)
      for (const sp of DOCTOR_SPECIALTIES) {
        const opt = document.createElement('option')
        opt.value = sp.value
        opt.textContent = sp.label
        specialtySelect.appendChild(opt)
      }
      specialtySelect.value = doc.specialty || ''

      const saveBtn = document.createElement('button')
      saveBtn.className = 'doctor-edit-save small'
      saveBtn.textContent = 'Save'
      saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim()
        if (!newName) return
        const newSpecialty = specialtySelect.value || null
        const res = await ipc.updateDoctor(doc.id, newName)
        if (!res.ok) return
        doc.name = newName
        if (newSpecialty !== (doc.specialty || null)) {
          const r2 = await ipc.updateDoctorSpecialty(doc.id, newSpecialty)
          if (r2 && r2.ok) doc.specialty = newSpecialty
        }
        renderViewMode()
      })

      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click() })

      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'doctor-edit-cancel small secondary'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', () => renderViewMode())

      row.appendChild(nameInput)
      row.appendChild(templateLabel)
      row.appendChild(changeTemplateBtn)
      row.appendChild(specialtySelect)
      row.appendChild(saveBtn)
      row.appendChild(cancelBtn)
    }

    renderViewMode()
    el.appendChild(row)
  })
}

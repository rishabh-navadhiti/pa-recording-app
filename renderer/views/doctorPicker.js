// Doctor picker — shown at session start when multiple doctors exist.
// Extracted verbatim from renderer.js lines 1022-1042.
//
// Triggered by main via the router's onPickDoctor(doctors) push. Picking a
// doctor (or Cancel) resolves the selection in main via ipc.selectDoctor(id|null).
//
// The original toggled the action-buttons container with inline
// `actionButtons.style.display`. To honour the single-visibility-mechanism rule
// we now use setVisible (the `.hidden` class) on it — same observable effect
// (the picker overlays the action buttons while open).

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

export function createDoctorPicker() {
  let doctorPicker, doctorPickerList, btnDoctorPickerCancel, actionButtons

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function show(doctors) {
    setVisible(doctorPicker, true)
    setVisible(actionButtons, false)
    doctorPickerList.innerHTML = ''
    doctors.forEach(doc => {
      const btn = document.createElement('button')
      btn.textContent = doc.name
      btn.addEventListener('click', () => {
        setVisible(doctorPicker, false)
        setVisible(actionButtons, true)
        ipc.selectDoctor(doc.id)
      })
      doctorPickerList.appendChild(btn)
    })
  }

  return {
    mount(root) {
      doctorPicker          = root.querySelector('#doctor-picker')
      doctorPickerList      = root.querySelector('#doctor-picker-list')
      btnDoctorPickerCancel = root.querySelector('#btn-doctor-picker-cancel')
      actionButtons         = root.querySelector('#action-buttons')

      on(btnDoctorPickerCancel, 'click', () => {
        setVisible(doctorPicker, false)
        setVisible(actionButtons, true)
        ipc.selectDoctor(null)
      })
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    show,
  }
}

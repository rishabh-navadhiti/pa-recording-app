// Single visibility mechanism for the whole renderer: the `.hidden` CSS class.
// Replaces the mix of `.hidden` + inline `el.style.display` that caused
// cascade bugs. Always toggle visibility through here.

export function setVisible(el, visible) {
  if (!el) return
  el.classList.toggle('hidden', !visible)
}

export function show(el) { setVisible(el, true) }
export function hide(el) { setVisible(el, false) }

// Action button factory — disables itself while its async onClick runs, then
// re-enables. Behaviour-identical to the original makeButton().
//
// @param {string}   label
// @param {Function|null} onClick  async handler; pass null for a static/disabled button.
// @param {string}   [variant]     CSS class: 'warning' | 'danger' | 'secondary' | ...
export function makeButton(label, onClick, variant) {
  const btn = document.createElement('button')
  btn.textContent = label
  if (variant) btn.classList.add(variant)
  if (onClick) {
    btn.addEventListener('click', () => {
      btn.disabled = true
      onClick().catch(console.error).finally(() => { btn.disabled = false })
    })
  }
  return btn
}

// Thin wrapper over the native confirm() dialog. Exists so views don't call the
// global directly — which makes it stubbable in jsdom tests (jsdom does not
// implement window.confirm). Falls back to true if confirm is unavailable.
export function confirmAction(message) {
  return (typeof confirm === 'function') ? confirm(message) : true
}

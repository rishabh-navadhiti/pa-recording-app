// The single place the renderer touches window.api.
//
// Views import { ipc } and call ipc.getDoctors(), ipc.onStateChange(cb), etc.
// — they never reference window.api directly. Missing methods (older main
// process) resolve to a logged no-op instead of throwing, which consolidates
// the scattered `if (!api.x) return` feature-detects into one place.
//
// window.api is read lazily per call so tests can inject a mock after import.

function rawApi() {
  return (typeof window !== 'undefined' && window.api) ? window.api : {}
}

export const ipc = new Proxy({}, {
  get(_target, method) {
    const name = String(method)
    return (...args) => {
      const api = rawApi()
      const fn = api[name]
      if (typeof fn === 'function') return fn.apply(api, args)
      console.warn(`[ipc] window.api.${name} is unavailable — returning no-op`)
      return undefined
    }
  },
})

/** True if window.api exposes the given method (for the rare case a view needs to branch). */
export function hasMethod(name) {
  return typeof rawApi()[name] === 'function'
}

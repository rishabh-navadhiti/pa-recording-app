'use strict'

/**
 * IPC handler envelope helpers.
 *
 * Phase 3 keeps existing return shapes byte-identical (some handlers return
 * {ok,error} objects, some return raw values — the renderer already handles
 * both). These helpers are opt-in conveniences for the {ok,error} handlers so
 * a thrown error becomes a clean {ok:false,error} instead of an unhandled
 * rejection that rejects the renderer's invoke() promise.
 */

/** Standard success envelope. */
function respondOk(extra = {}) {
  return { ok: true, ...extra }
}

/** Standard error envelope. */
function respondErr(error) {
  return { ok: false, error: typeof error === 'string' ? error : (error && error.message) || 'unknown error' }
}

/**
 * Wrap an {ok,error}-returning handler so any throw is normalized to
 * {ok:false, error}. Use ONLY for handlers whose contract is the {ok,error}
 * envelope — do NOT wrap raw-value (query) handlers, as that would change their
 * shape on error and break the renderer's expectations.
 *
 * @param {Function} fn  async (event, ...args) => {ok,...} | throws
 * @returns {Function}
 */
function wrapHandler(fn) {
  return async (...args) => {
    try {
      const result = await fn(...args)
      // If the handler already returned an envelope, pass it through; otherwise
      // wrap a bare success.
      if (result && typeof result === 'object' && 'ok' in result) return result
      return respondOk(result === undefined ? {} : { value: result })
    } catch (e) {
      return respondErr(e)
    }
  }
}

module.exports = { respondOk, respondErr, wrapHandler }

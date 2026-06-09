'use strict'

/**
 * Holds the identity of the current recording session:
 * the selected doctor, the active DB session row, and the session folder.
 *
 * Also owns the doctorPickerResolver cross-handler promise — the promise set
 * in start-session (when >1 doctor exists) and resolved by select-doctor or
 * cancelled by stop-session.
 *
 * @returns {{
 *   get(): {doctorId: string|null, sessionId: string|null, dir: string|null},
 *   setDoctor(id: string): void,
 *   setSession(id: string, dir: string): void,
 *   clear(): void,
 *   awaitDoctorPick(): Promise<string|null>,
 *   resolveDoctorPick(id: string): void,
 *   cancelDoctorPick(): void,
 * }}
 */
function createSessionStore() {
  let doctorId  = null
  let sessionId = null
  let dir       = null

  // Pending doctor pick — null when no pick is in flight.
  let _resolve = null

  return {
    get() { return { doctorId, sessionId, dir } },

    setDoctor(id)         { doctorId = id },
    setSession(id, d)     { sessionId = id; dir = d },

    clear() {
      doctorId = null
      sessionId = null
      dir = null
      // Cancel any pending pick so the promise doesn't hang.
      if (_resolve) { _resolve(null); _resolve = null }
    },

    /**
     * Returns a Promise that resolves with the selected doctor ID (or null
     * if the pick was cancelled).  Throws if a pick is already in flight.
     */
    awaitDoctorPick() {
      if (_resolve) throw new Error('A doctor pick is already pending')
      return new Promise(resolve => { _resolve = resolve })
    },

    resolveDoctorPick(id) {
      if (_resolve) { _resolve(id); _resolve = null }
    },

    cancelDoctorPick() {
      if (_resolve) { _resolve(null); _resolve = null }
    },
  }
}

module.exports = { createSessionStore }

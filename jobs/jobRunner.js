'use strict'

/**
 * Single-flight lock for template-create, template-update, and prechart jobs.
 * Replaces the templateJobProc / templateJobStartMs / templateJobEventId globals
 * and the scattered guard checks.
 *
 * Phase 3 adds job descriptors (templateCreate.js, etc.) to dedup the ~70%-
 * identical spawn bodies. Phase 1 just owns the lock + in-memory tracking.
 *
 * @param {object} opts
 * @param {object} opts.jobState  A createJobStateStore() instance.
 * @param {Function} [opts.log]  Logger function.
 * @returns {JobRunner}
 */
function createJobRunner({ jobState, log } = {}) {
  const _log = log || ((msg) => console.error(msg))

  let _proc     = null   // live child process
  let _startMs  = 0
  let _eventId  = null
  let _type     = null   // 'create' | 'update' | 'prechart'

  return {
    /** True if a job is currently running. */
    isRunning() { return _proc !== null },

    /** Active job type, or null. */
    currentType() { return _type },

    /** Milliseconds since the job started (0 if idle). */
    elapsedMs() { return _proc ? Date.now() - _startMs : 0 },

    /**
     * Start a job.  Returns {ok:false, error} if one is already running.
     *
     * @param {string}   type   'create' | 'update' | 'prechart'
     * @param {object}   proc   The spawned child process returned by spawnClaude.
     * @param {string|null} eventId  DB processing_events row id (may be null on DB error).
     */
    start(type, proc, eventId) {
      if (_proc) return { ok: false, error: 'A job is already running' }
      _proc    = proc
      _startMs = Date.now()
      _eventId = eventId
      _type    = type
      return { ok: true }
    },

    /**
     * Clear the running job (called from onClose / onError in the spawn function).
     * Does NOT kill the process — the spawn function manages the child lifecycle.
     */
    clear() {
      _proc    = null
      _startMs = 0
      _eventId = null
      _type    = null
    },

    /**
     * Cancel a running job (called from cancel-template-creation IPC handler).
     * Kills the process and clears state.  Returns false if no job is running.
     */
    cancel() {
      if (!_proc) return false
      try { _proc.kill() } catch (e) {
        _log(`[jobs] cancel kill failed: ${e.message}`)
      }
      this.clear()
      return true
    },

    /**
     * Called at startup to handle jobs that were 'running' when the app last
     * crashed — the child process died with the app, so the DB/disk marker
     * is orphaned.  Flips status to 'failed' via the jobState store.
     */
    clearStale() {
      if (jobState) jobState.clearStaleRunning()
    },

    /** Current event ID (for DB finishEvent calls in the spawn closure). */
    getEventId() { return _eventId },
    setEventId(id) { _eventId = id },

    /** Wall-clock start in ms (for duration calculation in onClose). */
    getStartMs() { return _startMs },
  }
}

module.exports = { createJobRunner }

'use strict'

/**
 * Owns the live record.py child process and the stdin communication protocol.
 *
 * **Decision #1 (load-bearing — do NOT change the protocol strings):**
 * record.py reads commands from stdin. The exact strings are:
 *   stop    → 'stop\n'    + stdin.end()   (stop-recording: triggers WAV→MP3 flush)
 *   discard → 'discard\n' + stdin.end()   (discard-recording: skips transcriber + WAV→MP3, cleans up silently)
 *   pause   → 'pause\n'
 *   resume  → 'resume\n'
 * TerminateProcess (kill()) on Windows skips Python's WAV→MP3 flush — that is why
 * stop writes to stdin instead of calling kill(). See docs/DECISIONS.md Decision #1.
 * The discard command is a separate protocol extension: on discard we intentionally
 * skip the flush, so Python exits cleanly without printing any ERROR to stderr.
 *
 * Also owns the patientNameResolver cross-handler promise — set in stop-recording
 * and resolved by submit-patient-name — as awaitPatientName / resolvePatientName.
 *
 * @returns {RecorderController}
 */
function createRecorderController() {
  let _proc             = null   // live record.py child process
  let _tempMp3Path      = null   // tmp path while recording (before case folder exists)
  let _pendingDuration  = null   // parsed from DURATION_SECONDS: stdout line
  let _patientResolve   = null   // pending patient-name Promise resolver
  // In-recording pre-chart context for the current recording (text + attachment
  // file paths). Captured live via the Pre-chart screen; consumed at
  // stop-recording and written into the case folder as prechart.md.
  let _prechart         = { text: '', files: [] }

  return {
    // ---- process lifecycle ------------------------------------------------

    /** Store the spawned record.py process. */
    setProcess(proc, tempMp3Path) {
      _proc        = proc
      _tempMp3Path = tempMp3Path
    },

    isRecording() { return _proc !== null },
    getProcess()  { return _proc },
    getTempMp3Path() { return _tempMp3Path },

    /** Write 'stop\n' to stdin and end the stream. Behavior-preserving: see Decision #1. */
    stop() {
      if (!_proc) return
      const proc = _proc
      _proc = null          // null before write so a second stop() is a no-op
      try {
        proc.stdin.write('stop\n')
        proc.stdin.end()
      } catch (e) {
        // Process may have already exited.
        console.error(`[recorder] stdin write(stop) failed: ${e.message}`)
      }
      return proc           // caller awaits exit to get the WAV→MP3 duration
    },

    /** Write 'pause\n' to stdin. */
    pause() {
      if (!_proc) return
      try { _proc.stdin.write('pause\n') } catch {}
    },

    /** Write 'resume\n' to stdin. */
    resume() {
      if (!_proc) return
      try { _proc.stdin.write('resume\n') } catch {}
    },

    /**
     * Discard the recording — sends 'discard\n' so Python skips the realtime
     * transcriber and WAV→MP3 conversion and exits silently (Decision #1 extension).
     * Callers must also fs.unlink the temp MP3/WAV after Python exits.
     */
    discard() {
      if (!_proc) return
      const proc = _proc
      _proc        = null
      _tempMp3Path = null
      _prechart    = { text: '', files: [] }   // drop pre-chart for the discarded recording
      try {
        proc.stdin.write('discard\n')
        proc.stdin.end()
      } catch {}
      return proc
    },

    clearProcess() {
      _proc        = null
      _tempMp3Path = null
      _prechart    = { text: '', files: [] }
    },

    // ---- in-recording pre-chart context ----------------------------------

    /** Store the pre-chart context captured during the current recording. */
    setPrechart({ text, files } = {}) {
      _prechart = {
        text: typeof text === 'string' ? text : '',
        files: Array.isArray(files) ? files.filter(f => typeof f === 'string' && f) : [],
      }
    },

    /** Return the current pre-chart context (does not clear). */
    getPrechart() { return { text: _prechart.text, files: _prechart.files.slice() } },

    /** Return the current pre-chart context, then reset it. */
    consumePrechart() {
      const p = { text: _prechart.text, files: _prechart.files.slice() }
      _prechart = { text: '', files: [] }
      return p
    },

    /** Reset the pre-chart context without reading it. */
    clearPrechart() { _prechart = { text: '', files: [] } },

    // ---- audio duration side-channel -------------------------------------

    /** Called when record.py emits 'DURATION_SECONDS: <float>' on stdout. */
    setPendingDuration(seconds) { _pendingDuration = seconds },

    /** Consume and return the pending duration (clears after read). */
    consumePendingDuration() {
      const d = _pendingDuration
      _pendingDuration = null
      return d
    },

    // ---- patient-name cross-handler promise ------------------------------

    /**
     * Await the patient name entered by the scribe.
     * Called from stop-recording; resolves when submit-patient-name fires.
     * Only one patient-name promise may be pending at a time.
     */
    awaitPatientName() {
      if (_patientResolve) throw new Error('A patient-name request is already pending')
      return new Promise(resolve => { _patientResolve = resolve })
    },

    /**
     * Deliver the patient name + multi-patient flag from submit-patient-name IPC handler.
     * Resolves the promise started by awaitPatientName() with { name, multiPatient }.
     */
    resolvePatientName({ name, multiPatient = false } = {}) {
      if (_patientResolve) { _patientResolve({ name: name || null, multiPatient: !!multiPatient }); _patientResolve = null }
    },

    /** Cancel a pending patient-name prompt (e.g. on discard or stop-session). */
    cancelPatientName() {
      if (_patientResolve) { _patientResolve({ name: null, multiPatient: false }); _patientResolve = null }
    },
  }
}

module.exports = { createRecorderController }

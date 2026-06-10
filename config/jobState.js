'use strict'

const fs = require('fs')

/**
 * Persistent job state store — reads/writes .template_job.json.
 * Shared by template-create, template-update, and prechart jobs.
 *
 * @param {string} jobStatePath  Absolute path to .template_job.json.
 * @param {Function} safeWrite  (filePath, data) → void  Atomic write helper.
 * @returns {{ load(): object, save(job: object): void, clearStaleRunning(): void }}
 */
function createJobStateStore(jobStatePath, safeWrite) {
  function load() {
    try {
      return JSON.parse(fs.readFileSync(jobStatePath, 'utf8'))
    } catch {
      return { status: 'idle' }
    }
  }

  return {
    load,

    save(job) {
      try {
        safeWrite(jobStatePath, JSON.stringify(job, null, 2))
      } catch (e) {
        // Best-effort — a failed write doesn't break the pipeline
        console.error(`[template-job] WARNING: failed to write job status: ${e.message}`)
      }
    },

    /**
     * On startup, any job recorded as 'running' died with the previous process.
     * Flip its status to 'failed' so the renderer doesn't show an infinite spinner.
     */
    clearStaleRunning() {
      const job = load()
      if (job.status === 'running') {
        this.save({ ...job, status: 'failed', finishedAt: new Date().toISOString() })
      }
    },
  }
}

module.exports = { createJobStateStore }

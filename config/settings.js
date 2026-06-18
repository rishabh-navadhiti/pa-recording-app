'use strict'

const fs = require('fs')

const DEFAULT_SETTINGS = Object.freeze({
  autoRecord: false,
  manualDeviceSelection: true,
  selectedDeviceIndex: null,
  soapModel:      'gemini-3.5-flash',
  templateModel:  'claude-opus-4-8',
  templateEffort: 'max',
  enableIcd: false,
  enableCdi: false,
  cdiMode:   'balanced',
  enableEmScore: false,
  enablePatientSummary: false,
  realtimeTranscription: false,
})

// Valid soapModel option ids. Kept inline to avoid a runtime require in the normalizer.
const VALID_SOAP_OPTIONS = new Set(['gemini-3.5-flash', 'sonnet-4-6-api', 'sonnet-4-6-agentic'])

/**
 * Atomic write with retry for transient Windows AV / file-indexer locks.
 * Writes to .tmp then renames, identical to safeWriteFile() in main.js.
 */
function safeWrite(filePath, data) {
  const tmp = filePath + '.tmp'
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmp, data, 'utf8')
      fs.renameSync(tmp, filePath)
      return
    } catch (e) {
      lastErr = e
      if (attempt < 3 && (e.code === 'EPERM' || e.code === 'EBUSY')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
      } else break
    }
  }
  throw lastErr
}

function applyInvariants(s) {
  // Map legacy raw model ids (e.g. 'claude-sonnet-4-6') and unknown values
  // to the default API option id. Non-destructive: only soapModel is touched.
  if (!VALID_SOAP_OPTIONS.has(s.soapModel)) s.soapModel = 'sonnet-4-6-api'
  // Invariant: CDI runs after ICD and needs codes baked into the note.
  // Normalize so every consumer sees consistent state — including legacy
  // settings.json that has enableCdi without enableIcd.
  if (s.enableCdi) s.enableIcd = true
  return s
}

/**
 * Create a cached settings store for the given settings file path.
 *
 * @param {string} settingsPath  Absolute path to settings.json.
 * @returns {{ get(): object, save(patch: object): void, reload(): void }}
 */
function createSettingsStore(settingsPath) {
  let cache = null

  function load() {
    try {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }
      return applyInvariants(merged)
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  return {
    /** Return cached settings (reads from disk on first call). */
    get() {
      if (!cache) cache = load()
      return cache
    },

    /**
     * Merge patch into current settings, write to disk, update cache.
     * @param {object} patch
     */
    save(patch) {
      const current = this.get()
      const next = applyInvariants({ ...current, ...patch })
      fs.mkdirSync(require('path').dirname(settingsPath), { recursive: true })
      safeWrite(settingsPath, JSON.stringify(next, null, 2))
      cache = next
    },

    /** Force a re-read from disk (used after notes-dir change). */
    reload() {
      cache = load()
    },
  }
}

module.exports = { createSettingsStore, DEFAULT_SETTINGS }

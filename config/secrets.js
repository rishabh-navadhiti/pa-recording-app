'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Create a secrets store backed by the repo's .env file.
 * In Phase 6 the implementation swaps to DPAPI/Keychain behind the same interface.
 *
 * @param {string} envPath  Absolute path to the .env file (typically <repo>/.env).
 * @returns {{ getElevenLabsKey(): string|null, setElevenLabsKey(key: string): void }}
 */
function createSecretStore(envPath) {
  function readEnv() {
    try {
      return Object.fromEntries(
        fs.readFileSync(envPath, 'utf8')
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#') && l.includes('='))
          .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
      )
    } catch { return {} }
  }

  function writeKey(key, value) {
    let lines = []
    try { lines = fs.readFileSync(envPath, 'utf8').split('\n') } catch {}
    const re = new RegExp(`^${key}=`)
    if (lines.some(l => re.test(l))) {
      lines = lines.map(l => re.test(l) ? `${key}=${value}` : l)
    } else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('')
      lines.push(`${key}=${value}`)
    }
    fs.writeFileSync(envPath, lines.join('\n'), 'utf8')
  }

  return {
    getElevenLabsKey() {
      return readEnv()['ELEVENLABS_API_KEY'] || null
    },
    setElevenLabsKey(key) {
      writeKey('ELEVENLABS_API_KEY', key)
    },
    getNotesDirPath() {
      return readEnv()['NOTES_DIR_PATH'] || null
    },
    setNotesDirPath(p) {
      writeKey('NOTES_DIR_PATH', p)
    },
    getAnthropicKey() {
      return readEnv()['ANTHROPIC_API_KEY'] || null
    },
    setAnthropicKey(key) {
      writeKey('ANTHROPIC_API_KEY', key)
    },
  }
}

module.exports = { createSecretStore }

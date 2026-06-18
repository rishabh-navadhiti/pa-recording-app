'use strict'

// ElevenLabs speech-to-text client + transcript formatter.
//
// Ported from python/transcribe.py (decision A7) so transcription joins the
// Node test harness and the bundled Python shrinks. The HTTP call uses native
// fetch/FormData/Blob (Electron's Node, and system-Node ≥18); no new dep.
//
// formatTranscript() is a BYTE-FOR-BYTE port of the Python format_transcript()
// — the downstream SOAP/CDI pipeline consumes transcript.md, so the markdown
// shape must not drift. Guarded by tests/unit/transcription.test.js.

const fs   = require('fs')
const path = require('path')

const ELEVENLABS_API_URL         = 'https://api.elevenlabs.io/v1/speech-to-text'
const ELEVENLABS_MODEL            = 'scribe_v2'
const DEFAULT_TIMEOUT_MS          = 300000  // matches transcribe.py's requests timeout=300
const SCRIBE_V2_COST_PER_HOUR_USD = 0.22   // verify at elevenlabs.io/pricing

/**
 * Extract per-call metrics from a raw ElevenLabs scribe_v2 response.
 * All fields are nullable — callers can pass the result straight to finishEvent().
 *
 * @param {object} data  Parsed ElevenLabs JSON response.
 * @returns {{ languageCode: string|null, speakerCount: number|null, audioDurationSeconds: number|null }}
 */
function extractTranscriptMetrics(data) {
  const words = (data && data.words) || []
  const speakerIds = new Set()
  for (const w of words) {
    if (w && w.type === 'word' && 'speaker_id' in w) speakerIds.add(w.speaker_id)
  }
  return {
    languageCode:         (data && data.language_code)  ?? null,
    speakerCount:         speakerIds.size > 0 ? speakerIds.size : null,
    audioDurationSeconds: (data && data.audio_duration) ?? null,
  }
}

/**
 * Build markdown from the words[] array returned by ElevenLabs. Groups
 * consecutive same-speaker words into paragraphs and maps raw speaker IDs to
 * "Speaker N" labels in first-seen order. Falls back to plain `text` when there
 * is no word-level data. Faithful port of transcribe.py:format_transcript.
 *
 * @param {object} data  Parsed ElevenLabs JSON response.
 * @returns {string} transcript markdown.
 */
function formatTranscript(data) {
  const words = (data && data.words) || []

  // Merge consecutive same-speaker words into utterances.
  const segments = []
  for (const w of words) {
    if (!w || w.type !== 'word') continue
    const speakerId = ('speaker_id' in w) ? w.speaker_id : 'unknown'
    const text      = ('text' in w)       ? w.text       : ''
    const last = segments[segments.length - 1]
    if (last && last[0] === speakerId) {
      last[1] = last[1] + ' ' + text
    } else {
      segments.push([speakerId, text])
    }
  }

  if (segments.length === 0) {
    // Fallback to plain text if no word-level data.
    const plain = ((data && data.text) || '').trim()
    return `## Transcript\n\n${plain || '*(No transcription available)*'}\n`
  }

  // Map raw speaker IDs to human-readable labels (first-seen order).
  const speakerMap = new Map()
  let counter = 1
  const label = (sid) => {
    if (!speakerMap.has(sid)) {
      speakerMap.set(sid, `Speaker ${counter}`)
      counter += 1
    }
    return speakerMap.get(sid)
  }

  const lines = ['## Transcript', '']
  for (const [sid, text] of segments) {
    lines.push(`**${label(sid)}:** ${text.trim()}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * POST the audio file to ElevenLabs scribe_v2 with diarization and return the
 * parsed JSON. Throws an Error on non-2xx (message includes the status code so
 * the markers.js regexes can classify it as auth/rate-limit upstream); the
 * thrown error also carries `.status`.
 *
 * @param {object}   opts
 * @param {string}   opts.mp3Path       Absolute path to the source audio.
 * @param {string}   opts.apiKey        ElevenLabs API key.
 * @param {AbortSignal} [opts.signal]   Optional external cancel signal.
 * @param {Function} [opts.fetchImpl]   Injected fetch (tests); defaults to global fetch.
 * @param {number}   [opts.timeoutMs]   Request timeout (default 5 min).
 * @returns {Promise<object>} parsed JSON response.
 */
async function requestTranscription({ mp3Path, apiKey, signal, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch
  const buf = fs.readFileSync(mp3Path)

  const form = new FormData()
  form.append('file', new Blob([buf]), path.basename(mp3Path))
  form.append('model_id', ELEVENLABS_MODEL)
  form.append('diarize', 'true')

  // Timeout via a local AbortController; forward an external signal if given.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('ElevenLabs request timed out')), timeoutMs)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }

  let res
  try {
    res = await doFetch(ELEVENLABS_API_URL, {
      method:  'POST',
      headers: { 'xi-api-key': apiKey },  // do NOT set Content-Type — fetch adds the multipart boundary
      body:    form,
      signal:  controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch {}
    const err = new Error(`ElevenLabs API error ${res.status}: ${body.slice(0, 512)}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * Transcribe `mp3Path` and write the formatted markdown to `transcriptDest`.
 *
 * @param {object} opts  See requestTranscription, plus:
 * @param {string} opts.transcriptDest  Where to write transcript.md.
 * @returns {Promise<{ markdown: string }>}
 */
async function transcribeToFile(opts) {
  const { transcriptDest } = opts
  const data = await requestTranscription(opts)
  const markdown = formatTranscript(data)
  fs.mkdirSync(path.dirname(transcriptDest), { recursive: true })
  fs.writeFileSync(transcriptDest, markdown, 'utf8')
  const { languageCode, speakerCount, audioDurationSeconds } = extractTranscriptMetrics(data)
  return { markdown, languageCode, speakerCount, audioDurationSeconds }
}

/**
 * Read the realtime transcript JSON written by Python's RealtimeTranscriber.
 * Returns the parsed object if it contains usable data, or null if missing,
 * unreadable, or empty — callers fall back to the batch API in that case.
 *
 * @param {string} jsonPath  Absolute path to the <name>_realtime.json file.
 * @returns {object|null}
 */
function readRealtimeTranscript(jsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    if (!data) return null
    const hasWords = Array.isArray(data.words) && data.words.length > 0
    const hasText  = typeof data.text === 'string' && data.text.trim().length > 0
    return (hasWords || hasText) ? data : null
  } catch {
    return null
  }
}

module.exports = {
  formatTranscript,
  extractTranscriptMetrics,
  requestTranscription,
  transcribeToFile,
  readRealtimeTranscript,
  ELEVENLABS_API_URL,
  ELEVENLABS_MODEL,
  SCRIBE_V2_COST_PER_HOUR_USD,
}

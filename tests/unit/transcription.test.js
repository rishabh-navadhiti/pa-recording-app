'use strict'

// Golden-file + behaviour tests for the ElevenLabs transcription port (Phase 5,
// decision A7). The fidelity gate: formatTranscript() must produce the SAME
// markdown the old python/transcribe.py:format_transcript produced — the
// downstream SOAP/CDI pipeline consumes transcript.md, so the shape can't drift.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  formatTranscript,
  extractTranscriptMetrics,
  requestTranscription,
  transcribeToFile,
  SCRIBE_V2_COST_PER_HOUR_USD,
} = require('../../src/pipeline/elevenLabs')
const { ELEVENLABS_AUTH_ERROR, ELEVENLABS_RATE_LIMITED } = require('../../src/llm/skill-io/markers')

// A representative scribe_v2 diarized response: two speakers, consecutive-word
// merging, a non-'word' spacing token, and speaker_0 reappearing (so the
// Speaker-N label must be reused, not re-numbered).
const SAMPLE = {
  language_code: 'en',
  audio_duration: 120.5,
  text: 'Hello doctor Hi there Back',
  words: [
    { text: 'Hello',  type: 'word',    speaker_id: 'speaker_0', start: 0.1, end: 0.5 },
    { text: ' ',       type: 'spacing', speaker_id: 'speaker_0', start: 0.5, end: 0.6 },
    { text: 'doctor', type: 'word',    speaker_id: 'speaker_0', start: 0.6, end: 1.0 },
    { text: 'Hi',     type: 'word',    speaker_id: 'speaker_1', start: 1.1, end: 1.4 },
    { text: 'there',  type: 'word',    speaker_id: 'speaker_1', start: 1.4, end: 1.8 },
    { text: 'Back',   type: 'word',    speaker_id: 'speaker_0', start: 2.0, end: 2.4 },
  ],
}

const GOLDEN =
  '## Transcript\n\n' +
  '**Speaker 1:** Hello doctor\n\n' +
  '**Speaker 2:** Hi there\n\n' +
  '**Speaker 1:** Back\n'

test('formatTranscript matches the golden markdown (speaker grouping + label reuse)', () => {
  assert.strictEqual(formatTranscript(SAMPLE), GOLDEN)
})

test('formatTranscript filters non-word tokens and merges consecutive speakers', () => {
  const md = formatTranscript({
    words: [
      { text: 'one', type: 'word', speaker_id: 's', start: 0, end: 1 },
      { text: '...', type: 'spacing', speaker_id: 's', start: 1, end: 1 },
      { text: 'two', type: 'word', speaker_id: 's', start: 1, end: 2 },
    ],
  })
  assert.strictEqual(md, '## Transcript\n\n**Speaker 1:** one two\n')
})

test('formatTranscript falls back to plain text when no word data', () => {
  assert.strictEqual(
    formatTranscript({ text: '  just plain text  ' }),
    '## Transcript\n\njust plain text\n'
  )
})

test('formatTranscript emits the no-transcription placeholder when empty', () => {
  assert.strictEqual(
    formatTranscript({}),
    '## Transcript\n\n*(No transcription available)*\n'
  )
})

test('transcribeToFile writes the formatted markdown to disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-'))
  const mp3 = path.join(dir, 'rec.mp3')
  fs.writeFileSync(mp3, Buffer.from([0x49, 0x44, 0x33]))  // tiny stand-in
  const dest = path.join(dir, 'sub', 'transcript.md')

  const fetchImpl = async (url, opts) => {
    assert.strictEqual(opts.method, 'POST')
    assert.strictEqual(opts.headers['xi-api-key'], 'k-123')
    assert.ok(opts.body instanceof FormData, 'body is multipart FormData')
    return { ok: true, status: 200, json: async () => SAMPLE }
  }

  const { markdown, languageCode, speakerCount, audioDurationSeconds } = await transcribeToFile({ mp3Path: mp3, transcriptDest: dest, apiKey: 'k-123', fetchImpl })
  assert.strictEqual(markdown, GOLDEN)
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), GOLDEN)
  assert.strictEqual(languageCode, 'en')
  assert.strictEqual(speakerCount, 2)
  assert.strictEqual(audioDurationSeconds, 120.5)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('extractTranscriptMetrics returns language, speaker count, and audio duration', () => {
  const m = extractTranscriptMetrics(SAMPLE)
  assert.strictEqual(m.languageCode, 'en')
  assert.strictEqual(m.speakerCount, 2)
  assert.strictEqual(m.audioDurationSeconds, 120.5)
})

test('extractTranscriptMetrics returns nulls when fields are absent', () => {
  const m = extractTranscriptMetrics({ words: [] })
  assert.strictEqual(m.languageCode, null)
  assert.strictEqual(m.speakerCount, null)
  assert.strictEqual(m.audioDurationSeconds, null)
})

test('extractTranscriptMetrics ignores spacing tokens when counting speakers', () => {
  const m = extractTranscriptMetrics({
    language_code: 'en',
    audio_duration: 10,
    words: [
      { type: 'spacing', speaker_id: 'speaker_0', text: ' ' },
      { type: 'word',    speaker_id: 'speaker_0', text: 'Hi' },
    ],
  })
  assert.strictEqual(m.speakerCount, 1)
})

test('SCRIBE_V2_COST_PER_HOUR_USD is a positive number', () => {
  assert.ok(typeof SCRIBE_V2_COST_PER_HOUR_USD === 'number' && SCRIBE_V2_COST_PER_HOUR_USD > 0)
})

test('requestTranscription throws an auth-classifiable error on 401', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-'))
  const mp3 = path.join(dir, 'rec.mp3')
  fs.writeFileSync(mp3, Buffer.from([0x00]))
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })

  await assert.rejects(
    () => requestTranscription({ mp3Path: mp3, apiKey: 'bad', fetchImpl }),
    (err) => {
      assert.ok(ELEVENLABS_AUTH_ERROR.test(err.message), 'message classifies as auth error')
      assert.strictEqual(err.status, 401)
      return true
    }
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('requestTranscription throws a rate-limit-classifiable error on 429', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-'))
  const mp3 = path.join(dir, 'rec.mp3')
  fs.writeFileSync(mp3, Buffer.from([0x00]))
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'quota exceeded' })

  await assert.rejects(
    () => requestTranscription({ mp3Path: mp3, apiKey: 'k', fetchImpl }),
    (err) => {
      assert.ok(ELEVENLABS_RATE_LIMITED.test(err.message), 'message classifies as rate limit')
      assert.ok(!ELEVENLABS_AUTH_ERROR.test(err.message), 'does not false-match auth')
      return true
    }
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

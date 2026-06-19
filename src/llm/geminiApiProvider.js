'use strict'

/**
 * Google Gemini API provider — single-call, no streaming, no tools.
 * Implements the same runSingleCall interface as anthropicApiProvider.js.
 * Uses Node's built-in fetch (Node 18+, available in Electron 28+).
 * Always resolves (never rejects).
 *
 * @param {{ getKey(): string|null, log: Function }} opts
 * @returns {{ runSingleCall(opts): Promise<SingleCallResult> }}
 */
function createGeminiApiProvider({ getKey, log }) {
  async function runSingleCall({ system, user, model, maxTokens = 16000, tag = '', label = 'api' }) {
    const apiKey = getKey()
    if (!apiKey) {
      log(`${tag}[${label}] GEMINI_API_KEY not set`)
      return { ok: false, errText: 'GEMINI_API_KEY not set' }
    }

    const startedAt = Date.now()
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    try {
      const body = {
        generationConfig: { maxOutputTokens: maxTokens },
        contents: [{ role: 'user', parts: [{ text: user }] }],
      }
      if (system) {
        body.system_instruction = { parts: [{ text: system }] }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        log(`${tag}[${label}] Gemini API error ${response.status}: ${errBody.slice(0, 256)}`)
        return { ok: false, statusCode: response.status, errText: `HTTP ${response.status}: ${errBody.slice(0, 256)}`, durationMs }
      }

      const data = await response.json()
      const candidate = (data.candidates || [])[0]

      if (!candidate) {
        const blockReason = data.promptFeedback?.blockReason
        log(`${tag}[${label}] no candidates returned — blockReason=${blockReason || 'unknown'}`)
        return { ok: false, errText: `No candidates: ${blockReason || 'unknown'}`, durationMs }
      }

      const finishReason = candidate.finishReason
      const text = (candidate.content?.parts || [])
        .filter(p => typeof p.text === 'string')
        .map(p => p.text)
        .join('')

      const usage = data.usageMetadata || {}
      const rawUsage = {
        input_tokens:  usage.promptTokenCount    || 0,
        output_tokens: usage.candidatesTokenCount || 0,
      }

      log(`${tag}[${label}] finishReason=${finishReason} tokens=in:${rawUsage.input_tokens}/out:${rawUsage.output_tokens} durationMs=${durationMs}`)

      return { ok: true, text, rawUsage, stopReason: finishReason, durationMs }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      log(`${tag}[${label}] fetch error: ${err.message}`)
      return { ok: false, errText: err.message, durationMs }
    }
  }

  return { runSingleCall }
}

module.exports = { createGeminiApiProvider }

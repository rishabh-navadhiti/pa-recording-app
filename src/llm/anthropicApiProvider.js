'use strict'

/**
 * Anthropic Messages API provider — single-call, no streaming, no tools.
 * Uses Node's built-in fetch (Node 18+, available in Electron 28+).
 * Always resolves (never rejects) — mirrors the CLI provider contract.
 *
 * @param {{ getKey(): string|null, log: Function }} opts
 * @returns {{ runSingleCall(opts): Promise<SingleCallResult> }}
 *
 * @typedef {Object} SingleCallResult
 * @property {boolean}     ok          true on success
 * @property {string}      [text]      Model response text (ok=true)
 * @property {object}      [rawUsage]  Raw usage block from the API response (ok=true)
 * @property {string}      [stopReason]
 * @property {number}      [statusCode] HTTP status (ok=false)
 * @property {number}      [durationMs]
 * @property {string}      [errText]   Error description (ok=false)
 */
function createAnthropicApiProvider({ getKey, log }) {
  async function runSingleCall({ system, user, model, maxTokens = 16000, tag = '', label = 'api' }) {
    const apiKey = getKey()
    if (!apiKey) {
      log(`${tag}[${label}] ANTHROPIC_API_KEY not set`)
      return { ok: false, errText: 'ANTHROPIC_API_KEY not set' }
    }

    const startedAt = Date.now()

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      })

      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        log(`${tag}[${label}] API error ${response.status}: ${errBody.slice(0, 256)}`)
        return { ok: false, statusCode: response.status, errText: `HTTP ${response.status}: ${errBody.slice(0, 256)}`, durationMs }
      }

      const data = await response.json()
      const text = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')

      const stopReason = data.stop_reason
      if (stopReason === 'refusal') {
        log(`${tag}[${label}] model refused`)
        return { ok: false, errText: 'Model refused the request', stopReason, durationMs }
      }

      const rawUsage = data.usage || {}
      log(`${tag}[${label}] model=${model} stop_reason=${stopReason} tokens=in:${rawUsage.input_tokens}/out:${rawUsage.output_tokens} durationMs=${durationMs}`)

      return { ok: true, text, rawUsage, stopReason, durationMs }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      log(`${tag}[${label}] fetch error: ${err.message}`)
      return { ok: false, errText: err.message, durationMs }
    }
  }

  return { runSingleCall }
}

module.exports = { createAnthropicApiProvider }

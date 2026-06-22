'use strict'

/**
 * Gemini API provider via the OpenAI-compatible endpoint on generativelanguage.googleapis.com.
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 * Auth:     Authorization: Bearer <GEMINI_API_KEY>
 * Body:     OpenAI messages format (system + user roles)
 * Always resolves (never rejects) — mirrors the Anthropic provider contract.
 *
 * @param {{ getKey(): string|null, log: Function }} opts
 * @returns {{ runSingleCall(opts): Promise<SingleCallResult> }}
 */
function createGeminiApiProvider({ getKey, log }) {
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

  async function runSingleCall({ system, user, model, maxTokens = 16000, tag = '', label = 'api' }) {
    const apiKey = getKey()
    if (!apiKey) {
      log(`${tag}[${label}] GEMINI_API_KEY not set`)
      return { ok: false, errText: 'GEMINI_API_KEY not set' }
    }

    const startedAt = Date.now()

    try {
      const messages = []
      if (system) messages.push({ role: 'system', content: system })
      messages.push({ role: 'user', content: user })

      const body = {
        model,
        max_tokens: maxTokens,
        messages,
        reasoning_effort: 'none',
      }

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'content-type':  'application/json',
        },
        body: JSON.stringify(body),
      })

      const durationMs = Date.now() - startedAt

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        log(`${tag}[${label}] Gemini API error ${response.status}: ${errBody.slice(0, 256)}`)
        return { ok: false, statusCode: response.status, errText: `HTTP ${response.status}: ${errBody.slice(0, 256)}`, durationMs }
      }

      const data = await response.json()
      const choice = (data.choices || [])[0]

      if (!choice) {
        log(`${tag}[${label}] no choices returned`)
        return { ok: false, errText: 'No choices in response', durationMs }
      }

      const finishReason = choice.finish_reason || 'stop'
      const text = choice.message?.content || ''

      const usage = data.usage || {}
      const rawUsage = {
        input_tokens:  usage.prompt_tokens     || 0,
        output_tokens: usage.completion_tokens || 0,
      }

      log(`${tag}[${label}] model=${model} finish_reason=${finishReason} tokens=in:${rawUsage.input_tokens}/out:${rawUsage.output_tokens} durationMs=${durationMs}`)

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

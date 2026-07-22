'use strict'

/**
 * OpenAI API provider via the native Chat Completions endpoint.
 * Endpoint: POST https://api.openai.com/v1/chat/completions
 * Auth:     Authorization: Bearer <OPENAI_API_KEY>
 * Body:     OpenAI messages format (system + user roles)
 * Always resolves (never rejects) — mirrors the Anthropic/Gemini provider contract.
 *
 * Cloned from geminiApiProvider.js. Two load-bearing differences from the Gemini
 * OpenAI-compat clone:
 *   1. `max_completion_tokens` — the gpt-5 family REJECTS `max_tokens` on the real
 *      OpenAI endpoint (Gemini's compat endpoint tolerated it).
 *   2. `reasoning_effort: 'low'` — pinned to the LOWEST reasoning the model
 *      actually accepts. The bake-off's finding was that HIGHER effort degrades
 *      notes (the plan leaks into the HPI), so we want the least reasoning; effort
 *      is never exposed as a setting. The handoff called for `'minimal'`, but the
 *      live API rejects it for this model with HTTP 400 ("does not support
 *      'minimal' with this model. Supported values are: 'none', 'low', 'medium',
 *      'high', 'xhigh'"). Of the supported values, `'low'` is the closest to the
 *      intended minimal. `'none'` is deliberately avoided — it is documented to be
 *      silently ignored alongside `max_completion_tokens` on some GPT-5 versions,
 *      which would raise effort back up (the exact regression we're avoiding).
 *
 * Usage is emitted in the same Anthropic-shaped `rawUsage` keys that
 * src/llm/pricing.js (calcCost/normalizeApiUsage) already consumes, so no changes
 * to the pricing/usage functions are needed — only a price-table row for the model.
 *
 * @param {{ getKey(): string|null, log: Function }} opts
 * @returns {{ runSingleCall(opts): Promise<SingleCallResult> }}
 */
function createOpenAiApiProvider({ getKey, log }) {
  const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

  async function runSingleCall({ system, user, model, maxTokens = 16000, tag = '', label = 'api' }) {
    const apiKey = getKey()
    if (!apiKey) {
      log(`${tag}[${label}] OPENAI_API_KEY not set`)
      return { ok: false, errText: 'OPENAI_API_KEY not set' }
    }

    const startedAt = Date.now()

    try {
      const messages = []
      if (system) messages.push({ role: 'system', content: system })
      messages.push({ role: 'user', content: user })

      const body = {
        model,
        max_completion_tokens: maxTokens,
        messages,
        reasoning_effort: 'low',
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
        log(`${tag}[${label}] OpenAI API error ${response.status}: ${errBody.slice(0, 256)}`)
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

      // Map OpenAI usage → Anthropic-shaped rawUsage keys that pricing.js expects.
      // - prompt_tokens already INCLUDES cached tokens; cached_tokens carries the
      //   cache-read portion (calcCost subtracts it back out at the cacheRead rate).
      // - completion_tokens already INCLUDES reasoning_tokens — do NOT add reasoning
      //   again or output cost double-counts. reasoning_tokens is logged only.
      const usage = data.usage || {}
      const cachedTokens    = usage.prompt_tokens_details?.cached_tokens     || 0
      const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0
      const rawUsage = {
        input_tokens:            usage.prompt_tokens     || 0,
        output_tokens:           usage.completion_tokens || 0,
        cache_read_input_tokens: cachedTokens,
      }

      log(`${tag}[${label}] model=${model} finish_reason=${finishReason} tokens=in:${rawUsage.input_tokens}/out:${rawUsage.output_tokens} cache_read:${cachedTokens} reasoning:${reasoningTokens} durationMs=${durationMs}`)

      return { ok: true, text, rawUsage, stopReason: finishReason, durationMs }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      log(`${tag}[${label}] fetch error: ${err.message}`)
      return { ok: false, errText: err.message, durationMs }
    }
  }

  return { runSingleCall }
}

module.exports = { createOpenAiApiProvider }

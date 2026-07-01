'use strict'

/**
 * OpenRouter provider — a single OpenAI-compatible endpoint in front of many
 * models (DeepSeek, Qwen, Llama, plus proprietary Claude/GPT/Gemini). The model
 * to run is chosen entirely by the `model` slug passed in (e.g.
 * 'deepseek/deepseek-v4-pro'), so one provider serves every OpenRouter option.
 *
 * Endpoint: POST https://openrouter.ai/api/v1/chat/completions
 * Auth:     Authorization: Bearer <OPENROUTER_API_KEY>   (sk-or-v1-...)
 * Body:     OpenAI messages format (system + user roles), same shape as Gemini.
 * Thinking: OpenRouter uses `reasoning: { enabled: false }` to force non-thinking
 *           (NOT DeepSeek's native `thinking` object, and NOT Gemini's
 *           `reasoning_effort`). We want deterministic SOAP output, so thinking OFF.
 * Always resolves (never rejects) — mirrors the Anthropic/Gemini provider contract.
 *
 * @param {{ getKey(): string|null, log: Function }} opts
 * @returns {{ runSingleCall(opts): Promise<SingleCallResult> }}
 */
function createOpenRouterProvider({ getKey, log }) {
  const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

  async function runSingleCall({ system, user, model, maxTokens = 16000, tag = '', label = 'openrouter' }) {
    const apiKey = getKey()
    if (!apiKey) {
      log(`${tag}[${label}] OPENROUTER_API_KEY not set`)
      return { ok: false, errText: 'OPENROUTER_API_KEY not set' }
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
        reasoning: { enabled: false },
        // To keep PHI off China-hosted upstreams, add US-host routing here, e.g.:
        //   provider: { order: ['fireworks', 'deepinfra', 'together'], data_collection: 'deny' }
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
        log(`${tag}[${label}] OpenRouter API error ${response.status}: ${errBody.slice(0, 256)}`)
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

module.exports = { createOpenRouterProvider }

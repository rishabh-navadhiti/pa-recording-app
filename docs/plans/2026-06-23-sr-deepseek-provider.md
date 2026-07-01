# Plan: Add DeepSeek V4 Pro as SOAP model option

**Date:** 2026-06-23  
**Author:** sr  
**Branch:** `feature/deepseek-provider`  
**Status:** Implemented 2026-06-30 (see "Implementation corrections" below)

---

## Implementation as shipped — pivoted to OpenRouter (2026-06-30)

The original plan targeted the **official `api.deepseek.com`** and explicitly rejected OpenRouter. That was reversed after reconciling with the `API_USAGE_single_call_notes.md` reference, whose only DeepSeek path (§7) is **OpenRouter** — it ships a working `sk-or-v1-…` key and, importantly, supports pinning **US-hosted** upstreams to keep PHI off China servers. Decision confirmed with the user. DeepSeek V4 Pro now runs **through OpenRouter**.

Shipped design (a generic, slug-driven OpenRouter provider; DeepSeek is its first option):

1. **Provider:** `src/llm/openRouterProvider.js` (`createOpenRouterProvider`) — endpoint `https://openrouter.ai/api/v1/chat/completions`, `Bearer <OPENROUTER_API_KEY>`, OpenAI body. One provider fronts any OpenRouter model; the slug in `modelOptions` selects which.
2. **Thinking OFF** via OpenRouter's `reasoning: { enabled: false }` — NOT DeepSeek-native `thinking:{type:'disabled'}` and NOT Gemini's `reasoning_effort`.
3. **Slug is the OpenRouter slug `deepseek/deepseek-v4-pro`** (option id stays `deepseek-v4-pro`). Pricing $0.435 in / $0.87 out (~$0.016/note) confirmed against the reference.
4. **Key:** `OPENROUTER_API_KEY` in `.env` (not `DEEPSEEK_API_KEY`) — `secrets.getOpenRouterKey()`.
5. **ctx.openrouter** instantiated in `appContext.js`; `main.js` dispatches `opt.provider === 'openrouter'`.
6. **`pricing.js`** keyed by the slug `deepseek/deepseek-v4-pro` (calcCost keys off `opt.model`); includes `cacheRead:0, cacheWrite:0` to avoid a `0 * undefined = NaN` cost.
7. Also fixed the plan's original step-6 arg-order bug (`generateSoapViaApi(…, caseId, model, provider, providerName)`).

**Open (deferred per user):** PHI / China-hosting. The provider has a commented one-liner to pin US hosts (`provider:{order:['fireworks','deepinfra','together'],data_collection:'deny'}`) — enable before real-PHI use.

---

## Goal

Add **DeepSeek V4 Pro** (official DeepSeek API, not OpenRouter) as a selectable SOAP model option in Settings, alongside the existing Gemini 3.5 Flash and Claude Sonnet 4.6 (API) options.

DeepSeek's official API is OpenAI-compatible — the same shape as `geminiApiProvider.js`. This is a **narrow, mechanical addition**: one new provider file, five small edits to existing files, no pipeline or engine changes.

---

## What this is NOT

- **Not OpenRouter** — the `API_USAGE_single_call_notes.md` reference file uses OpenRouter slugs (`deepseek/deepseek-v4-pro`) for internal testing only. This plan targets `api.deepseek.com` directly.
- **Not the global model registry** — `docs/plans/2026-06-22-sr-global-model-registry.md` proposes making model options dynamic via IPC. That plan is design-only and not yet implemented. This plan adds DeepSeek to the **existing static list** (same pattern as Gemini). When the registry plan ships, DeepSeek slots in there too.
- **Not for engines** — ICD, CDI, E/M scorer, patient-summary all use the Claude CLI (`ctx.llm`) and are unaffected. DeepSeek is SOAP-generation only, same scope as Gemini.

---

## API reference

| Field | Value |
|---|---|
| Endpoint | `https://api.deepseek.com/v1/chat/completions` |
| Auth | `Authorization: Bearer <DEEPSEEK_API_KEY>` |
| Format | OpenAI-compatible (`messages: [{role:"system",...},{role:"user",...}]`) |
| Model slug | **Verify at platform.deepseek.com/api-docs** — `deepseek-chat` is the current general-purpose model (DeepSeek V3/V4); a versioned slug like `deepseek-v4-pro` may exist. Use whatever the docs list as the production-tier chat model. |
| Thinking | DeepSeek V4 Pro (non-reasoner) does not require a reasoning toggle. If the model has a thinking/reasoning mode, leave it OFF for SOAP generation (same as Gemini — we pass a full SKILL.md in system and want deterministic output, not free reasoning). |
| Pricing (June 2026 approx.) | ~$0.435/1M in, ~$0.87/1M out (per `API_USAGE_single_call_notes.md`). Add to `src/llm/pricing.js`. |

---

## Files to touch (in order)

### 1. NEW — `src/llm/deepseekApiProvider.js`

Mirror `src/llm/geminiApiProvider.js` exactly. The only differences:

- Endpoint: `https://api.deepseek.com/v1/chat/completions`
- Auth header: `Authorization: Bearer <key>` (same as Gemini — no change needed)
- No `reasoning_effort` field (DeepSeek V4 Pro is not a reasoner)
- `getKey` reads from `secrets.getDeepSeekKey()`
- Log label: `'deepseek'`

```js
// src/llm/deepseekApiProvider.js
'use strict'
const { post } = require('./httpPost')   // or inline fetch — see geminiApiProvider.js

function createDeepSeekApiProvider({ getKey, log }) {
  async function runSingleCall({ system, user, model, tag, label }) {
    const key = getKey()
    if (!key) return { ok: false, errText: 'DEEPSEEK_API_KEY not set' }
    const body = {
      model,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    }
    // POST + response parsing mirrors geminiApiProvider.js
    // note = choices[0].message.content
    // usage: prompt_tokens / completion_tokens
    // check finish_reason === 'stop'; 'length' means truncated → raise max_tokens
  }
  return { runSingleCall }
}

module.exports = { createDeepSeekApiProvider }
```

> Implementation note: copy `geminiApiProvider.js` verbatim, then make the three changes above (endpoint, no reasoning_effort, log label). Do NOT change the HTTP helper or response-parsing shape.

---

### 2. EDIT — `config/secrets.js`

Add two methods after `getGeminiBaseUrl()` (line 64):

```js
getDeepSeekKey() {
  return readEnv()['DEEPSEEK_API_KEY'] || null
},
setDeepSeekKey(key) {
  writeKey('DEEPSEEK_API_KEY', key)
},
```

No Settings UI field for now (Anthropic and Gemini keys are also env-only). User pastes the key into `.env` manually — document in the README install section.

---

### 3. EDIT — `src/llm/modelOptions.js`

Add one entry to `NOTE_GEN_OPTIONS`:

```js
'deepseek-v4-pro': {
  label:    'DeepSeek V4 Pro',
  provider: 'deepseek',
  model:    'deepseek-chat',   // ← verify the exact slug at platform.deepseek.com/api-docs
},
```

No other change to this file.

---

### 4. EDIT — `config/settings.js`

a. Add `'deepseek-v4-pro'` to the `VALID_SOAP_OPTIONS` Set (line ~21):
```js
new Set(['gemini-3.5-flash', 'sonnet-4-6-api', 'sonnet-4-6-agentic', 'deepseek-v4-pro'])
```

b. Default stays `'sonnet-4-6-api'` — no change to `DEFAULT_SETTINGS`.

---

### 5. EDIT — `context/appContext.js`

Instantiate the new provider alongside the existing two (after line ~113 where `gemini` is created):

```js
const { createDeepSeekApiProvider } = require('../src/llm/deepseekApiProvider')
const deepseek = createDeepSeekApiProvider({ getKey: () => secrets.getDeepSeekKey(), log })
```

Expose on ctx:
```js
ctx.deepseek = deepseek
```

---

### 6. EDIT — `main.js` (the `spawnSoapGeneration` dispatch block, ~line 301)

Add a branch after the Gemini check:

```js
if (opt.provider === 'deepseek') {
  generateSoapViaApi(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry, templatePath, caseId, ctx.deepseek, 'DeepSeek')
  return
}
```

No other change to `main.js`.

---

### 7. EDIT — `renderer/index.html`

Add one `<option>` to `#soap-model-select` (after the Gemini option, ~line 135):

```html
<option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
```

Position it after Gemini, before the Sonnet options.

---

### 8. EDIT — `src/llm/pricing.js`

Add a DeepSeek entry to `PRICE_TABLE` so cost logging works:

```js
'deepseek-chat': { in: 0.435, out: 0.87 },  // $/1M tokens, June 2026
```

---

## `.env` change (user setup step)

The installer scripts (`install.ps1`, `setup.ps1`) and README should document the new key:

```
DEEPSEEK_API_KEY=sk-...your-key...
```

No app code change needed for this — `secrets.getDeepSeekKey()` already reads it via `readEnv()`.

---

## What does NOT change

| Area | Why unchanged |
|---|---|
| `preload.js` / IPC channels | No new IPC needed — model selection goes through existing `saveSettings` |
| `renderer/views/settingsView.js` | JS only reads/writes `#soap-model-select` value; adding an HTML `<option>` is sufficient |
| `src/engines/*` | Engines use `ctx.llm` (Claude CLI) only |
| `src/pipeline/chain.js` | Pipeline doesn't care which SOAP provider fired |
| `notes-claude/skills/` | Skill prompts are provider-agnostic |
| DB schema | No new columns |
| `CLAUDE.md` / `docs/ARCHITECTURE.md` | Update in same PR — add DeepSeek to the model options table |

---

## Implementation order

1. Write `src/llm/deepseekApiProvider.js` (copy + adapt from `geminiApiProvider.js`)
2. `config/secrets.js` — two new methods
3. `src/llm/modelOptions.js` — one new entry (confirm model slug first)
4. `config/settings.js` — VALID_SOAP_OPTIONS
5. `context/appContext.js` — instantiate + expose `ctx.deepseek`
6. `main.js` — dispatch branch
7. `renderer/index.html` — `<option>` tag
8. `src/llm/pricing.js` — price entry
9. Docs: update `CLAUDE.md` settings table + `ARCHITECTURE.md` provider list

---

## Test plan

1. Add `DEEPSEEK_API_KEY` to `.env`
2. `npm start` → Settings → SOAP Model → select **DeepSeek V4 Pro** → save
3. Run a real recording through stop-recording → patient name → observe pipeline logs in `app.log`
4. Confirm `[soap:api]` log lines appear tagged `DeepSeek` with token counts
5. Confirm `_soap_note.md` + `.docx` land in case folder as normal
6. Confirm ICD + CDI steps still run (they use CLI, not the SOAP provider)
7. Switch back to Gemini — confirm no regression
8. Test with missing `DEEPSEEK_API_KEY` → should surface `service-warning` IPC with a clear key-missing message (same guard as Gemini/Anthropic)

---

## Open questions

1. **Official model slug** — confirm whether `deepseek-chat` is the right slug for V4 Pro on `api.deepseek.com`, or whether a versioned slug (e.g. `deepseek-v4-pro`) is listed. The API_USAGE doc slugs are OpenRouter-internal.
2. **Rate limits / PHI** — DeepSeek servers are operated by a Chinese company. Confirm with the team whether this is acceptable for the PHI in transcripts, or whether we need a data-processing agreement / routing through a HIPAA-eligible endpoint before this option is shown to end users. If not confirmed, consider hiding the option behind a `--staging` or `advanced` toggle until cleared.
3. **Thinking mode** — if DeepSeek V4 Pro has a reasoning/thinking flag on the official API, document it here before implementation so we can decide whether to expose it (like we do for Anthropic) or always leave it off (like Gemini).

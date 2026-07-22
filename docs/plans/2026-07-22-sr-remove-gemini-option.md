# Remove the Gemini note-generation option

**Date:** 2026-07-22
**Author:** sr
**Branch:** `feature/remove-gemini-option` (from `develop`)
**Status:** in progress

## Goal

Remove Gemini as a SOAP note-generation option **completely** — the user-visible
dropdown option, the orphaned Gemini API Key settings field, and all backend
plumbing (provider, IPC, secrets). Gemini was never the actual default
(`DEFAULT_SETTINGS.soapModel` is `sonnet-4-6-api`); it only appeared first in the
dropdown labelled "recommended". After this change the note-gen choices are the
Anthropic Sonnet options only.

## Scope decision

Full removal (confirmed with the requester): rip out the provider code, IPC
channels, secrets accessors and preload methods — not just the dropdown entry.

## Changes

### UI (renderer)
- `renderer/index.html`
  - Remove the `<option value="gemini-3.5-flash">` from `#soap-model-select`.
  - Remove the entire **Gemini API Key** settings block (`#gemini-key-*`).
  - Mark `Sonnet 4.6 (API)` as `— recommended` (it is the real default).
- `renderer/views/settingsView.js`
  - Remove the `gemini*` element refs, load block, `querySelector` assignments
    and event wiring.
  - Fix the fallback: `s.soapModel || 'gemini-3.5-flash'` → `|| 'sonnet-4-6-api'`.

### Model registry / validation
- `src/llm/modelOptions.js` — remove the `gemini-3.5-flash` entry; reword the
  `resolveCliModel` comment so it no longer describes a Gemini provider (the
  unknown/legacy fallback path stays).
- `config/settings.js` — drop `'gemini-3.5-flash'` from `VALID_SOAP_OPTIONS`.

### Backend plumbing
- Delete `src/llm/geminiApiProvider.js`.
- `context/appContext.js` — remove the `createGeminiApiProvider` import, the
  `gemini` provider construction, and `gemini` from the `ctx` object.
- `main.js` — remove `validateGeminiKey`, the `opt.provider === 'gemini'` dispatch
  branch in `spawnSoapGeneration`, the `providerName === 'Gemini'` conditionals
  (collapse to `ANTHROPIC_API_KEY`), and `validateGeminiKey` from the `deps` bag.
- `src/jobs/prechartApi.js` — `provider` is always `ctx.api`; collapse the
  `providerName === 'Gemini'` messaging to Anthropic.
- `src/ipc/config.js` — remove the `get-gemini-key` / `save-gemini-key` handlers
  and `validateGeminiKey` from the deps destructure.
- `src/shared/ipc-channels.js` — remove `GET_GEMINI_KEY` / `SAVE_GEMINI_KEY`.
- `config/secrets.js` — remove `getGeminiKey`, `setGeminiKey`, `getGeminiBaseUrl`
  (none are consumed once the provider is gone).
- `preload.js` — remove `getGeminiKey` / `saveGeminiKey`.

### Tests
- `tests/unit/model-options.test.js` — remove the Gemini-fallback test and its
  header comment reference; the unknown/legacy fallback test still covers the path.
- `tests/unit/ipc-registrars.test.js` — handler count `49` → `47`.

### Docs
- `docs/ARCHITECTURE.md` — drop the stale "never Gemini" parenthetical.
- `docs/DECISIONS.md` — append a dated entry recording the removal.

## Not touching
- User `.env` files (may still hold `GEMINI_API_KEY`; harmless, ignored now).
- Historical plans/notes under `docs/` that mention Gemini — they are archival.

## Verification
- `npm test` green (drift + registrar tests are the guardrails).

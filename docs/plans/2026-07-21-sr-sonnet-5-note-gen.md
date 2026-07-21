# Add Sonnet 5 as a note-generation option

**Owner:** sr
**Date:** 2026-07-21
**Status:** Planned

---

## Goal

Add **Sonnet 5 (API)** as a selectable note-generation model in Settings, alongside the
existing Sonnet 4.6 (API) / Sonnet 4.6 (Agentic) / Gemini 3.5 Flash options. Model id:
`claude-sonnet-5`.

**Decisions (confirmed):**
- **API variant only** — mirrors the active Sonnet 4.6 path (`sonnet-4-6-api`, `provider: 'api'`,
  the single-call Anthropic Messages-API route). No agentic/CLI variant this round.
- **Default is unchanged** — `DEFAULT_OPTION_ID` / `DEFAULT_SETTINGS.soapModel` stay
  `sonnet-4-6-api`. Sonnet 5 is opt-in via the dropdown. Existing installs are untouched.
- **Sonnet 5 is for note generation ONLY.** The post-SOAP engines — ICD, CDI, and (by the same
  principle) em-score and patient-summary — stay pinned to **Sonnet 4.6** regardless of the
  note-gen selection. Today these engines derive their model from `soapModel`
  (`resolveCliModel(cfg.soapModel)` / `pinnedAnthropicModel(cfg.soapModel)`), so without this
  decoupling picking Sonnet 5 would silently move coding/CDI/scoring onto Sonnet 5 too. We pin
  them to a fixed `ENGINE_MODEL`.

> **Interpretation note:** the instruction named "icd, cdi"; the general rule ("Sonnet 5 is for
> note generation only") applies equally to em-score + patient-summary, which are also downstream
> engines. This plan pins **all four** to Sonnet 4.6. If only ICD/CDI were meant, drop the
> emScore/patientSummary lines from change #2 — but that would leave those two riding Sonnet 5,
> contradicting "note generation only."

Non-goals: no new provider, no new skill, no DB or IPC change, no template-model change
(the Template Model dropdown is separate — out of scope). This does **not** implement the
global model registry (`2026-06-22-sr-global-model-registry.md`); it adds one option to the
existing three-copy list, consistent with how options are added today.

---

## Why it's small

Note-gen options are a registry (`src/llm/modelOptions.js`) whose `provider` field routes the
call: `provider: 'api'` → `generateSoapViaApi(...)` in [main.js](../../main.js) using `ctx.api`
(Anthropic Messages API), which passes `opt.model` straight through. Adding an `api` option is
purely additive — no routing code changes. The list is duplicated in three places (the open
registry-unification plan would fix that; until then we update all three), plus a price-table entry.

---

## Changes

### 1. `src/llm/modelOptions.js` — add the option + an engine-model constant

Add one entry to `NOTE_GEN_OPTIONS`:

```js
'sonnet-5-api':       { label: 'Sonnet 5 (API)',       provider: 'api',    model: 'claude-sonnet-5' },
```

`DEFAULT_OPTION_ID` stays `'sonnet-4-6-api'`. `resolveOption` / `resolveCliModel` need no change.

Add a fixed engine model (the single source of truth for change #2, read only by the runner) and
export it:

```js
// Post-SOAP engines (ICD / CDI / em-score / patient-summary) are pinned to this
// model, decoupled from the note-gen selection: a newer note-gen model (e.g.
// Sonnet 5) must NOT silently change coding/CDI/scoring output. This is the
// stable Anthropic model the engines + standards packs were validated against.
const ENGINE_MODEL = 'claude-sonnet-4-6'
function engineModel() { return ENGINE_MODEL }
// module.exports += { ENGINE_MODEL, engineModel }
```

### 2. Pin the post-SOAP engines to Sonnet 4.6 — in ONE place

`engine.model()` is consumed in exactly **one** spot — the shared runner
([engineRunner.js](../../src/engines/engineRunner.js), the `effectiveModel` line). That's the single
choke point for "what model an engine runs on." Pin it there and the individual engine files
(`icd.js` / `cdi.js` / `emScore.js` / `patientSummary.js`) stay **completely untouched**:

```js
const { engineModel } = require('../llm/modelOptions')
// ...
// All post-SOAP engines are pinned to a fixed model, decoupled from the note-gen
// selection. engine.model() is intentionally NOT consulted.
const effectiveModel = engineModel()
```

This replaces the previous `pinnedAnthropicModel(cfg.soapModel)` helper (API path) *and* the
`engine.model(cfg.soapModel)` read (agentic path) with one call. The engine descriptors keep their
existing `model: (cfg) => resolveCliModel(cfg.soapModel)` field for reference/parity — it is simply
no longer read for model selection (this already matched reality for the API-only engines, whose
`model()` the runner never consulted).

**`resolveCliModel` stays** — the CLI pre-chart job ([src/jobs/prechart.js:19](../../src/jobs/prechart.js#L19))
still uses it, and pre-chart follows the note-gen model (see "Blast radius").

**Net effect today:** all four options except the new one already resolve engines to `claude-sonnet-4-6`
(Gemini falls back to it; both 4.6 options are it). This makes it explicit and ensures the new
`sonnet-5-api` option doesn't become the first exception — with a one-file change, not five.

### 3. `renderer/index.html` — add the dropdown option

In `<select id="soap-model-select">` (≈ line 157), add after the Sonnet 4.6 options:

```html
<option value="sonnet-5-api">Sonnet 5 (API)</option>
```

(The renderer list is hardcoded HTML, not generated from the registry — the value string must
match the registry key exactly.)

### 4. `config/settings.js` — allow the new id through the normalizer

Add `'sonnet-5-api'` to the inline `VALID_SOAP_OPTIONS` set (≈ line 23). Without this, the
normalizer's `applyInvariants()` resets a saved `soapModel: 'sonnet-5-api'` back to
`'sonnet-4-6-api'` on load, so the choice wouldn't stick.

```js
const VALID_SOAP_OPTIONS = new Set(['gemini-3.5-flash', 'sonnet-4-6-api', 'sonnet-4-6-agentic', 'sonnet-5-api'])
```

### 5. `src/llm/pricing.js` — add a price row (cost tracking)

`calcCost()` returns `null` for any model missing from `PRICE_TABLE`, so without an entry the
per-case `costUsd` silently drops for Sonnet 5 notes. Add the **current** Sonnet 5 pricing
(introductory rates in effect through 2026-08-31, per platform.claude.com/docs/en/about-claude/pricing):

```js
// Sonnet 5 introductory pricing (in effect through 2026-08-31). Standard pricing
// from 2026-09-01 is $3 in / $15 out / $0.30 read / $3.75 write — update then.
'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.20, cacheWrite: 2.50 },
```

Static value (no date-aware logic — matches the rest of the table). One dated comment flags the
2026-09-01 standard-pricing change so it's a known follow-up, not a silent drift.

### 6. Tests

**`tests/unit/model-options.test.js`** — mirror the existing Sonnet 4.6 cases, and add one asserting
the engine model is pinned (independent of `soapModel`):

```js
test('resolveOption maps the Sonnet 5 API id to its model', () => {
  assert.equal(resolveOption('sonnet-5-api').model, 'claude-sonnet-5')
  assert.equal(resolveOption('sonnet-5-api').provider, 'api')
})
test('engineModel is pinned to Sonnet 4.6, independent of the note-gen selection', () => {
  assert.equal(engineModel(), 'claude-sonnet-4-6')  // does NOT read soapModel
})
```

**`tests/unit/engine-runner.test.js`** — the existing "pinned Anthropic model resolved" assertion
([line 131](../../tests/unit/engine-runner.test.js#L131)) expects `claude-sonnet-4-6` and stays green
(that's exactly what `engineModel()` returns). Optionally add a case with `soapModel: 'sonnet-5-api'`
proving `pinnedAnthropicModel` still returns `claude-sonnet-4-6` — the regression guard for this whole
change.

`tests/unit/config.test.js` needs no change (default is unchanged). Run `npm test`.

### 7. Docs

- **CLAUDE.md** — the "Default models" line stays (`SOAP = claude-sonnet-4-6`); no edit needed for
  the default. Optionally note Sonnet 5 is selectable in the Settings/Quick-references model list.
- **docs/DECISIONS.md** — append a dated entry: added `sonnet-5-api` (API-only, opt-in, default
  unchanged); note the three-copy list is still the pre-registry reality.
- **docs/ARCHITECTURE.md** — no structural change; touch only if a model list is enumerated there.

---

## Blast radius: what `soapModel = 'sonnet-5-api'` reaches (after pinning)

With change #2 in place, `claude-sonnet-5` reaches only the two note-**generation** call sites, both
on the Anthropic Messages API (`ctx.api`):

- **Note generation** → `generateSoapViaApi` on `ctx.api` with `claude-sonnet-5` ✅ (the intent).
- **Pre-chart (edit-note API)** → `prechartApi.js` uses `resolveOption(cfg.soapModel)?.model` →
  `claude-sonnet-5` via `ctx.api`. Pre-chart regenerates the SOAP note, so it *is* note generation —
  it follows the note-gen model by design. (The CLI pre-chart path only runs for the `agentic`
  provider, which `sonnet-5-api` is not, so `claude-sonnet-5` never reaches the `claude` CLI here.)
- **Post-SOAP engines** (ICD, CDI, em-score, patient-summary) → **pinned to `claude-sonnet-4-6`**
  via `engineModel()`. Sonnet 5 does **not** reach them. ✅

**Consequence — no CLI verification needed.** Because `sonnet-5-api` is API-only and the engines are
pinned to 4.6, `claude-sonnet-5` is *never* passed to the local `claude` CLI (`claude -p --model`).
The only surface to confirm is that the Anthropic Messages API (`ctx.api`) accepts `claude-sonnet-5`
— the same client already used for `sonnet-4-6-api`. This removes the CLI-404 risk the earlier draft
of this plan flagged.

---

## Test plan

1. `npm test` — unit (model-options + engine-runner + config) green.
2. `npm start`, Settings → Advanced → Note Generation Model shows **Sonnet 5 (API)**; select it,
   reopen Settings, confirm it persists (validator lets it through).
3. Record → stop → name a patient → confirm a SOAP note generates on `claude-sonnet-5` (check
   `app.log` for the note-gen model tag) and the `.docx` lands.
4. With `enableIcd`/`enableCdi`/`enableEmScore`/`enablePatientSummary` on **and Sonnet 5 selected**:
   confirm `app.log` shows the ICD/CDI/em/patient-summary engines running on **`claude-sonnet-4-6`**,
   not `claude-sonnet-5` (the whole point of change #2). Their `processing_events.model_used` rows
   should read `claude-sonnet-4-6`.

---

## Rollout

`develop` → exercise via `npm start` → `staging` (one auto-update cycle) → `main`, per the
branching rules. Move this plan to `docs/archive/plans/` and drop its README row after merge.

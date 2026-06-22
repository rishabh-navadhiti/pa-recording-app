# Global, provider-aware model registry

**Owner:** sr
**Status:** Planned (design only — do NOT implement yet; resolve open questions first)
**Branch (when implementing):** a fresh branch off `develop` (e.g. `feature/model-registry`). Keep it **separate** from `feature/engine-report-pdf` — that branch already landed the interim engine-model fix (§2.3) this plan generalizes.
**Date:** 2026-06-22

---

## 0. Goal in one paragraph

Make **one registry the single source of truth for every model choice in the app** — SOAP note generation, doctor-template creation/update, and the per-case review/scoring engines (ICD, CDI, E/M, patient-summary). Today these are modeled three different, inconsistent ways, the SOAP option list is duplicated in three files, and the engines were (until a recent hotfix) coupling to the SOAP option id and breaking. Replace that with a **provider-aware registry**: each option declares `{ id, label, provider, model, roles }`; the renderer builds **both** model dropdowns from it; settings validates against it; and every consumer (SOAP dispatch, template jobs, engines) resolves the real model name through it. Default per role; provider gating so only options whose provider is actually configured are offered.

---

## 1. Why / the problem

Three inconsistent patterns, three copies of the SOAP list, and a coupling bug:

| Concern | How it's modeled today | Problem |
|---|---|---|
| **SOAP model** | Option-id registry `src/llm/modelOptions.js` (`{label, provider, model}`) | The option list is **duplicated in 3 places**: `modelOptions.js`, the hardcoded `<option>`s in `renderer/index.html` (`#soap-model-select`), and `VALID_SOAP_OPTIONS` in `config/settings.js`. Any add/rename must touch all three or they drift. |
| **Template model** | Hardcoded **raw model ids** in `renderer/index.html` (`#template-model-select`: `claude-haiku-4-5-20251001` / `claude-sonnet-4-6` / `claude-opus-4-8`), stored raw as `templateModel`, passed straight to the skill | Bypasses the registry entirely. No provider concept, no validation, no default abstraction. A second, totally different pattern from SOAP. |
| **Engine model** (ICD/CDI/E-M/patient-summary) | `model: (cfg) => cfg.soapModel` | An **option id** (`sonnet-4-6-api`) is not a CLI model name → `claude -p --model sonnet-4-6-api` returns 404, every engine fails, no JSON, no report. Fixed on the `feature/engine-report-pdf` branch via `engineModel()` (see §2.3) — but that's a point fix; the engines still shouldn't be reaching into the SOAP setting at all. |

Net: adding a provider/model is a multi-file scavenger hunt; the renderer and the backend can silently disagree; and "what model does X actually use" has three different answers.

---

## 2. Current state (ground truth — read before designing)

### 2.1 `src/llm/modelOptions.js`
```js
const NOTE_GEN_OPTIONS = {
  'gemini-3.5-flash':   { label: 'Gemini 3.5 Flash',     provider: 'gemini', model: 'gemini-3.5-flash' },
  'sonnet-4-6-api':     { label: 'Sonnet 4.6 (API)',     provider: 'api',    model: 'claude-sonnet-4-6' },
  'sonnet-4-6-agentic': { label: 'Sonnet 4.6 (Agentic)', provider: 'cli',    model: 'claude-sonnet-4-6' },
}
const DEFAULT_OPTION_ID = 'sonnet-4-6-api'
function resolveOption(soapModel) { return NOTE_GEN_OPTIONS[soapModel] || NOTE_GEN_OPTIONS[DEFAULT_OPTION_ID] }
```
Three **providers** already exist conceptually: `gemini` (Gemini API), `api` (Anthropic API), `cli` (Claude Code skill via `claude -p`). Only SOAP uses this registry.

### 2.2 The two settings dropdowns (`renderer/index.html`, advanced settings)
- `#soap-model-select` — hardcoded `<option>`s mirroring the 3 option ids (gemini / sonnet-api / sonnet-agentic).
- `#template-model-select` — hardcoded `<option>`s with **raw model ids** (haiku / sonnet / opus).
`renderer/views/settingsView.js` sets `.value` from settings and saves `.value` on change; the renderer is **sandboxed ESM and cannot `require('src/...')`**, so today the options can only be hardcoded or fed via IPC.

### 2.3 Engine model resolution (already hotfixed on `feature/engine-report-pdf`)
`modelOptions.js` gained `engineModel()` (→ `sonnet-4-6-agentic` → `claude-sonnet-4-6`) + `cliModelFor(soapModel)`, and the engine descriptors now use `model: () => engineModel()` (CLI-only review engines) / `cliModelFor` (agentic SOAP path). This plan **subsumes** that into the role-based registry below; until then the hotfix stands.

### 2.4 settings validation (`config/settings.js`)
`VALID_SOAP_OPTIONS = new Set([...3 ids])` is **inlined** (a deliberate copy) "to avoid a runtime require in the normalizer." `applyInvariants()` maps unknown/legacy `soapModel` → `DEFAULT_OPTION_ID`. `templateModel` is **not** validated at all.

---

## 3. Target design

### 3a. One registry, role-tagged, provider-aware (`src/llm/modelOptions.js`)

Extend the registry so each option declares which **roles** it's valid for and the registry knows the per-role default:

```js
// provider: how the model is executed.
//   'cli'    — Claude Code skill via `claude -p --model <model>`
//   'api'    — Anthropic API (direct)
//   'gemini' — Gemini API (direct)
const MODEL_OPTIONS = {
  'gemini-3.5-flash':   { label: 'Gemini 3.5 Flash',     provider: 'gemini', model: 'gemini-3.5-flash', roles: ['soap'] },
  'sonnet-4-6-api':     { label: 'Sonnet 4.6 (API)',     provider: 'api',    model: 'claude-sonnet-4-6', roles: ['soap'] },
  'sonnet-4-6-agentic': { label: 'Sonnet 4.6 (Agentic)', provider: 'cli',    model: 'claude-sonnet-4-6', roles: ['soap','template','engine'] },
  'opus-4-8-agentic':   { label: 'Opus 4.8 (Agentic)',   provider: 'cli',    model: 'claude-opus-4-8',   roles: ['template'] },
  'haiku-4-5-agentic':  { label: 'Haiku 4.5 (Agentic)',  provider: 'cli',    model: 'claude-haiku-4-5-20251001', roles: ['soap','template','engine'] },
  // …existing template raw ids fold into option ids here…
}

const DEFAULTS = { soap: 'sonnet-4-6-api', template: 'opus-4-8-agentic', engine: 'sonnet-4-6-agentic' }

function optionsForRole(role) { /* registry entries whose roles include `role`, label+id */ }
function defaultForRole(role) { return DEFAULTS[role] }
function resolveOption(id, role) { /* lookup, fall back to DEFAULTS[role] */ }
function modelFor(id, role) { /* resolveOption(...).model — the real model name */ }
// Engines are CLI-only: if the resolved option isn't provider:'cli', fall back to the engine default.
function engineModel(id) { /* role 'engine', cli-guarded → claude model name */ }
```

**Key decisions baked in:**
- **Roles** decide which dropdown an option appears in. SOAP can be api/gemini/cli; template + engine are **cli-only** (they're Claude Code skills; the api/gemini providers don't run skills). The registry enforces this — `optionsForRole('template')` only returns cli options.
- **One default per role.** SOAP default stays `sonnet-4-6-api`; template default `opus-4-8-agentic` (today's `claude-opus-4-8`); engine default `sonnet-4-6-agentic`.
- **Engines stop reading `soapModel`.** They resolve `engineModel(settings.engineModel)` (or just the engine default if we don't expose an engine dropdown — **OPEN Q3**).

### 3b. Renderer builds both dropdowns from the registry (no hardcoded `<option>`s)

The renderer is sandboxed and can't `require` the registry. Two ways (**OPEN Q1**):
- **(A — recommended) IPC `getModelOptions()`** returns `{ soap: [...], template: [...], engine?: [...] , defaults }` (role-filtered, provider-gated per §3d). `settingsView.js` builds the `<option>`s dynamically on open. **Zero drift** — one source of truth, the HTML selects start empty.
- **(B) drift-tested copy** in `renderer/constants.js` (like `STATE`/`STATUS_LABELS`), guarded by `tests/unit/shared-drift.test.js`. Simpler wiring, but reintroduces a copy.

Recommend **(A)**: it's the only option that truly removes the duplication, and an IPC is cheap.

### 3c. settings validates both `soapModel` and `templateModel` against the registry

`config/settings.js applyInvariants()` validates each against `optionsForRole(...)`; unknown/legacy/raw-id values map to `defaultForRole(...)`. This **deletes `VALID_SOAP_OPTIONS`** (derive from the registry instead). The "no runtime require in the normalizer" note (§2.4) is reconsidered — either import the registry (no circular dep: `modelOptions.js` has no deps) or expose a tiny `validIdsForRole(role)` the normalizer can call. **Legacy mapping:** existing installs have `templateModel: 'claude-opus-4-8'` (raw id) → map raw model ids to their option id.

### 3d. Provider gating (only offer configured providers)

Only surface options whose provider is actually usable:
- `cli` — always available (the `claude` CLI is required for the app at all).
- `api` — available when an Anthropic API path is configured.
- `gemini` — available only when a Gemini key is configured.
`getModelOptions()` filters on this so the UI never offers a model that will 404 at runtime. (**OPEN Q4** — where "is provider X configured" is read from; today the api/gemini wiring lives in the note-gen dispatch in `main.js`.)

---

## 4. File-by-file change list (for the implementer)

**Modified:**
- `src/llm/modelOptions.js` — the role-tagged registry + `optionsForRole` / `defaultForRole` / `resolveOption(id, role)` / `modelFor` / `engineModel`; keep `resolveOption`/`cliModelFor` shims or migrate callers.
- `config/settings.js` — validate `soapModel` **and** `templateModel` via the registry; delete `VALID_SOAP_OPTIONS`; legacy raw-id → option-id mapping for both.
- `src/llm/claudeCliProvider.js` / the note-gen dispatch in `main.js` — resolve the option → `{provider, model}` once, consistently (SOAP api/gemini/cli paths + template jobs).
- `src/jobs/{templateCreate,templateUpdate}.js` — resolve `templateModel` through `modelFor(id, 'template')` instead of passing the raw setting.
- `src/engines/{icd,cdi,emScore,patientSummary,soap}.js` — `model()` resolves through the registry by role (subsumes the §2.3 hotfix).
- `renderer/views/settingsView.js` — build `#soap-model-select` / `#template-model-select` `<option>`s from `getModelOptions()` on open; keep the change handlers.
- `renderer/index.html` — remove the hardcoded `<option>`s (leave the empty `<select>`s).
- `preload.js` + a new IPC registrar handler (`get-model-options` in `src/ipc/config.js`) + `CHANNELS` — the `getModelOptions()` seam.

**New:**
- `tests/unit/model-registry.test.js` — `optionsForRole` filtering, `defaultForRole`, role-gating (template/engine are cli-only), legacy raw-id mapping, `engineModel` cli-guard.
- (if option B) `renderer/constants.js` copy + a `shared-drift` assertion.

**Docs:** CLAUDE.md (Settings & config files — soapModel/templateModel are registry option ids; the model registry), ARCHITECTURE.md (a "Model selection" subsection), DECISIONS.md (the registry decision + why role-based + IPC-vs-drift-copy choice).

**Explicitly NOT touched:** the actual provider implementations (Anthropic API client, Gemini client, the `claude` CLI provider mechanics) — this is purely about **selection + resolution**, not adding providers/models.

---

## 5. Risks / things to get right

- **Renderer can't `require` the registry.** The IPC (A) or drift-copy (B) is mandatory — don't hardcode and call it done. Q1.
- **Legacy settings.** Installs in the wild have `soapModel: 'sonnet-4-6-api'` (already an id) and `templateModel: 'claude-opus-4-8'` (raw id). The normalizer must map both forward without resetting a user's real choice.
- **Engines must stay CLI-only.** `engineModel()` must never return a non-Claude model even if the registry/default is misconfigured (cli-guard + fallback), or the engines 404 again — the exact bug this plan exists to kill.
- **Don't entangle with the report-pdf branch.** That branch has the interim engine-model fix; this plan generalizes it. Land report-pdf first, then rebase this on the result, or vice-versa — but one branch, one concern.

---

## 6. Open questions (resolve before implementing)

- **Q1 — renderer options: IPC `getModelOptions()` (recommended) vs a drift-tested `renderer/constants.js` copy?**
- **Q2 — registry shape:** one flat registry with a `roles` array (recommended) vs separate per-role registries? (Flat keeps shared options — e.g. agentic Sonnet is valid for all three — defined once.)
- **Q3 — expose an *engine* model dropdown at all,** or keep engines on a fixed default (agentic Sonnet) with no UI? (Today there's no engine dropdown; the user's directive was "engines use Sonnet agentic for now." Recommend: no engine dropdown in v1 — engines use `defaultForRole('engine')`; add a dropdown only if a real need appears.)
- **Q4 — provider gating source:** where does "is the Gemini/api provider configured" get read from for `getModelOptions()`'s filter?
- **Q5 — template provider scope:** template jobs are CLI today; keep template **cli-only** (recommend) or allow api models for templates too?
- **Q6 — `templateEffort`:** it's a separate setting (`max`). Does it belong on the registry option (per-model effort) or stay a standalone setting? (Recommend standalone for now.)

---

## 7. Sequencing

1. Land the registry + helpers in `modelOptions.js` (+ unit tests) — pure, isolated.
2. Switch `config/settings.js` validation to the registry (delete `VALID_SOAP_OPTIONS`); add legacy mapping for `templateModel`.
3. Repoint engines + template jobs + SOAP dispatch at the registry (subsume the §2.3 hotfix).
4. Add `getModelOptions()` IPC; make `settingsView.js` build both dropdowns from it; strip hardcoded `<option>`s.
5. Tests + living docs.

Each step is independently testable. Promote `develop → staging → main` per the branch flow.

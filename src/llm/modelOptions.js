'use strict'

// Registry of note-generation model options.
// Each id encodes both the model AND the execution path (provider).
// The renderer shows label; settings.json stores id.
const NOTE_GEN_OPTIONS = {
  'sonnet-4-6-api':     { label: 'Sonnet 4.6 (API)',     provider: 'api',    model: 'claude-sonnet-4-6' },
  'sonnet-4-6-agentic': { label: 'Sonnet 4.6 (Agentic)', provider: 'cli',    model: 'claude-sonnet-4-6' },
  'sonnet-5-api':       { label: 'Sonnet 5 (API)',       provider: 'api',    model: 'claude-sonnet-5' },
}

const DEFAULT_OPTION_ID = 'sonnet-4-6-api'

// The Anthropic model the post-SOAP engines (ICD / CDI / em-score / patient-summary)
// are pinned to, decoupled from the note-gen selection. A newer note-gen model
// (e.g. Sonnet 5) is for note generation ONLY — it must not silently change coding,
// CDI, or scoring output. This is the stable model those engines + the standards
// packs were validated against. If the engines ever get their own model setting,
// this becomes its default.
const ENGINE_MODEL = 'claude-sonnet-4-6'
function engineModel() { return ENGINE_MODEL }

// Resolve a settings value (option id OR legacy raw model id) to an option object.
// Unknown / legacy values fall back to the API default.
function resolveOption(soapModel) {
  return NOTE_GEN_OPTIONS[soapModel] || NOTE_GEN_OPTIONS[DEFAULT_OPTION_ID]
}

// Resolve a settings value to a model id usable by the `claude` CLI.
//
// The post-SOAP engines (icd / cdi / em-score / patient-summary) and the CLI
// prechart job run through `claude -p` (skills + the ICD-10 MCP connector), so
// they can only use Anthropic models. Passing an option *id* (e.g.
// `sonnet-4-6-api`) straight to the CLI makes it 404 ("model may not exist").
// This resolves the id to its underlying Anthropic model for the `api`/`cli`
// providers, and falls back to the default Anthropic model for unknown/legacy
// selections — the engines always run on Anthropic regardless of the note-gen
// selection.
function resolveCliModel(soapModel) {
  const opt = resolveOption(soapModel)
  if (opt && (opt.provider === 'api' || opt.provider === 'cli')) return opt.model
  return NOTE_GEN_OPTIONS[DEFAULT_OPTION_ID].model
}

module.exports = { NOTE_GEN_OPTIONS, DEFAULT_OPTION_ID, ENGINE_MODEL, resolveOption, resolveCliModel, engineModel }

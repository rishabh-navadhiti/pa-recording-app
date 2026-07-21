'use strict'

// Registry of note-generation model options.
// Each id encodes both the model AND the execution path (provider).
// The renderer shows label; settings.json stores id.
const NOTE_GEN_OPTIONS = {
  'gemini-3.5-flash':   { label: 'Gemini 3.5 Flash',     provider: 'gemini', model: 'gemini-3.5-flash' },
  'gpt-5.6-luna':       { label: 'GPT-5.6 Luna',         provider: 'openai', model: 'gpt-5.6-luna' },
  'sonnet-4-6-api':     { label: 'Sonnet 4.6 (API)',     provider: 'api',    model: 'claude-sonnet-4-6' },
  'sonnet-4-6-agentic': { label: 'Sonnet 4.6 (Agentic)', provider: 'cli',    model: 'claude-sonnet-4-6' },
}

const DEFAULT_OPTION_ID = 'sonnet-4-6-api'

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
// `sonnet-4-6-api`) or a non-Anthropic model (e.g. `gemini-3.5-flash`) straight
// to the CLI makes it 404 ("model may not exist"). This resolves the id to its
// underlying Anthropic model for the `api`/`cli` providers, and falls back to the
// default Anthropic model when the SOAP selection is a provider the CLI can't run
// (Gemini) — the engines still run on Anthropic regardless of the SOAP provider.
function resolveCliModel(soapModel) {
  const opt = resolveOption(soapModel)
  if (opt && (opt.provider === 'api' || opt.provider === 'cli')) return opt.model
  return NOTE_GEN_OPTIONS[DEFAULT_OPTION_ID].model
}

module.exports = { NOTE_GEN_OPTIONS, DEFAULT_OPTION_ID, resolveOption, resolveCliModel }

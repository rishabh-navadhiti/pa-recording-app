'use strict'

// Registry of note-generation model options.
// Each id encodes both the model AND the execution path (provider).
// The renderer shows label; settings.json stores id.
const NOTE_GEN_OPTIONS = {
  'sonnet-4-6-api':     { label: 'Sonnet 4.6 (API)',     provider: 'api', model: 'claude-sonnet-4-6' },
  'sonnet-4-6-agentic': { label: 'Sonnet 4.6 (Agentic)', provider: 'cli', model: 'claude-sonnet-4-6' },
}

const DEFAULT_OPTION_ID = 'sonnet-4-6-api'

// Resolve a settings value (option id OR legacy raw model id) to an option object.
// Unknown / legacy values fall back to the API default.
function resolveOption(soapModel) {
  return NOTE_GEN_OPTIONS[soapModel] || NOTE_GEN_OPTIONS[DEFAULT_OPTION_ID]
}

module.exports = { NOTE_GEN_OPTIONS, DEFAULT_OPTION_ID, resolveOption }

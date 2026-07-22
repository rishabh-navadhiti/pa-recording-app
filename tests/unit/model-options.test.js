'use strict'

// Tests for src/llm/modelOptions.js — especially resolveCliModel, which guards the
// "engines 404 because they got an option-id instead of a CLI model" bug: the
// post-SOAP engines + CLI prechart run via `claude -p` and can only use Anthropic
// models, so the option id (e.g. 'sonnet-4-6-api') and non-Anthropic providers
// (Gemini) must resolve to a CLI-valid Anthropic model.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveOption, resolveCliModel, engineModel, NOTE_GEN_OPTIONS, DEFAULT_OPTION_ID } = require('../../src/llm/modelOptions')

test('resolveOption maps the API option id to its underlying model', () => {
  assert.equal(resolveOption('sonnet-4-6-api').model, 'claude-sonnet-4-6')
  assert.equal(resolveOption('sonnet-4-6-api').provider, 'api')
})

test('resolveCliModel resolves the API option id to a CLI-valid Anthropic model (the 404 fix)', () => {
  // This is the user-reported case: soapModel='sonnet-4-6-api' must NOT reach the
  // CLI verbatim (it 404s). It resolves to the real model id.
  assert.equal(resolveCliModel('sonnet-4-6-api'), 'claude-sonnet-4-6')
})

test('resolveCliModel passes through the agentic (cli) option', () => {
  assert.equal(resolveCliModel('sonnet-4-6-agentic'), 'claude-sonnet-4-6')
})

test('resolveCliModel falls back to the default Anthropic model for a non-Anthropic SOAP provider (Gemini)', () => {
  // The CLI can't run Gemini; the engines still run on Anthropic regardless of
  // the SOAP provider, so a Gemini SOAP selection must not leak a Gemini id to
  // the CLI.
  assert.equal(resolveOption('gemini-3.5-flash').provider, 'gemini')
  assert.equal(resolveCliModel('gemini-3.5-flash'), 'claude-sonnet-4-6')
})

test('resolveCliModel falls back to the default Anthropic model for unknown/legacy values', () => {
  assert.equal(resolveCliModel(undefined), 'claude-sonnet-4-6')
  assert.equal(resolveCliModel('some-legacy-id'), 'claude-sonnet-4-6')
})

test('the default option resolves to an Anthropic model (the CLI fallback target is valid)', () => {
  const opt = NOTE_GEN_OPTIONS[DEFAULT_OPTION_ID]
  assert.ok(opt.provider === 'api' || opt.provider === 'cli', 'default must be an Anthropic provider')
  assert.match(opt.model, /^claude-/)
})

test('Sonnet 5 (API) is a selectable note-gen option mapping to claude-sonnet-5', () => {
  assert.equal(resolveOption('sonnet-5-api').model, 'claude-sonnet-5')
  assert.equal(resolveOption('sonnet-5-api').provider, 'api')
})

test('engineModel is pinned to Sonnet 4.6 regardless of the note-gen selection', () => {
  // The post-SOAP engines (ICD/CDI/em-score/patient-summary) must NOT follow the
  // note-gen model. engineModel() ignores soapModel entirely — picking Sonnet 5 for
  // notes leaves coding/CDI/scoring on Sonnet 4.6.
  assert.equal(engineModel(), 'claude-sonnet-4-6')
})

test('resolveOption maps the luna option id to the openai provider + model', () => {
  const opt = resolveOption('gpt-5.6-luna')
  assert.equal(opt.provider, 'openai')
  assert.equal(opt.model, 'gpt-5.6-luna')
})

test('resolveCliModel falls back to the default Anthropic model for the openai SOAP provider', () => {
  // The CLI can't run OpenAI; the post-SOAP engines still run on Anthropic, so a
  // luna SOAP selection must not leak the gpt id to the CLI (it would 404).
  assert.equal(resolveCliModel('gpt-5.6-luna'), 'claude-sonnet-4-6')
})

test('adding luna did not change the default option', () => {
  assert.equal(DEFAULT_OPTION_ID, 'sonnet-4-6-api')
})

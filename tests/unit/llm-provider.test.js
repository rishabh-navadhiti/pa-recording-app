'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')

const { createChildRunner, resolveClaudeCommand } = require('../../src/llm/childRunner')
const { createClaudeCliProvider } = require('../../src/llm/claudeCliProvider')

// ---- createChildRunner -----------------------------------------------------

test('createChildRunner.run() delegates to the injected spawnFn', () => {
  const calls = []
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return new EventEmitter() }
  const runner = createChildRunner(fakeSpawn)
  runner.run('foo', ['a', 'b'], { shell: false })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].cmd, 'foo')
  assert.deepStrictEqual(calls[0].args, ['a', 'b'])
})

// ---- resolveClaudeCommand --------------------------------------------------

test('resolveClaudeCommand returns cmd.exe on win32, claude otherwise', () => {
  // We can't change process.platform in the test, but we can verify the shape.
  const { cmd, baseArgs } = resolveClaudeCommand()
  if (process.platform === 'win32') {
    assert.strictEqual(cmd, 'cmd.exe')
    assert.ok(baseArgs.includes('claude'), 'win32 baseArgs should include claude')
  } else {
    assert.strictEqual(cmd, 'claude')
    assert.deepStrictEqual(baseArgs, [])
  }
})

// ---- createClaudeCliProvider -----------------------------------------------

/**
 * Build a fake child runner that emits canned stream-json stdout then closes.
 */
function fakeRunner(lines, exitCode = 0) {
  const calls = []
  function spawnFn(cmd, args, opts) {
    calls.push({ cmd, args, opts })
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = { write: () => {}, end: () => {} }

    // Emit lines asynchronously so the promise has time to set up handlers.
    setImmediate(() => {
      for (const line of lines) proc.stdout.emit('data', Buffer.from(line + '\n'))
      proc.emit('close', exitCode)
    })
    return proc
  }
  spawnFn.calls = calls
  return spawnFn
}

const RESULT_EVENT = JSON.stringify({
  type: 'result',
  result: 'SOAP note content here.',
  usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.0042,
  num_turns: 2,
  duration_ms: 1234,
})

test('claudeCliProvider.runSkill resolves with text + resultEvent on success', async () => {
  const logs = []
  const provider = createClaudeCliProvider({
    cwd: '/tmp/notes',
    log: (m) => logs.push(m),
    runner: createChildRunner(fakeRunner([RESULT_EVENT])),
  })
  const result = await provider.runSkill({ prompt: 'generate a note', model: 'claude-sonnet-4-6', label: 'soap' })
  assert.strictEqual(result.code, 0)
  assert.strictEqual(result.text, 'SOAP note content here.')
  assert.ok(result.resultEvent, 'should have parsed result event')
  assert.strictEqual(result.resultEvent.usage.input_tokens, 100)
  assert.strictEqual(result.errText, '')
})

test('claudeCliProvider.runSkill resolves with code:null on spawn error', async () => {
  function errSpawn() {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => proc.emit('error', new Error('ENOENT: claude not found')))
    return proc
  }
  const provider = createClaudeCliProvider({
    cwd: '/tmp/notes',
    log: () => {},
    runner: createChildRunner(errSpawn),
  })
  const result = await provider.runSkill({ prompt: 'test', label: 'test' })
  assert.strictEqual(result.code, null)
  assert.ok(result.errText.includes('ENOENT'))
})

test('claudeCliProvider.runSkill captures stderr', async () => {
  function stderrSpawn() {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from('rate limit reached\n'))
      proc.emit('close', 1)
    })
    return proc
  }
  const provider = createClaudeCliProvider({
    cwd: '/tmp/notes',
    log: () => {},
    runner: createChildRunner(stderrSpawn),
  })
  const result = await provider.runSkill({ prompt: 'test', label: 'test' })
  assert.strictEqual(result.code, 1)
  assert.ok(result.errText.includes('rate limit'))
})

test('claudeCliProvider args never include the prompt in a shell string', async () => {
  // The injection safety test: even if the prompt contains shell metacharacters,
  // the args array keeps them as literal strings.
  const captured = []
  function capturingSpawn(cmd, args, opts) {
    captured.push({ cmd, args, opts })
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    setImmediate(() => proc.emit('close', 0))
    return proc
  }
  const provider = createClaudeCliProvider({
    cwd: '/tmp/notes',
    log: () => {},
    runner: createChildRunner(capturingSpawn),
  })
  const dangerousPrompt = 'test `rm -rf /` $(evil) ; bad'
  await provider.runSkill({ prompt: dangerousPrompt, label: 'test' })
  assert.ok(captured.length === 1)
  // shell: false — no shell involved
  assert.strictEqual(captured[0].opts.shell, false)
  // prompt is a separate argv element, not embedded in a command string
  const promptIndex = captured[0].args.indexOf('-p') + 1
  assert.strictEqual(captured[0].args[promptIndex], dangerousPrompt)
})

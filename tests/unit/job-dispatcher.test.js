'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { runJob } = require('../../src/jobs/jobDispatcher')
const { createJobRunner } = require('../../jobs/jobRunner')

// A minimal fake ctx — no real DB, no Electron.
function fakeCtx(llmResult) {
  const events = []
  const jobState = {
    save: (j) => events.push(['jobState.save', j.status]),
    load: () => ({ status: 'idle' }),
    clearStaleRunning: () => {},
  }
  const jobs = createJobRunner({ jobState, log: () => {} })
  return {
    log: () => {},
    config: { get: () => ({ templateModel: 'opus', templateEffort: 'max', soapModel: 'sonnet' }) },
    paths: { templatesDir: '/tmp/templates', notesDir: '/tmp/notes' },
    db: null,
    llm: { runSkill: async (opts) => { events.push(['runSkill', opts.label, !!opts.signal]); return llmResult } },
    renderer: { send: (ch, j) => events.push(['renderer.send', j.status]) },
    sendStatus: () => {},
    jobState,
    stores: { jobs },
    platform: { notify: () => {} },
    _events: events,
  }
}

// A trivial descriptor exercising the dispatcher contract.
function fakeDescriptor() {
  const hooks = []
  return {
    desc: {
      id: 'fake-job',
      skillId: 'create-doctor-profile',   // must be a known builder
      label: 'fake',
      jobKind: 'template_create',
      lockType: 'create',
      model: (cfg) => cfg.templateModel,
      effort: (cfg) => cfg.templateEffort,
      onRunning: () => hooks.push('running'),
      onSuccess: () => hooks.push('success'),
      onFailure: () => hooks.push('failure'),
      onRateLimit: () => hooks.push('rateLimit'),
      onError: () => hooks.push('error'),
    },
    hooks,
  }
}

const INPUT = { doctorName: 'Dr. Test', stagingRel: 'Templates/_staging/test' }

test('runJob acquires then releases the lock (idle after success)', async () => {
  const ctx = fakeCtx({ code: 0, text: 'done', resultEvent: null, errText: '' })
  const { desc, hooks } = fakeDescriptor()
  await runJob(desc, INPUT, ctx, {})
  assert.ok(hooks.includes('running'), 'onRunning fired')
  assert.ok(hooks.includes('success'), 'onSuccess fired')
  assert.strictEqual(ctx.stores.jobs.isRunning(), false, 'lock released after completion')
})

test('runJob passes an AbortSignal to the provider', async () => {
  const ctx = fakeCtx({ code: 0, text: 'ok', resultEvent: null, errText: '' })
  const { desc } = fakeDescriptor()
  await runJob(desc, INPUT, ctx, {})
  const runSkillCall = ctx._events.find(e => e[0] === 'runSkill')
  assert.ok(runSkillCall, 'runSkill was called')
  assert.strictEqual(runSkillCall[2], true, 'signal was passed')
})

test('runJob routes rate-limit to onRateLimit', async () => {
  const ctx = fakeCtx({ code: 1, text: 'Claude AI usage limit reached', resultEvent: null, errText: '' })
  const { desc, hooks } = fakeDescriptor()
  await runJob(desc, INPUT, ctx, {})
  assert.ok(hooks.includes('rateLimit'), 'onRateLimit fired')
  assert.ok(!hooks.includes('success'), 'onSuccess did NOT fire')
  assert.strictEqual(ctx.stores.jobs.isRunning(), false, 'lock released')
})

test('runJob routes non-zero exit to onFailure', async () => {
  const ctx = fakeCtx({ code: 2, text: '', resultEvent: null, errText: 'boom' })
  const { desc, hooks } = fakeDescriptor()
  await runJob(desc, INPUT, ctx, {})
  assert.ok(hooks.includes('failure'), 'onFailure fired')
  assert.strictEqual(ctx.stores.jobs.isRunning(), false)
})

test('lock is held during the run (second start rejected)', async () => {
  const ctx = fakeCtx({ code: 0, text: 'ok', resultEvent: null, errText: '' })
  const { desc } = fakeDescriptor()
  // Start without awaiting — lock should be acquired synchronously before first await.
  const p = runJob(desc, INPUT, ctx, {})
  assert.strictEqual(ctx.stores.jobs.isRunning(), true, 'lock held synchronously after runJob call')
  const second = ctx.stores.jobs.start('create', {}, null)
  assert.strictEqual(second.ok, false, 'second start rejected while job running')
  await p
  assert.strictEqual(ctx.stores.jobs.isRunning(), false, 'lock released after await')
})

test('cancel() aborts the in-flight run via the abort-proc', async () => {
  let abortedSignalSeen = false
  const ctx = fakeCtx({ code: null, text: '', resultEvent: null, errText: 'aborted' })
  // Override runSkill to observe the signal and resolve when aborted.
  ctx.llm.runSkill = (opts) => new Promise(resolve => {
    opts.signal.addEventListener('abort', () => { abortedSignalSeen = true; resolve({ code: null, text: '', resultEvent: null, errText: 'aborted' }) })
  })
  const { desc } = fakeDescriptor()
  const p = runJob(desc, INPUT, ctx, {})
  assert.strictEqual(ctx.stores.jobs.isRunning(), true)
  ctx.stores.jobs.cancel()   // → abort-proc.kill() → ac.abort()
  await p
  assert.ok(abortedSignalSeen, 'provider observed the abort signal')
})

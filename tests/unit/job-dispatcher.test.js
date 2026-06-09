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

// ---- DB-backed: regression fixes (single finishEvent, status override, eventFields) ----

const Database = require('better-sqlite3')
const { initDbWith, runMigrations } = require('../../db/init')
const dbEvents = require('../../db/events')

function dbCtx(llmResult) {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initDbWith(db)
  runMigrations(db)
  const jobs = createJobRunner({ jobState: { save(){}, load: () => ({status:'idle'}), clearStaleRunning(){} }, log: () => {} })
  return {
    _db: db,
    log: () => {},
    config: { get: () => ({ templateModel: 'opus', templateEffort: 'max' }) },
    paths: { templatesDir: '/tmp/t', notesDir: '/tmp/n' },
    db,
    llm: { runSkill: async () => llmResult },
    renderer: { send: () => {} },
    sendStatus: () => {},
    jobState: { save(){}, load: () => ({status:'idle'}), clearStaleRunning(){} },
    stores: { jobs },
    platform: { notify: () => {} },
  }
}

function descBase() {
  return {
    id: 'fake', skillId: 'create-doctor-profile', label: 'fake', jobKind: 'template_create', lockType: 'create',
    model: (c) => c.templateModel, effort: (c) => c.templateEffort,
    onRunning(){}, onRateLimit(){}, onFailure(){}, onError(){},
  }
}

const OK_RESULT = { code: 0, text: 'ok', resultEvent: { usage: { input_tokens: 500, output_tokens: 100 }, total_cost_usd: 0.01, duration_ms: 1000 }, errText: '' }

test('DB: single finishEvent keeps status=success + usage (no clobber)', async () => {
  const ctx = dbCtx(OK_RESULT)
  const desc = { ...descBase(), onSuccess: () => ({ ok: true }) }
  await runJob(desc, { doctorName: 'X', stagingRel: 's' }, ctx, {})
  const row = ctx._db.prepare('SELECT status, input_tokens, cost_usd FROM processing_events ORDER BY id DESC LIMIT 1').get()
  assert.strictEqual(row.status, 'success', 'status must survive')
  assert.strictEqual(row.input_tokens, 500, 'usage must survive (not clobbered to NULL)')
  assert.strictEqual(row.cost_usd, 0.01)
})

test('DB: onSuccess returning {ok:false} writes status=failed', async () => {
  const ctx = dbCtx(OK_RESULT)
  const desc = { ...descBase(), onSuccess: () => ({ ok: false, error: 'template file not found' }) }
  await runJob(desc, { doctorName: 'X', stagingRel: 's' }, ctx, {})
  const row = ctx._db.prepare('SELECT status, error_message FROM processing_events ORDER BY id DESC LIMIT 1').get()
  assert.strictEqual(row.status, 'failed', 'descriptor can override status to failed even on exit 0')
  assert.match(row.error_message, /template file not found/)
})

test('DB: onSuccess eventFields persist (backupPath)', async () => {
  const ctx = dbCtx(OK_RESULT)
  const desc = { ...descBase(), onSuccess: () => ({ eventFields: { backupPath: '/notes/case/backup_123.md' } }) }
  await runJob(desc, { doctorName: 'X', stagingRel: 's' }, ctx, {})
  const row = ctx._db.prepare('SELECT status, backup_path FROM processing_events ORDER BY id DESC LIMIT 1').get()
  assert.strictEqual(row.status, 'success')
  assert.strictEqual(row.backup_path, '/notes/case/backup_123.md')
})

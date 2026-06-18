'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createLogger, redact } = require('../../log/logger')

function tmpFile() {
  return path.join(os.tmpdir(), `logger-test-${Date.now()}.log`)
}

test('logger writes timestamped lines to a temp file', () => {
  const f = tmpFile()
  const logger = createLogger(f)
  logger.log('hello world')
  const content = fs.readFileSync(f, 'utf8')
  assert.match(content, /\[INFO\] hello world/)
  assert.match(content, /^\[\d{4}-\d{2}-\d{2}T/)
  fs.unlinkSync(f)
})

test('logger levels appear in output', () => {
  const f = tmpFile()
  const logger = createLogger(f)
  logger.info('info msg')
  logger.warn('warn msg')
  logger.error('error msg')
  const content = fs.readFileSync(f, 'utf8')
  assert.match(content, /\[INFO\] info msg/)
  assert.match(content, /\[WARN\] warn msg/)
  assert.match(content, /\[ERROR\] error msg/)
  fs.unlinkSync(f)
})

test('redact strips case-folder slugs', () => {
  assert.strictEqual(redact('processing jane_doe_2026-05-22'), 'processing [case]')
  assert.strictEqual(redact('case john_smith_2026-01-15 done'), 'case [case] done')
})

test('redact handles multi-word slugs', () => {
  const result = redact('folder: mary_jane_watson_2026-06-04')
  assert.ok(!result.includes('mary'), 'should not contain first name')
  assert.match(result, /\[case\]/)
})

test('redact passes through non-PII text', () => {
  assert.strictEqual(redact('npm install completed'), 'npm install completed')
  assert.strictEqual(redact('[db] Applied migration: 001_init.sql'), '[db] Applied migration: 001_init.sql')
})

test('logger redacts PII before writing to disk', () => {
  const f = tmpFile()
  const logger = createLogger(f)
  logger.log('[case] processing jane_doe_2026-05-22')
  const content = fs.readFileSync(f, 'utf8')
  assert.ok(!content.includes('jane_doe'), 'patient slug must not appear in log file')
  assert.match(content, /\[case\]/)
  fs.unlinkSync(f)
})

test('null logFilePath creates stdout-only logger without crashing', () => {
  const logger = createLogger(null)
  assert.doesNotThrow(() => logger.log('bootstrap message'))
})

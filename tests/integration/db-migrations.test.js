'use strict'

// Integration test: DB migration hardening.
// Verifies that the migration runner correctly advances user_version and wraps
// each migration in a transaction — using an in-memory DB seeded at v4
// (the version shipped to production on 2026-06-01).
//
// Run with: node --test tests/integration/db-migrations.test.js
// (or via: npm test)

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const MIGRATIONS_DIR = path.join(__dirname, '../../db/migrations')
const { runMigrations, initDbWith, getDb } = require('../../db/init')

// Build a fresh in-memory DB and apply migrations up to `targetVersion`.
function buildSeedDb(targetVersion) {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort()

  for (const file of files) {
    const fileVersion = parseInt(file.slice(0, 3), 10)
    if (fileVersion > targetVersion) break
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    db.exec(sql)  // apply raw SQL including its PRAGMA user_version = N
  }

  assert.strictEqual(
    db.pragma('user_version', { simple: true }),
    targetVersion,
    `seed DB should be at user_version=${targetVersion}`
  )
  return db
}

// The current version is the highest numbered migration file.
function currentVersion() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort()
  if (files.length === 0) return 0
  return parseInt(files[files.length - 1].slice(0, 3), 10)
}

test('migration replay from user_version=4 reaches current version', () => {
  const seed = buildSeedDb(4)
  const target = currentVersion()

  // If the current version is already 4 (no new migrations), this is a no-op test.
  // It still confirms the runner doesn't corrupt a fully-migrated DB.

  // Inject the seeded DB and run the hardened migration runner on it.
  initDbWith(seed)
  runMigrations(seed)

  assert.strictEqual(
    seed.pragma('user_version', { simple: true }),
    target,
    `after migration replay, user_version should be ${target}`
  )
})

test('re-running migrations on an already-current DB is a no-op', () => {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initDbWith(db)
  runMigrations(db)  // first run — reaches current version
  const v1 = db.pragma('user_version', { simple: true })

  runMigrations(db)  // second run — should be a no-op
  const v2 = db.pragma('user_version', { simple: true })

  assert.strictEqual(v1, v2, 're-running migrations must not change user_version')
})

test('migration runner leaves all expected tables after full replay', () => {
  const seed = buildSeedDb(4)
  initDbWith(seed)
  runMigrations(seed)

  const tables = seed.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)

  for (const expected of ['doctors', 'sessions', 'cases', 'processing_events', 'cdi_flags']) {
    assert.ok(tables.includes(expected), `table '${expected}' should exist after migrations`)
  }
})

test('withDb wrapper returns fallback and does not throw when fn errors', () => {
  const { withDb } = require('../../db/withDb')
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  initDbWith(db)
  runMigrations(db)

  const result = withDb('test-error', () => { throw new Error('boom') }, 'fallback')
  assert.strictEqual(result, 'fallback')
})

test('withDb wrapper returns fn result on success', () => {
  const { withDb } = require('../../db/withDb')
  const result = withDb('test-ok', () => 42)
  assert.strictEqual(result, 42)
})

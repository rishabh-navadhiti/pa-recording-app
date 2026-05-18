'use strict'

const path = require('path')
const fs   = require('fs')
const Database = require('better-sqlite3')

let _db = null

// Open (or return the cached) DB connection.
// Must be called with notesDir on first use; subsequent calls return the cached instance.
// Returns null if notesDir is not yet known — all callers must handle null.
function initDb(notesDir) {
  if (_db) return _db
  if (!notesDir) return null

  const dbPath = path.join(notesDir, 'app.db')
  try {
    _db = new Database(dbPath)
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    _db.pragma('busy_timeout = 5000')
    runMigrations(_db)
    return _db
  } catch (e) {
    console.error('[db] Failed to open database:', e.message)
    _db = null
    return null
  }
}

function getDb() {
  return _db
}

// Called when the notes directory changes (user picks a new folder).
// Closes the old connection and re-opens at the new path.
function resetDb(newNotesDir) {
  if (_db) {
    try { _db.close() } catch (_) {}
    _db = null
  }
  return initDb(newNotesDir)
}

function runMigrations(db) {
  const currentVersion = db.pragma('user_version', { simple: true })
  const migrationsDir = path.join(__dirname, 'migrations')

  const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort()

  for (const file of files) {
    const fileVersion = parseInt(file.slice(0, 3), 10)
    if (fileVersion <= currentVersion) continue

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    // Run each migration in a transaction (except the PRAGMA user_version line,
    // which better-sqlite3 handles fine inside a transaction on WAL mode)
    db.exec(sql)
    console.log(`[db] Applied migration: ${file}`)
  }
}

// One-time migration: move doctors[] from settings.json into the doctors table.
// Runs after the v1 schema is in place. Safe to call on every startup — INSERT OR IGNORE
// means re-running it on an already-migrated install is a no-op.
function migrateDoctorsFromSettings(db, doctors, writeSettingsFn, notesDir, extractLastnameFn) {
  if (!db || !doctors || doctors.length === 0) return

  const existing = db.prepare('SELECT COUNT(*) as n FROM doctors').get()
  if (existing.n > 0) return  // already migrated

  const ts = new Date().toISOString()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO doctors (id, name, lastname, template_path, enable_cdi, created_at, updated_at)
    VALUES (@id, @name, @lastname, @template_path, 0, @ts, @ts)
  `)

  const txn = db.transaction(rows => {
    for (const d of rows) insert.run(d)
  })

  txn(doctors.map(d => ({
    id:            d.id,
    name:          d.name,
    lastname:      extractLastnameFn(d.name) || d.name.toLowerCase(),
    template_path: d.templatePath || null,
    ts
  })))

  // Write backup of old doctors list, then strip doctors[] from settings.json
  try {
    const backupPath = path.join(notesDir, 'settings.doctors.backup.json')
    fs.writeFileSync(backupPath, JSON.stringify(doctors, null, 2))
    writeSettingsFn({ doctors: [] })
    console.log(`[db] Migrated ${doctors.length} doctor(s) from settings.json. Backup at: ${backupPath}`)
  } catch (e) {
    console.error('[db] WARNING: doctor migration cleanup failed:', e.message)
  }
}

// If app.db was deleted and doctors[] is also gone, try restoring from backup file.
function tryRestoreDoctorsFromBackup(db, notesDir, writeSettingsFn, extractLastnameFn) {
  if (!db) return
  const existing = db.prepare('SELECT COUNT(*) as n FROM doctors').get()
  if (existing.n > 0) return

  const backupPath = path.join(notesDir, 'settings.doctors.backup.json')
  if (!fs.existsSync(backupPath)) return

  try {
    const doctors = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    if (!Array.isArray(doctors) || doctors.length === 0) return
    migrateDoctorsFromSettings(db, doctors, writeSettingsFn, notesDir, extractLastnameFn)
    console.log('[db] Restored doctors from backup file')
  } catch (e) {
    console.error('[db] WARNING: could not restore from doctor backup:', e.message)
  }
}

module.exports = { initDb, getDb, resetDb, migrateDoctorsFromSettings, tryRestoreDoctorsFromBackup }

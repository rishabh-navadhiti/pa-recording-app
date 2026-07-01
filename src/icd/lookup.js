'use strict'

const fs   = require('fs')
const path = require('path')

/**
 * Local ICD-10-CM lookup library — the offline replacement for the claude.ai
 * ICD-10 MCP connector on the ICD-coding path. Reads the bundled, read-only
 * SQLite codeset (data/icd/icd10cm_fy<YEAR>.db, built by data/icd/build_icd_db.py)
 * via better-sqlite3 (already an app dependency). Pure lookups, no network,
 * sub-millisecond. Mirrors the connector tool surface the skill used to call.
 *
 * The DB is ground truth for code existence + billable status + description;
 * the model proposes codes, this library verifies them (see src/icd/coder.js).
 */

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'icd')

/** Newest bundled icd10cm_fy<YEAR>.db (so dropping next year's file needs no code change). */
function resolveDbPath() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => /^icd10cm_fy\d{4}\.db$/.test(f)).sort()
    if (files.length) return path.join(DATA_DIR, files[files.length - 1])
  } catch {}
  return path.join(DATA_DIR, 'icd10cm_fy2026.db')
}

const DB_PATH = resolveDbPath()

let _db      = null   // better-sqlite3 handle
let _opened  = false  // have we attempted to open?
let _stmts   = null

function open() {
  if (_opened) return _db
  _opened = true
  try {
    const Database = require('better-sqlite3')
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    _stmts = {
      byCode:   _db.prepare('SELECT code, billable, short_desc FROM codes WHERE code = ?'),
      childOne: _db.prepare('SELECT 1 FROM codes WHERE code_nodot LIKE ? AND code_nodot != ? AND billable = 1 LIMIT 1'),
      children: _db.prepare('SELECT code, billable, short_desc FROM codes WHERE code_nodot LIKE ? AND code_nodot != ? ORDER BY code_nodot LIMIT ?'),
    }
  } catch {
    _db = null
  }
  return _db
}

/** True when the bundled codeset DB opened successfully. */
function isAvailable() {
  return open() != null
}

/** Accept dotted or dotless input; return the dotted canonical form (dot after char 3). */
function normalize(code) {
  const c = String(code || '').trim().toUpperCase().replace(/\./g, '')
  return c.length <= 3 ? c : c.slice(0, 3) + '.' + c.slice(3)
}

/**
 * The validate_code / lookup_code equivalent.
 * @returns {{code, exists, billable, short}}  short is the official short description.
 */
function validate(code) {
  const db   = open()
  const norm = normalize(code)
  if (!db) return { code: norm, exists: false, billable: false, short: null }
  const r = _stmts.byCode.get(norm)
  if (!r) return { code: norm, exists: false, billable: false, short: null }
  return { code: r.code, exists: true, billable: !!r.billable, short: r.short_desc }
}

/**
 * The De-Quervain guard: is there a longer BILLABLE code under this code's stem? (Prefix query.)
 * Part of the codeset-lookup surface (mirrors the connector); available for a future
 * "needs more specificity" check. The current coder dial handles header codes via
 * search-resolve and does not call this yet.
 */
function hasMoreSpecificBillableChild(code) {
  const db = open()
  if (!db) return false
  const nd = normalize(code).replace(/\./g, '')
  return !!_stmts.childOne.get(nd + '%', nd)
}

/** Longer codes under this stem (the hierarchy-by-prefix helper). */
function children(code, { billableOnly = false, limit = 50 } = {}) {
  const db = open()
  if (!db) return []
  const nd   = normalize(code).replace(/\./g, '')
  const rows = _stmts.children.all(nd + '%', nd, limit)
  const out  = rows.map(r => ({ code: r.code, billable: !!r.billable, short: r.short_desc }))
  return billableOnly ? out.filter(x => x.billable) : out
}

/** FTS5 description search (the search_codes equivalent). Terms are AND-ed prefix matches. */
function search(text, { billableOnly = true, limit = 15 } = {}) {
  const db = open()
  if (!db) return []
  const terms = String(text || '').match(/[A-Za-z0-9]+/g) || []
  if (!terms.length) return []
  const q = terms.map(t => `${t}*`).join(' ')
  let sql = 'SELECT f.code AS code, c.billable AS billable, c.short_desc AS short_desc '
          + 'FROM codes_fts f JOIN codes c ON c.code = f.code WHERE codes_fts MATCH ? '
  if (billableOnly) sql += 'AND c.billable = 1 '
  sql += 'ORDER BY rank LIMIT ?'
  try {
    return db.prepare(sql).all(q, limit)
      .map(r => ({ code: r.code, billable: !!r.billable, short: r.short_desc }))
  } catch {
    return []
  }
}

module.exports = { validate, lookup: validate, search, hasMoreSpecificBillableChild, children, isAvailable, normalize, DB_PATH }

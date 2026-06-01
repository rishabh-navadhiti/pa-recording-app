'use strict'

const { getDb } = require('./init')

function listDoctors() {
  const db = getDb()
  if (!db) return []
  try {
    return db.prepare('SELECT id, name, lastname, template_path AS templatePath, specialty, enable_cdi FROM doctors ORDER BY name').all()
  } catch (e) {
    console.error('[db] listDoctors failed:', e.message)
    return []
  }
}

function getDoctor(id) {
  const db = getDb()
  if (!db) return null
  try {
    const row = db.prepare('SELECT id, name, lastname, template_path AS templatePath, specialty, enable_cdi FROM doctors WHERE id = ?').get(id)
    return row || null
  } catch (e) {
    console.error('[db] getDoctor failed:', e.message)
    return null
  }
}

function getDoctorByLastname(lastname) {
  const db = getDb()
  if (!db) return null
  try {
    const row = db.prepare('SELECT id, name, lastname, template_path AS templatePath FROM doctors WHERE lastname = ?').get(lastname)
    return row || null
  } catch (e) {
    console.error('[db] getDoctorByLastname failed:', e.message)
    return null
  }
}

// Insert or update a doctor. Supply { id, name, lastname, templatePath }.
function upsertDoctor(doctor) {
  const db = getDb()
  if (!db) return
  try {
    const ts = new Date().toISOString()
    db.prepare(`
      INSERT INTO doctors (id, name, lastname, template_path, enable_cdi, created_at, updated_at)
      VALUES (@id, @name, @lastname, @templatePath, 0, @ts, @ts)
      ON CONFLICT(id) DO UPDATE SET
        name          = excluded.name,
        lastname      = excluded.lastname,
        template_path = excluded.template_path,
        updated_at    = excluded.updated_at
    `).run({ ...doctor, ts })
  } catch (e) {
    console.error('[db] upsertDoctor failed:', e.message)
  }
}

function removeDoctor(id) {
  const db = getDb()
  if (!db) return
  try {
    db.prepare('DELETE FROM doctors WHERE id = ?').run(id)
  } catch (e) {
    console.error('[db] removeDoctor failed:', e.message)
  }
}

function updateDoctorTemplate(id, templatePath) {
  const db = getDb()
  if (!db) return
  try {
    db.prepare('UPDATE doctors SET template_path = ?, updated_at = ? WHERE id = ?')
      .run(templatePath, new Date().toISOString(), id)
  } catch (e) {
    console.error('[db] updateDoctorTemplate failed:', e.message)
  }
}

function getDoctorsWithTemplates() {
  const db = getDb()
  if (!db) return []
  try {
    return db.prepare("SELECT id, name, lastname, template_path AS templatePath FROM doctors WHERE template_path IS NOT NULL ORDER BY name").all()
  } catch (e) {
    console.error('[db] getDoctorsWithTemplates failed:', e.message)
    return []
  }
}

module.exports = { listDoctors, getDoctor, getDoctorByLastname, upsertDoctor, removeDoctor, updateDoctorTemplate, getDoctorsWithTemplates }

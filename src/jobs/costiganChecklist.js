'use strict'

const fs   = require('fs')
const path = require('path')
const { buildSingleCallCostiganCdi } = require('../llm/skill-io/singleCall')
const { renderCostiganMd }           = require('../render/costiganMd')
const { normalizeApiUsage }          = require('../llm/pricing')

const SKILL_PATH     = path.join(__dirname, '../../notes-claude/skills/cdi-costigan-api/SKILL.md')
const PROCEDURES_DIR = path.join(__dirname, '../../notes-claude/standards/procedures')
const PACK_FILES     = ['esi', 'facet', 'tpi', 'si', 'pva']   // README is policy, not a rubric
const MODEL          = 'claude-sonnet-4-6'

function isCostiganDoctor(doctor) {
  if (!doctor) return false
  const ln = (doctor.lastname || '').toLowerCase()
  if (ln) return ln === 'costigan'
  return /\bcostigan\b/i.test(doctor.name || '')
}

function loadProcedurePacks() {
  return PACK_FILES.map(name => {
    const p = path.join(PROCEDURES_DIR, `${name}.md`)
    return `<!-- pack: ${name} -->\n` + fs.readFileSync(p, 'utf8')
  }).join('\n\n---\n\n')
}

/** Extract the JSON object from model text (handles ```json fences and leading prose). */
function extractChecklistJson(text) {
  if (!text) return null
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(t) } catch {}
  const start = t.indexOf('{'); const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)) } catch {} }
  return null
}

function findFinalNote(caseDir) {
  try {
    const f = fs.readdirSync(caseDir).find(x => x.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(x))
    return f ? path.join(caseDir, f) : null
  } catch { return null }
}

function parseHeaderFacts(noteText, caseDir) {
  const head = (noteText || '').slice(0, 4096)
  const dos = (head.match(/\*\*Date:\*\*\s*([^\n\r]+)/) || head.match(/Date of Service:\s*([^\n\r]+)/) || [])[1] || ''
  const patient = path.basename(caseDir).replace(/_\d{4}-\d{2}-\d{2}.*$/, '').replace(/_/g, ' ')
  return { dateOfService: dos.trim(), patientName: patient }
}

/**
 * Run the Costigan procedure checklist for a case (gated). Always resolves.
 * @param {{ caseDir:string, doctor:object, chartText?:string, caseId?:(string|number), ctx:object }} args
 */
async function runCostiganChecklist({ caseDir, doctor, chartText, caseId, ctx }) {
  const { log } = ctx
  const tag = '[costigan]'
  let eventId = null
  let finished = false
  const finish = (status, usage, errMsg) => {
    if (finished) return
    finished = true
    try { require('../../db/events').finishEvent(eventId, { status, errorMessage: errMsg || null, finishedAt: new Date().toISOString(), ...(usage || {}) }) } catch {}
  }
  try {
    if (!ctx.config.get().enableCostiganCdi) { log(`${tag} disabled — skip`); return }
    if (!isCostiganDoctor(doctor))           { log(`${tag} not Dr. Costigan — skip`); return }

    const notePath = findFinalNote(caseDir)
    if (!notePath) { log(`${tag} no soap note in ${caseDir} — skip`); return }
    const noteText  = fs.readFileSync(notePath, 'utf8')
    const skillText = fs.readFileSync(SKILL_PATH, 'utf8')
    const packsText = loadProcedurePacks()
    const { dateOfService, patientName } = parseHeaderFacts(noteText, caseDir)
    const stem = path.basename(notePath, '_soap_note.md')
    const writtenArtifacts = []   // paths to hide on Windows after the run

    // Persist the raw chart input so it isn't lost (it lives only as pasted text).
    if (chartText && chartText.trim()) {
      const chartPath = path.join(caseDir, `${stem}_chart_input.md`)
      try { fs.writeFileSync(chartPath, chartText, 'utf8'); writtenArtifacts.push(chartPath) } catch (e) { log(`${tag} chart save failed: ${e.message}`) }
    }

    const { system, user } = buildSingleCallCostiganCdi({
      skillText, packsText, noteText, chartText,
      patientName, dateOfService, doctorName: doctor?.name || 'William M. Costigan, M.D.',
    })

    const startedAt = new Date().toISOString()
    try { eventId = require('../../db/events').startEvent({ caseId: caseId || null, jobKind: 'costigan', relatedDoctorId: doctor?.id || null, modelUsed: MODEL, effort: 'high', startedAt }) } catch (e) { log(`${tag} startEvent: ${e.message}`) }

    let result = await ctx.api.runSingleCall({ system, user, model: MODEL, tag, label: 'cdi-costigan:api' })
    if (!result.ok) { log(`${tag} API failed: ${result.errText}`); finish('failed', normalizeApiUsage({ model: MODEL, rawUsage: result.rawUsage, durationMs: result.durationMs }), result.errText); return }

    let data = extractChecklistJson(result.text)
    if (!data && result.stopReason !== 'max_tokens') {
      // One retry with a stricter nudge.
      log(`${tag} JSON parse failed — retrying once`)
      result = await ctx.api.runSingleCall({ system, user: user + '\n\nReturn ONLY a single valid JSON object. No prose, no code fences.', model: MODEL, tag, label: 'cdi-costigan:api:retry' })
      data = result.ok ? extractChecklistJson(result.text) : null
    }

    const jsonPath = path.join(caseDir, `${stem}_costigan.json`)
    const mdPath   = path.join(caseDir, `${stem}_costigan.md`)
    if (!data) {
      const rawPath = path.join(caseDir, `${stem}_costigan.raw.txt`)
      try { fs.writeFileSync(rawPath, result.text || '', 'utf8'); writtenArtifacts.push(rawPath) } catch {}
      data = { meta: { patient: patientName, case_dir: caseDir, generated_at: startedAt }, parse_error: true, raw_output_path: rawPath }
    }

    // Stamp the real generated_at + case_dir (the model leaves them blank).
    data.meta = data.meta || {}
    data.meta.generated_at = data.meta.generated_at || startedAt
    data.meta.case_dir = caseDir

    try { fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8'); writtenArtifacts.push(jsonPath) } catch (e) { log(`${tag} json write failed: ${e.message}`) }
    try { fs.writeFileSync(mdPath, renderCostiganMd(data), 'utf8'); writtenArtifacts.push(mdPath) } catch (e) { log(`${tag} md write failed: ${e.message}`) }

    // Hide all written artifacts on Windows (no-op on macOS).
    try { for (const p of writtenArtifacts) ctx.platform?.hideInternal?.(p) } catch {}

    finish(data.parse_error ? 'failed' : 'success', normalizeApiUsage({ model: MODEL, rawUsage: result.rawUsage, durationMs: result.durationMs }), data.parse_error ? 'JSON parse failed after retry' : null)
    log(`${tag} done: ${data.summary?.overall_status || (data.parse_error ? 'parse_error' : '?')} -> ${jsonPath}`)
  } catch (e) {
    log(`${tag} unexpected error: ${e.message}`)
    finish('failed', null, e.message)
  }
}

module.exports = { runCostiganChecklist, isCostiganDoctor, loadProcedurePacks, extractChecklistJson }

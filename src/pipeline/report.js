'use strict'

const fs   = require('fs')
const path = require('path')

// The shared "Clinical Cockpit" template (CDI + E/M + patient-summary in one
// single-scroll, print-optimised page). It carries a `<script id="pa-data"
// type="application/json">__PA_DATA_JSON__</script>` injection seam; the app
// replaces the placeholder with the case's verbatim engine JSON. The render
// layer in the template reads ONLY from that blob — case-agnostic.
const TEMPLATE_REL = path.join('templates', 'engine-report', 'cockpit.html')
const PLACEHOLDER  = '__PA_DATA_JSON__'

// ---- pure helpers (unit-testable without Electron / a DB) -------------------

/**
 * Resolve the file stem the engines anchor their output on. Prefer the
 * *_soap_note.md name (which is NOT always the patient/folder name — e.g. folder
 * `jessica_2026-06-19` but stem `2026-06-19`); fall back to the case-dir
 * basename. Mirrors the synthesize*FromDisk helpers in the engine descriptors.
 *
 * @param {string} caseDir
 * @returns {string}
 */
function resolveFileStem(caseDir) {
  let stem = path.basename(caseDir)
  try {
    const soap = fs.readdirSync(caseDir).find(f => f.endsWith('_soap_note.md'))
    if (soap) stem = soap.replace(/_soap_note\.md$/, '')
  } catch {}
  return stem
}

function readJsonIfPresent(file, log) {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (log) log(`[report] failed to parse ${path.basename(file)}: ${e.message}`)
    return null
  }
}

/**
 * Assemble PA_DATA = { meta, cdi, em, patient_summary } from whatever engine
 * JSONs exist in the case folder. The combined cockpit renders whichever
 * engines ran; absent engines fall to `{}` and their sections render empty.
 *
 * @returns {{ paData: object|null, present: string[], stem: string }}
 *   paData is null when NO engine JSON exists (nothing to render).
 */
function assemblePaData(caseDir, log) {
  const stem = resolveFileStem(caseDir)
  const cdi = readJsonIfPresent(path.join(caseDir, `${stem}_cdi.json`), log)
  const em  = readJsonIfPresent(path.join(caseDir, `${stem}_em.json`), log)
  const ps  = readJsonIfPresent(path.join(caseDir, `${stem}_patient_summary.json`), log)

  const present = []
  if (cdi) present.push('cdi')
  if (em)  present.push('em')
  if (ps)  present.push('patient_summary')
  if (present.length === 0) return { paData: null, present, stem }

  // meta: prefer the richest source (CDI carries specialty + mode + standards
  // versions); the template's render layer also reads per-engine *.meta so a
  // thinner top-level meta still renders correctly.
  const meta = (cdi && cdi.meta) || (em && em.meta) || (ps && ps.meta) || {}
  const paData = { meta, cdi: cdi || {}, em: em || {}, patient_summary: ps || {} }
  return { paData, present, stem }
}

/**
 * Build the final HTML by injecting PA_DATA into the template's #pa-data seam.
 *
 * The JSON is injected into a `<script type="application/json">` block, which is
 * a raw-text element — only a literal `</script>` can terminate it. Escaping `<`
 * and `>` to their `\uXXXX` JSON forms makes that impossible no matter what note
 * text the engines emitted; JSON.parse decodes them back transparently. Also
 * escape the U+2028/U+2029 line separators (valid in JSON strings, illegal in JS
 * source — harmless here but cheap insurance).
 *
 * @param {string} templateStr
 * @param {object} paData
 * @returns {string}
 */
function buildReportHtml(templateStr, paData) {
  const json = JSON.stringify(paData)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  // Use a function replacement so `$`-sequences in the JSON aren't treated as
  // replacement patterns by String.replace.
  return templateStr.replace(PLACEHOLDER, () => json)
}

// ---- the post-step ----------------------------------------------------------

/**
 * Render the combined "Clinical Cockpit" report for one case from its engine
 * JSONs: write `<stem>_report.html`, then print it to `<stem>_report.pdf` via an
 * offscreen Chromium window. A fixed post-step the chain calls after the engines
 * (like docx), NOT an engine itself — best-effort, never throws, never fails the
 * case. SOAP completion is the primary deliverable.
 *
 * @param {AppContext}  ctx
 * @param {CaseContext} caseCtx  Needs caseDir, caseId, caseTag, patientFolderName.
 * @returns {Promise<{htmlPath:string, pdfPath:string|null, present:string[]}|null>}
 */
async function renderCaseReport(ctx, caseCtx) {
  const { caseDir, caseId, caseTag, patientFolderName } = caseCtx
  const log = ctx.log
  const tag = caseTag ? `[${caseTag}] ` : ''
  if (!caseDir) return null

  const { paData, present, stem } = assemblePaData(caseDir, log)
  if (!paData) {
    log(`${tag}[report] no engine JSON in ${path.basename(caseDir)} — skipping report`)
    return null
  }

  const appRoot      = path.join(__dirname, '..', '..')
  const templatePath = path.join(appRoot, TEMPLATE_REL)
  let templateStr
  try {
    templateStr = fs.readFileSync(templatePath, 'utf8')
  } catch (e) {
    log(`${tag}[report] template read failed (${templatePath}): ${e.message}`)
    return null
  }

  const html     = buildReportHtml(templateStr, paData)
  const htmlPath  = path.join(caseDir, `${stem}_report.html`)
  const pdfPath   = path.join(caseDir, `${stem}_report.pdf`)

  const wallStart = Date.now()
  let eventId = null
  try {
    const { dbEvents } = requireDb()
    if (ctx.db) eventId = dbEvents.startEvent({ caseId, jobKind: 'report', startedAt: new Date().toISOString() })
  } catch (e) { log(`${tag}[report] startEvent failed: ${e.message}`) }

  // Always write the HTML first — it's a self-contained, shareable artifact even
  // if the PDF render later fails.
  try {
    fs.writeFileSync(htmlPath, html, 'utf8')
    log(`${tag}[report] wrote ${path.basename(htmlPath)} (engines: ${present.join(', ')})`)
  } catch (e) {
    log(`${tag}[report] HTML write failed: ${e.message}`)
    finishEventSafe(eventId, 'failed', Date.now() - wallStart, e.message)
    return null
  }

  // Render the PDF via an offscreen Chromium window (best-effort).
  let pdfOk = false
  try {
    await printHtmlToPdf(htmlPath, pdfPath, log, tag)
    pdfOk = fs.existsSync(pdfPath)
  } catch (e) {
    log(`${tag}[report] printToPDF failed: ${e.message}`)
  }

  try {
    const { dbCases } = requireDb()
    dbCases.updateCasePaths(caseId, {
      report_html_path: htmlPath,
      report_pdf_path:  pdfOk ? pdfPath : null,
    })
  } catch (e) { log(`${tag}[report] DB path update failed: ${e.message}`) }

  finishEventSafe(eventId, pdfOk ? 'success' : 'failed', Date.now() - wallStart, pdfOk ? null : 'pdf render failed')

  // Status UI: surface an "Open Report" button (prefer PDF, fall back to HTML).
  const reportUi = { reportPdfPath: pdfOk ? pdfPath : null, reportHtmlPath: htmlPath }
  try {
    if (patientFolderName && ctx.stores.recordings.setPatientReport) {
      ctx.stores.recordings.setPatientReport(caseTag, patientFolderName, reportUi)
    } else if (caseTag && ctx.stores.recordings.setReport) {
      ctx.stores.recordings.setReport(caseTag, reportUi)
    }
  } catch (e) { log(`${tag}[report] status update failed: ${e.message}`) }

  return { htmlPath, pdfPath: pdfOk ? pdfPath : null, present }

  function finishEventSafe(evId, status, durMs, errMsg) {
    try {
      if (evId == null) return
      const { dbEvents } = requireDb()
      dbEvents.finishEvent(evId, { status, durationMs: durMs, errorMessage: errMsg, finishedAt: new Date().toISOString() })
    } catch (_) {}
  }
}

/**
 * Print a local HTML file to PDF via an offscreen BrowserWindow (Chromium,
 * zero new deps). One window per render, destroyed in `finally` — the chain runs
 * cases sequentially, so only one offscreen render is alive at a time.
 *
 * `preferCSSPageSize` honors the template's `@page { size:Letter; margin:... }`
 * rules; `printBackground` preserves the navy header + severity colours.
 */
async function printHtmlToPdf(htmlPath, pdfPath, log, tag) {
  const { BrowserWindow } = require('electron')
  const win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 1400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await win.loadFile(htmlPath)
    const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
    fs.writeFileSync(pdfPath, data)
    log(`${tag}[report] wrote ${path.basename(pdfPath)}`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

let _db = null
function requireDb() {
  if (!_db) _db = {
    dbEvents: require('../../db/events'),
    dbCases:  require('../../db/cases'),
  }
  return _db
}

module.exports = { renderCaseReport, assemblePaData, buildReportHtml, resolveFileStem }

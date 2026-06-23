'use strict'

const fs   = require('fs')
const path = require('path')
const os   = require('os')

const TEMPLATE_PATH = path.join(__dirname, '../render/templates/cockpit.html')

/**
 * Render a combined `<stem>_review.pdf` for a case from all available engine
 * outputs (CDI, E/M score, patient summary).
 *
 * Best-effort: any failure is caught and logged; the chain always continues.
 *
 * @param {object}     caseCtx   Must include: caseId, caseTag, caseDir,
 *                               patientFolderName, doctor.
 * @param {object}     results   { cdi, emScore, patientSummary } — the
 *                               interpret() objects returned by runEngine().
 *                               Any may be null (engine skipped/failed).
 * @param {AppContext} ctx
 * @returns {Promise<string|null>}  Abs path of the written PDF, or null.
 */
async function renderReviewPdf(caseCtx, results, ctx) {
  const { caseId, caseTag, caseDir, patientFolderName } = caseCtx
  const tag = caseTag ? `[${caseTag}] ` : ''
  const log = ctx.log || console.log

  let tmpPath = null

  try {
    // ---- read engine JSON files from disk ----
    const cdiData = readEngineJson(results?.cdi?.manifest?.json_path,            'cdi', log, tag)
    const emData  = readEngineJson(results?.emScore?.manifest?.json_path,         'em',  log, tag)
    const psData  = readEngineJson(results?.patientSummary?.manifest?.json_path,  'ps',  log, tag)

    // Skip if there is nothing to render.
    if (!cdiData && !emData && !psData) {
      log(`${tag}[pdf] all engines skipped or failed — no review PDF generated`)
      return null
    }

    // ---- build PA_DATA contract ----
    const stem     = path.basename(caseDir)
    const doctor   = caseCtx.doctor || {}
    const settings = ctx.config ? ctx.config.get() : {}

    const paData = {
      meta: {
        patient:         stem.replace(/_\d{4}-\d{2}-\d{2}$/, '').replace(/_/g, ' '),
        case_dir:        caseDir,
        doctor:          [doctor.firstName, doctor.lastName].filter(Boolean).join(' ') || null,
        specialty:       doctor.specialty || null,
        date_of_service: stem.match(/\d{4}-\d{2}-\d{2}$/)?.[0] || null,
        mode:            settings.cdiMode || null,
        generated_at:    new Date().toISOString(),
      },
      cdi:             cdiData  || {},
      em:              emData   || {},
      patient_summary: psData   || {},
    }

    // ---- inject JSON into the cockpit template ----
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8')
    const injected = template.replace('__PA_DATA__', JSON.stringify(paData))

    // ---- write to temp file (avoids data-URI size limits) ----
    tmpPath = path.join(os.tmpdir(), `cockpit_review_${Date.now()}.html`)
    fs.writeFileSync(tmpPath, injected, 'utf8')

    // ---- open offscreen BrowserWindow and print to PDF ----
    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox:          true,
        nodeIntegration:  false,
        contextIsolation: true,
      },
    })

    let pdfPath = null
    try {
      await win.loadFile(tmpPath)
      const pdfBuffer = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
      })

      pdfPath = path.join(caseDir, `${stem}_review.pdf`)
      fs.writeFileSync(pdfPath, pdfBuffer)
      log(`${tag}[pdf] review PDF written: ${pdfPath}`)

      // ---- persist to DB ----
      persistPdfPaths(caseId, pdfPath, results, ctx, log, tag)

      // ---- notify renderer (status panel CDI button) ----
      if (patientFolderName && typeof ctx.stores.recordings.setPatientCdi === 'function') {
        ctx.stores.recordings.setPatientCdi(caseTag, patientFolderName, { cdiPdfPath: pdfPath })
      } else if (caseTag && typeof ctx.stores.recordings.setCdi === 'function') {
        ctx.stores.recordings.setCdi(caseTag, { cdiPdfPath: pdfPath })
      }
    } finally {
      win.destroy()
    }

    return pdfPath

  } catch (err) {
    log(`${tag}[pdf] review PDF render failed: ${err.message}`)
    return null
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath) } catch {} }
  }
}

/** Read an engine JSON file; return parsed object or null on any failure. */
function readEngineJson(jsonPath, label, log, tag) {
  if (!jsonPath) return null
  try {
    if (!fs.existsSync(jsonPath)) return null
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  } catch (e) {
    log(`${tag}[pdf] could not read ${label} JSON at ${jsonPath}: ${e.message}`)
    return null
  }
}

/** Write cdi_pdf_path and engine_outputs pdf_path. Best-effort. */
function persistPdfPaths(caseId, pdfPath, results, ctx, log, tag) {
  if (!caseId) return
  try {
    const { dbCases, dbEngineOutputs } = requireDb()
    // cdi_pdf_path is the canonical "open review" path surfaced to the user.
    dbCases.updateCaseCdi(caseId, { cdi_pdf_path: pdfPath })
    // engine_outputs rows may not exist when an engine was skipped.
    if (results?.emScore?.manifest?.json_path) {
      dbEngineOutputs.updateOutputPdf(caseId, 'em-score', pdfPath)
    }
    if (results?.patientSummary?.manifest?.json_path) {
      dbEngineOutputs.updateOutputPdf(caseId, 'patient-summary', pdfPath)
    }
  } catch (e) {
    log(`${tag}[pdf] DB persist failed: ${e.message}`)
  }
}

let _db = null
function requireDb() {
  if (!_db) {
    _db = {
      dbCases:         require('../../db/cases'),
      dbEngineOutputs: require('../../db/engine_outputs'),
    }
  }
  return _db
}

module.exports = { renderReviewPdf }

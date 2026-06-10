'use strict'

const fs   = require('fs')
const path = require('path')
const os   = require('os')

const { buildPrompt }            = require('../llm/skill-io/prompts')
const { parseSkillManifest }     = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED }    = require('../llm/skill-io/markers')
const { synthesizeManifestFromDisk } = require('../engines/cdi')
const { convertMdToDocx }        = require('../pipeline/docx')

/**
 * Run the cdi-review skill on a SOAP note supplied directly by the user
 * (paste, .md, or .docx). Fully ephemeral — nothing is written to the DB or
 * to <NOTES_DIR>/Cases/. The temp folder lives only until save/discard.
 *
 * @param {object} input
 * @param {string}  input.pastedText   Raw SOAP note text (or empty string).
 * @param {string}  input.filePath     Absolute path to the user's .md or .docx file (or empty).
 * @param {string}  input.doctorId     Doctor id (resolved to specialty/name by the caller).
 * @param {string}  input.doctorName   Full doctor name.
 * @param {string}  input.specialty    Doctor specialty (lowercased).
 * @param {string}  input.mode         'balanced'|'compliance'|'aggressive'.
 * @param {string}  input.standardsDir Absolute path to the standards directory.
 * @param {string}  input.notesDir     Absolute path to <NOTES_DIR> (for standards validation).
 * @param {string}  input.ts           Timestamp string for temp-folder naming.
 * @param {object} ctx                 AppContext — needs ctx.llm, ctx.stores.jobs, ctx.config,
 *                                     ctx.log, ctx.renderer, ctx.python, ctx.paths.
 * @returns {Promise<void>}  Fire-and-forget. Progress broadcast via template-job-status.
 */
async function runManualCdiJob(input, ctx) {
  const { log } = ctx
  const { pastedText, filePath, doctorName, specialty, mode, standardsDir, ts } = input
  const skillId = input.skillId || 'cdi-review'

  // Acquire single-flight lock synchronously before any await so there's no race.
  const ac = new AbortController()
  ctx.stores.jobs.start('cdi', { kill: () => ac.abort() }, null)

  const startedAt = Date.now()
  const jobBase = { type: 'cdi', doctorName }

  // Persist + broadcast. Persisting to jobState (.template_job.json) is what keeps
  // the shared banner alive: the renderer's 3s poller + tab-re-entry both call
  // getTemplateJobStatus() (which reads jobState). Without this the live push
  // events would be overwritten by a stale read within 3s, hiding the banner.
  function broadcast(payload) {
    ctx.jobState.save(payload)
    ctx.renderer.send('template-job-status', payload)
    ctx.sendStatus('template-job-status', payload)
  }

  broadcast({ ...jobBase, status: 'running', startedAt })

  const tempDir = path.join(os.tmpdir(), `cdi_manual_${process.pid}_${ts}`)
  let tempDirCreated = false

  try {
    // ---- 1. Create temp folder ------------------------------------------------
    fs.mkdirSync(tempDir, { recursive: true })
    tempDirCreated = true
    log(`[cdi-manual] temp dir: ${tempDir}`)

    // ---- 2. Normalize SOAP note → <stem>_soap_note.md -------------------------
    const stem = 'cdi'
    const soapMdPath = path.join(tempDir, `${stem}_soap_note.md`)

    if (filePath && filePath.toLowerCase().endsWith('.docx')) {
      // .docx → md via python/docx_to_md.py
      const python = ctx.python || 'python3'
      const appRoot = path.join(__dirname, '..', '..')
      const docxToMd = path.join(appRoot, 'python', 'docx_to_md.py')
      if (!fs.existsSync(docxToMd)) {
        throw new Error('docx conversion not yet available')
      }
      const { spawn } = require('child_process')
      await new Promise((resolve, reject) => {
        const proc = spawn(python, [docxToMd, filePath, soapMdPath], { stdio: 'pipe' })
        proc.stdout.on('data', d => log(`[cdi-manual][docx2md] ${d.toString().trim()}`))
        proc.stderr.on('data', d => log(`[cdi-manual][docx2md ERR] ${d.toString().trim()}`))
        proc.on('close', code => {
          if (code === 0) resolve()
          else reject(new Error(`docx_to_md.py exited ${code}`))
        })
        proc.on('error', err => reject(new Error(`Failed to spawn docx_to_md: ${err.message}`)))
      })
    } else if (filePath && filePath.toLowerCase().endsWith('.md')) {
      fs.copyFileSync(filePath, soapMdPath)
    } else if (pastedText && pastedText.trim()) {
      fs.writeFileSync(soapMdPath, pastedText, 'utf8')
    } else {
      throw new Error('No SOAP note provided.')
    }

    // ---- 3. Validate specialty standards file (belt-and-suspenders) -----------
    const specialtyFile = path.join(standardsDir, 'specialties', `${specialty}.md`)
    if (!fs.existsSync(specialtyFile)) {
      throw new Error(`No standards file for specialty '${specialty}'.`)
    }

    // ---- 4. Build prompt + run skill ------------------------------------------
    const cfg = ctx.config.get()
    const model = cfg.soapModel || 'claude-sonnet-4-6'
    // Each CDI skill has its own prompt signature; buildPrompt dispatches on
    // skillId (e.g. cdi-review uses specialty/mode/doctor; cdi-costigen ignores
    // them and uses Case + Standards only). Unknown skillId → buildPrompt throws,
    // caught below and surfaced as a failed run.
    const prompt = buildPrompt(skillId, {
      caseDir: tempDir,
      specialty,
      mode,
      doctor: doctorName,
      standardsDir,
    })

    log(`[cdi-manual] running ${skillId} skill (model=${model}, mode=${mode})`)
    const runResult = await ctx.llm.runSkill({
      prompt,
      model,
      effort: 'high',
      label: 'cdi-manual',
      signal: ac.signal,
    })

    // ---- 5. Rate-limit check ---------------------------------------------------
    const combined = (runResult.text || '') + '\n' + (runResult.errText || '')
    if (CLAUDE_RATE_LIMITED.test(combined)) {
      throw new Error('Claude usage limit reached. Try again once the limit resets.')
    }

    if (runResult.code !== 0) {
      throw new Error(`CDI skill exited ${runResult.code}`)
    }

    // ---- 6. Parse manifest + fallback -----------------------------------------
    let manifest = parseSkillManifest(runResult.text)
    // Don't pin to a specific skill name — any CDI skill's manifest is accepted
    // (cdi-review emits skill:'cdi-review', cdi-costigen emits 'cdi-costigan').
    const manifestValid = manifest && manifest.schema_version === 1 && manifest.status

    if (!manifestValid || manifest.status !== 'ok') {
      // Filesystem fallback (rate-limited or manifest truncated)
      manifest = synthesizeManifestFromDisk(tempDir, log)
    }

    if (!manifest || !manifest.md_path) {
      throw new Error('CDI review did not produce a report.')
    }

    if (!fs.existsSync(manifest.md_path)) {
      throw new Error(`CDI report not found at: ${manifest.md_path}`)
    }

    // ---- 7. Convert _cdi.md → .docx ------------------------------------------
    const python = ctx.python || 'python3'
    const docxPath = await convertMdToDocx(manifest.md_path, { python, log })

    if (!fs.existsSync(docxPath)) {
      throw new Error('DOCX conversion produced no output file.')
    }

    // ---- 8. Hold result for save/discard + broadcast success ------------------
    // The result slot is owned by the IPC registrar; we write to it via a
    // callback injected by the caller.
    if (typeof ctx.setCdiResult === 'function') {
      ctx.setCdiResult({
        tempDir,
        docxPath,
        suggestedName: `CDI_Review_${doctorName.split(' ').pop()}_${new Date().toISOString().slice(0, 10)}.docx`,
      })
    }

    broadcast({ ...jobBase, status: 'success', finishedAt: Date.now() })
    log(`[cdi-manual] done — ${docxPath}`)

  } catch (err) {
    log(`[cdi-manual ERR] ${err.message}`)
    // Clean up temp dir on any failure.
    if (tempDirCreated) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
    broadcast({ ...jobBase, status: 'failed', error: err.message, finishedAt: Date.now() })
  } finally {
    ctx.stores.jobs.clear()
  }
}

module.exports = { runManualCdiJob }

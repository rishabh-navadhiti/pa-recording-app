'use strict'

const fs   = require('fs')
const os   = require('os')
const path = require('path')

// Ported from python/extract_attachments.py (decision A7).
//
// The edit-note (Pre-chart) skill takes ONE attachment path, but the UI lets the
// scribe pick several files — so the app pre-combines them into a single .md
// here before invoking the skill. Per-file extraction mirrors the skill's Step 5
// so the model sees the same content shape it would if each file were passed
// individually. Output format (preserved from the Python version):
//
//   <file 1 contents, verbatim>
//
//   --- <basename of file 2> ---
//
//   <file 2 contents>
//   ...
//
// The first file gets no header (a single-file run looks identical to passing
// that file directly). mammoth (.docx) and pdf-parse (.pdf) are lazy-required so
// they don't load at startup and the .md/.txt path stays dependency-free.

async function extractMdOrTxt(filePath) {
  // utf8 decode replaces invalid byte sequences with U+FFFD — matches the
  // Python errors='replace'.
  return fs.promises.readFile(filePath, 'utf8')
}

async function extractDocx(filePath) {
  const mammoth = require('mammoth')
  const { value } = await mammoth.extractRawText({ path: filePath })
  return value
}

async function extractPdf(filePath) {
  // pdf-parse 2.x: a PDFParse class over pdfjs (no v1 debug-block footgun).
  const { PDFParse } = require('pdf-parse')
  const buf = await fs.promises.readFile(filePath)
  // Copy into a standalone Uint8Array — pdfjs may detach the backing buffer,
  // and Node Buffers share a pool, so don't hand it our pooled Buffer.
  const parser = new PDFParse({ data: new Uint8Array(buf) })
  try {
    // Join per-page text rather than using result.text — the latter injects
    // "-- N of M --" page markers. pdfplumber (the Python original) joined pages
    // with "\n\n" and no markers; mirror that.
    const { pages } = await parser.getText()
    return pages.map(p => p.text).join('\n\n')
  } finally {
    await parser.destroy()
  }
}

/**
 * Extract one file's text. Unsupported extensions return the skip marker rather
 * than throwing (matches the Python contract). Caller wraps with separators.
 */
async function extractOne(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.md' || ext === '.txt') return extractMdOrTxt(filePath)
  if (ext === '.docx') return extractDocx(filePath)
  if (ext === '.pdf')  return extractPdf(filePath)
  return `> Skipped ${path.basename(filePath)} — unsupported format (${ext || 'no extension'})`
}

/**
 * Combine the given files into the single combined markdown string. Missing
 * files and per-file extraction errors become inline `> Failed to read …`
 * markers (processing continues) — only a write failure aborts (in
 * buildCombinedAttachment).
 *
 * @param {string[]} filePaths
 * @param {{ log?: Function }} [opts]
 * @returns {Promise<string>}
 */
async function combineAttachments(filePaths, { log } = {}) {
  const pieces = []
  for (let idx = 0; idx < filePaths.length; idx++) {
    const filePath = filePaths[idx]
    const name = path.basename(filePath)

    let text
    if (!fs.existsSync(filePath)) {
      if (log) log(`[prechart][extract] WARNING: input not found: ${filePath}`)
      text = `> Failed to read ${name}: file not found`
    } else {
      try {
        text = await extractOne(filePath)
      } catch (e) {
        if (log) log(`[prechart][extract] WARNING: extraction failed for ${filePath}: ${e.message}`)
        text = `> Failed to read ${name}: ${e.message}`
      }
    }

    if (idx === 0) pieces.push(text.trimEnd())
    else           pieces.push(`\n\n--- ${name} ---\n\n${text.trimEnd()}`)
  }
  return pieces.join('\n') + '\n'
}

/**
 * Combine the attachment files into a temp .md and return its path (or '' when
 * there are no files). Drop-in replacement for the old Python-spawning
 * buildCombinedAttachment in main.js.
 *
 * @param {string[]} filePaths
 * @param {{ log?: Function, tmpDir?: string }} [opts]
 * @returns {Promise<string>} temp .md path, or '' when filePaths is empty.
 */
async function buildCombinedAttachment(filePaths, { log, tmpDir } = {}) {
  if (!filePaths || filePaths.length === 0) return ''
  const dir = tmpDir || os.tmpdir()
  const tmp = path.join(dir, `prechart_${Date.now()}_${process.pid}.md`)
  const combined = await combineAttachments(filePaths, { log })
  await fs.promises.mkdir(path.dirname(tmp), { recursive: true })
  await fs.promises.writeFile(tmp, combined, 'utf8')
  if (log) log(`[prechart][extract] combined ${filePaths.length} file(s) → ${tmp}`)
  return tmp
}

module.exports = { extractOne, combineAttachments, buildCombinedAttachment }

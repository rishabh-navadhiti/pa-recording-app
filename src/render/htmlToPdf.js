'use strict'

/**
 * Render a self-contained HTML file to a PDF using Electron's Chromium
 * (`webContents.printToPDF`) — zero new dependencies. Main-process only; must be
 * called after `app.whenReady()`.
 *
 * An offscreen (show:false) BrowserWindow is created per render and destroyed in
 * `finally`, so windows never leak across many cases. The window is sandboxed
 * with no node integration — it only ever loads our own trusted, self-contained
 * report HTML (inline CSS/JS, no external requests).
 *
 * @param {string} htmlPath  absolute path to the source .html (already on disk)
 * @param {string} pdfPath   absolute path to write the .pdf to
 * @returns {Promise<string>} pdfPath on success
 */
async function htmlToPdf(htmlPath, pdfPath) {
  const fs = require('fs')
  const { BrowserWindow } = require('electron')
  let win
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    })
    await win.loadFile(htmlPath)
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { marginType: 'default' },
    })
    fs.writeFileSync(pdfPath, buf)
    return pdfPath
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

module.exports = { htmlToPdf }

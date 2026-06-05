'use strict'

const path = require('path')
const { screen, BrowserWindow } = require('electron')

// Floating status-window + SOAP-note-open IPC handlers, moved verbatim from
// main.js's registerIpcHandlers(). Handler bodies are byte-identical except
// `__dirname` (originally the repo root) is replaced by the `appRoot` value
// passed through deps -- necessary because these files live in src/ipc/, where
// the literal `__dirname` would point at the wrong directory.
function registerStatusIpc(ipcMain, appCtx, deps) {
  const { log, appRoot } = deps

  // ---- get-session-recordings ----
  ipcMain.handle('get-session-recordings', () => appCtx.stores.recordings.getAll())

  // ---- open-status-window ----
  ipcMain.handle('open-status-window', () => {
    if (appCtx.statusWin && !appCtx.statusWin.isDestroyed()) {
      appCtx.statusWin.focus()
      return
    }
    const mainBounds = appCtx.win.getBounds()
    const statusWidth = 300
    const statusHeight = 380
    const { workArea } = screen.getPrimaryDisplay()
    let sx = mainBounds.x - statusWidth - 8
    let sy = mainBounds.y
    sx = Math.max(workArea.x, Math.min(sx, workArea.x + workArea.width - statusWidth))
    sy = Math.max(workArea.y, Math.min(sy, workArea.y + workArea.height - statusHeight))
    const statusWin = new BrowserWindow({
      width: statusWidth,
      height: statusHeight,
      x: sx,
      y: sy,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(appRoot, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    appCtx.statusWin = statusWin
    appCtx.setStatusSend((ch, ...a) => {
      if (!statusWin.isDestroyed()) statusWin.webContents.send(ch, ...a)
    })
    statusWin.loadFile(path.join(appRoot, 'renderer', 'status.html'))
    statusWin.on('closed', () => {
      appCtx.statusWin = null
      appCtx.setStatusSend(null)
    })
  })

  // ---- close-status-window ----
  ipcMain.handle('close-status-window', () => {
    if (appCtx.statusWin && !appCtx.statusWin.isDestroyed()) appCtx.statusWin.close()
  })

  // ---- open-soap-note ----
  ipcMain.handle('open-soap-note', async (_, filePath) => {
    const { shell } = require('electron')
    // Confine to casesDir so the renderer cannot open arbitrary paths.
    const normalized = path.resolve(filePath)
    const casesDir = appCtx.paths.casesDir
    if (!casesDir || !normalized.startsWith(path.resolve(casesDir) + path.sep)) {
      log(`open-soap-note: path outside casesDir rejected: ${filePath}`)
      return ''
    }
    return shell.openPath(normalized)
  })
}

module.exports = { registerStatusIpc }
'use strict'

const path = require('path')

const STATUS_WIDTH  = 300
const STATUS_HEIGHT = 380

/**
 * Open (or focus) the floating status window.
 *
 * @param {BrowserWindow} mainWin  The main popup window (used for positioning).
 * @returns {{ statusWin: BrowserWindow, send(channel, ...args): void }}
 */
function openStatusWindow(mainWin) {
  const { BrowserWindow, screen, ipcMain } = require('electron')

  const mainBounds = mainWin.getBounds()
  const { workArea } = screen.getPrimaryDisplay()
  let sx = mainBounds.x - STATUS_WIDTH - 8
  let sy = mainBounds.y
  sx = Math.max(workArea.x, Math.min(sx, workArea.x + workArea.width  - STATUS_WIDTH))
  sy = Math.max(workArea.y, Math.min(sy, workArea.y + workArea.height - STATUS_HEIGHT))

  const statusWin = new BrowserWindow({
    width: STATUS_WIDTH,
    height: STATUS_HEIGHT,
    x: sx,
    y: sy,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  statusWin.loadFile(path.join(__dirname, '..', 'renderer', 'status.html'))

  return {
    statusWin,
    send(channel, ...args) {
      if (statusWin && !statusWin.isDestroyed()) statusWin.webContents.send(channel, ...args)
    }
  }
}

module.exports = { openStatusWindow }

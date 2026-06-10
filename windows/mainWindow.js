'use strict'

const path = require('path')

const WIDTH  = 280
const HEIGHT = 420

/**
 * Create the main popup BrowserWindow and return a renderer facade.
 *
 * @param {object} opts
 * @param {Function} opts.onClose  Called when the window actually closes (not minimized).
 * @param {Function} [opts.onCloseRequest]  Called on close event; should call e.preventDefault()
 *   + minimize when the app is not quitting.
 * @returns {{ win: BrowserWindow, send(channel, ...args): void }}
 */
function createMainWindow({ onClose, onCloseRequest } = {}) {
  const { BrowserWindow, ipcMain } = require('electron')

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  // Minimize to taskbar instead of closing; only tray → Quit / before-quit actually exits.
  win.on('close', e => {
    if (onCloseRequest) onCloseRequest(e, win)
  })

  if (onClose) win.on('closed', onClose)

  // hide-window is wired inline here (it needs the win reference and is lifecycle, not domain).
  ipcMain.handle('hide-window', () => {
    if (win && !win.isDestroyed()) win.minimize()
  })

  return {
    win,
    /** Guarded send — safe to call whether the window is open or minimized. */
    send(channel, ...args) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }
}

module.exports = { createMainWindow }

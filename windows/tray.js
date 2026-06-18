'use strict'

const path = require('path')

/**
 * Create the system tray icon and attach context menu + click handler.
 *
 * @param {object} opts
 * @param {Function} opts.onTogglePopup  Called when tray icon is left-clicked.
 * @param {boolean}  [opts.isStaging]    When true, adds a STAGING badge to the tooltip.
 * @returns {Tray}
 */
function createTray({ onTogglePopup, isStaging } = {}) {
  const { Tray, Menu, app } = require('electron')

  const tray = new Tray(path.join(__dirname, '..', 'assets', 'tray-icon.png'))
  const label = isStaging ? 'AI Medical Scribe (staging)' : 'AI Medical Scribe'
  tray.setToolTip(label)

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Quit', click: () => app.quit() }
  ])

  tray.on('right-click', () => tray.popUpContextMenu(contextMenu))
  tray.on('click', () => { if (onTogglePopup) onTogglePopup() })

  return tray
}

module.exports = { createTray }

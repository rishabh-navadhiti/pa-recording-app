// View router + ES-module entry point. Replaces the renderer.js monolith.
//
// Owns:
//   - the current app STATE (pushed by main via onStateChange),
//   - the active tab (record | prechart | templates),
//   - the settings-overlay open/closed flag.
//
// It mounts every view against the existing index.html skeleton, subscribes to
// the IPC push channels, and dispatches each to the right view.
//
// SETTINGS DROPPED-UPDATE FIX: the old renderer.js render() returned early when
// settings were open (`if (settingsOpen) return`), silently dropping state
// pushes that arrived while the overlay was up. Here applyState() ALWAYS feeds
// the new state into the record view (which sits behind the overlay), so when
// the overlay closes the view is already current. The state is never dropped.
//
// All show/hide goes through setVisible (the `.hidden` class) — including the
// tab system, which the original drove with a mix of `.hidden` + inline
// `.style.display`. `.hidden { display:none !important }` overrides the CSS
// default display, so toggling the class alone is observably identical.

import { ipc } from './ipc/client.js'
import { STATE } from './constants.js'
import { setVisible } from './components/visible.js'

import { createRecordView } from './views/recordView.js'
import { createSettingsView } from './views/settingsView.js'
import { createFolderSetup } from './views/folderSetup.js'
import { createTemplatesView } from './views/templatesView.js'
import { createPrechartView } from './views/prechartView.js'
import { createJobBanner } from './views/jobBanner.js'
import { createCostiganBanner } from './views/costiganBanner.js'

const root = document

// --- Views ---
const recordView   = createRecordView()
const settingsView = createSettingsView()
const folderSetup  = createFolderSetup()
const templatesView = createTemplatesView()
const prechartView = createPrechartView()
const jobBanner    = createJobBanner()
const costiganBanner = createCostiganBanner()

// --- Router state ---
let currentState = STATE.IDLE
let activeTab = 'record'
let settingsOpen = false

// --- Header / tab DOM refs ---
let btnWindowClose, btnSettings,
    tabRecord, tabTemplates, tabPrechart, tabBar, tabTitle, statusRow,
    btnTabRecord, btnTabTemplates, btnTabPrechart

// ---------------------------------------------------------------------------
// Tab system (renderer.js showTab 1107-1146)
// ---------------------------------------------------------------------------

function showTab(name) {
  activeTab = name
  const onRecord    = name === 'record'
  const onTemplates = name === 'templates'
  const onPrechart  = name === 'prechart'

  if (tabRecord)    setVisible(tabRecord, onRecord)
  if (tabTemplates) setVisible(tabTemplates, onTemplates)
  if (tabPrechart)  setVisible(tabPrechart, onPrechart)

  if (statusRow) setVisible(statusRow, onRecord)
  if (tabTitle) {
    setVisible(tabTitle, !onRecord)
    if (onTemplates) tabTitle.textContent = 'Templates'
    else if (onPrechart) tabTitle.textContent = 'Pre-chart'
  }

  if (btnTabRecord)    btnTabRecord.classList.toggle('tab-active', onRecord)
  if (btnTabTemplates) btnTabTemplates.classList.toggle('tab-active', onTemplates)
  if (btnTabPrechart)  btnTabPrechart.classList.toggle('tab-active', onPrechart)

  if (onTemplates) {
    templatesView.onEnter()
  } else if (onPrechart) {
    prechartView.refreshPrechartTab()
    jobBanner.refreshTemplateJobBanner()
  }
}

// ---------------------------------------------------------------------------
// Settings overlay (renderer.js showSettings/hideSettings 698-715)
// ---------------------------------------------------------------------------

function openSettings() {
  settingsOpen = true
  // Hide all tabs + tab bar; settings is a full overlay.
  if (tabRecord)    setVisible(tabRecord, false)
  if (tabTemplates) setVisible(tabTemplates, false)
  if (tabPrechart)  setVisible(tabPrechart, false)
  if (tabBar)       setVisible(tabBar, false)
  settingsView.open()
}

// Invoked after settingsView.close() has hidden the #settings-view panel.
// Restores tabs + tab bar and re-applies the latest record state (kept fresh
// while the overlay was open — see applyState).
function afterSettingsClosed() {
  settingsOpen = false
  if (tabBar) setVisible(tabBar, true)
  showTab(activeTab)
  recordView.update(currentState)
}

// ---------------------------------------------------------------------------
// State push from main (renderer.js render entry)
// ---------------------------------------------------------------------------

function applyState(state) {
  currentState = state
  // Always update the record view's model — even while the settings overlay is
  // open. The overlay sits on top; when it closes, closeSettings() re-renders
  // the record view from currentState, so nothing is dropped. (Updating the
  // hidden-behind view now keeps it consistent if the overlay closes via any
  // path.)
  recordView.update(state)
}

// ---------------------------------------------------------------------------
// App listener registration (renderer.js registerAppListeners 1084-1099)
// ---------------------------------------------------------------------------

function registerAppListeners() {
  ipc.onStateChange(applyState)
  ipc.onShowPatientForm(() => recordView.showPatientForm())
  ipc.onSetupWarning(msg => recordView.showSetupWarning(msg))
  ipc.onServiceWarning(w => recordView.showServiceWarning(w))
  ipc.onPickDoctor(doctors => recordView.showDoctorPicker(doctors))
  ipc.onAutoStartRecording(async () => {
    setTimeout(() => ipc.startRecording(), 500)
  })
  ipc.onRecordingStatusUpdate(recordings => {
    const btn = root.getElementById('btn-view-status')
    if (btn) btn.textContent = recordings.length > 0 ? `View Status (${recordings.length})` : 'View Status'
  })
  const btnViewStatus = root.getElementById('btn-view-status')
  if (btnViewStatus) btnViewStatus.addEventListener('click', () => ipc.openStatusWindow())
  ipc.onTemplateJobStatus(job => jobBanner.handleTemplateJobStatus(job))
  ipc.onCostiganReportReady(payload => costiganBanner.show(payload))
}

// ---------------------------------------------------------------------------
// Bootstrap (renderer.js init 1633-1658)
// ---------------------------------------------------------------------------

async function init() {
  // Header refs.
  btnWindowClose  = root.getElementById('btn-window-close')
  btnSettings     = root.getElementById('btn-settings')
  tabRecord       = root.getElementById('tab-record')
  tabTemplates    = root.getElementById('tab-templates')
  tabPrechart     = root.getElementById('tab-prechart')
  tabBar          = root.getElementById('tab-bar')
  tabTitle        = root.getElementById('tab-title')
  statusRow       = root.getElementById('status-row')
  btnTabRecord    = root.getElementById('btn-tab-record')
  btnTabTemplates = root.getElementById('btn-tab-templates')
  btnTabPrechart  = root.getElementById('btn-tab-prechart')

  // Mount views. The shared services each view needs come via ctx.
  recordView.mount(root, {
    onNoDoctors: openSettings,
  })
  settingsView.mount(root, {
    // settingsView's own close button hides the panel, then we restore tabs +
    // re-render the (kept-current) record view.
    onSettingsClose: afterSettingsClosed,
  })
  jobBanner.mount(root, {
    onTemplateUpdated: () => templatesView.renderList().then(() => recordView.clearDoctorWarning()),
  })
  costiganBanner.mount(root)
  templatesView.mount(root, {
    clearDoctorWarning: () => recordView.clearDoctorWarning(),
    refreshJobBanner: () => jobBanner.refreshTemplateJobBanner(),
  })
  prechartView.mount(root, {
    onJobStarted: () => jobBanner.refreshTemplateJobBanner(),
  })
  folderSetup.mount(root, {
    onNotesDirSelected: onNotesDirSelected,
  })

  // Header buttons.
  if (btnWindowClose) btnWindowClose.addEventListener('click', () => ipc.hideWindow())
  if (btnSettings)    btnSettings.addEventListener('click', openSettings)
  // The settings close button is wired inside settingsView.mount(); it calls
  // afterSettingsClosed (via the onSettingsClose ctx) to restore the tabs.

  // Tab buttons.
  if (btnTabRecord)    btnTabRecord.addEventListener('click', () => showTab('record'))
  if (btnTabTemplates) btnTabTemplates.addEventListener('click', () => showTab('templates'))
  if (btnTabPrechart)  btnTabPrechart.addEventListener('click', () => showTab('prechart'))

  // Initial render.
  const state = await ipc.getState()
  applyState(state)

  // Staging badge — visible only when the local install has a .staging-marker.
  // Marker is gitignored, so this is a no-op on production installs.
  try {
    const build = await ipc.getBuildInfo()
    if (build && build.isStaging) {
      const badge = root.getElementById('staging-badge')
      if (badge) setVisible(badge, true)
    }
  } catch { /* old main process without get-build-info — ignore */ }

  const cfg = await ipc.getConfigStatus()

  if (cfg.notesDirMissing) {
    folderSetup.show()
    return
  }

  await recordView.initConfigWarnings()
  registerAppListeners()
}

// Folder-setup completion (renderer.js handleNotesDirSelection 1068-1079).
async function onNotesDirSelected() {
  // folderSetup.hide() already restored main content + we re-apply the tab.
  showTab(activeTab)
  await recordView.initConfigWarnings()
  const state = await ipc.getState()
  applyState(state)
  registerAppListeners()
}

init().catch(console.error)

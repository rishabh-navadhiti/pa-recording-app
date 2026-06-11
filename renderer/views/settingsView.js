// Settings overlay — extracted verbatim from renderer.js lines 698-773
// (loadSettings/maskApiKey/syncIcdLock), 925-942 (loadDeviceList), and the
// settings event wiring at 944-1016.
//
// This view owns ONLY the #settings-view panel and its controls. The router
// owns the settingsOpen flag + tab visibility (the original showSettings/
// hideSettings also toggled the tabs + tab bar; that lives in the router now).
// open() shows the panel and loads current settings; close() hides it.
//
// All show/hide goes through setVisible (the `.hidden` class). The CDI mode row
// and api-key edit rows that the original toggled via `.classList` are kept on
// `.hidden` exactly as before.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

export function createSettingsView() {
  let settingsView, btnSettingsClose,
      chkAutoRecord, chkEnableIcd, chkEnableCdi, cdiModeRow, cdiModeSelect,
      chkEnableEmScore, chkEnablePatientSummary,
      deviceSelect, soapModelSelect, templateModelSelect,
      btnAdvancedToggle, advancedSettingsContent,
      notesDirPath, btnChangeNotesDir,
      apiKeyMasked, apiKeyDisplayRow, apiKeyEditRow, apiKeyInput,
      btnEditApiKey, btnSaveApiKey

  let onCloseCb = null

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function maskApiKey(key) {
    if (!key) return 'Not set'
    if (key.length <= 8) return '••••••••'
    return key.slice(0, 3) + '•••••' + key.slice(-4)
  }

  // Locks the ICD checkbox on (checked + disabled) while CDI is enabled, since
  // CDI requires ICD to run first. When CDI is off, the checkbox is editable
  // again (its checked state is left untouched).
  function syncIcdLock(cdiOn) {
    if (!chkEnableIcd) return
    if (cdiOn) {
      chkEnableIcd.checked = true
      chkEnableIcd.disabled = true
    } else {
      chkEnableIcd.disabled = false
    }
  }

  async function loadSettings() {
    const s = await ipc.getSettings()
    chkAutoRecord.checked = s.autoRecord || false
    // ICD toggle — locked on while CDI is enabled (CDI requires ICD).
    if (chkEnableIcd) chkEnableIcd.checked = !!s.enableIcd
    // CDI toggle + mode — mode row is only visible when CDI is on.
    if (chkEnableCdi) chkEnableCdi.checked = !!s.enableCdi
    if (cdiModeSelect) cdiModeSelect.value = s.cdiMode || 'balanced'
    if (cdiModeRow) setVisible(cdiModeRow, !!s.enableCdi)
    syncIcdLock(!!s.enableCdi)
    // E/M scoring + patient summary — independent toggles, no coupling.
    if (chkEnableEmScore) chkEnableEmScore.checked = !!s.enableEmScore
    if (chkEnablePatientSummary) chkEnablePatientSummary.checked = !!s.enablePatientSummary
    const dir = await ipc.getNotesDir()
    notesDirPath.textContent = dir
    notesDirPath.title = dir
    const key = await ipc.getElevenLabsKey()
    apiKeyMasked.textContent = maskApiKey(key)
    setVisible(apiKeyDisplayRow, true)
    setVisible(apiKeyEditRow, false)
  }

  async function loadDeviceList(selectedIndex) {
    deviceSelect.innerHTML = '<option value="">Loading...</option>'
    const result = await ipc.listAudioDevices()
    deviceSelect.innerHTML = ''

    if (result.devices.length === 0) {
      deviceSelect.innerHTML = '<option value="">No loopback devices found</option>'
      return
    }

    result.devices.forEach(dev => {
      const opt = document.createElement('option')
      opt.value = dev.index
      opt.textContent = dev.name + (dev.isDefault ? ' (default)' : '')
      if (selectedIndex != null && dev.index === selectedIndex) opt.selected = true
      deviceSelect.appendChild(opt)
    })
  }

  function open() {
    setVisible(settingsView, true)
    loadSettings()
  }

  function close() {
    setVisible(settingsView, false)
    if (onCloseCb) onCloseCb()
  }

  return {
    mount(root, ctx = {}) {
      onCloseCb = ctx.onSettingsClose || null

      settingsView          = root.querySelector('#settings-view')
      btnSettingsClose      = root.querySelector('#btn-settings-close')
      chkAutoRecord         = root.querySelector('#chk-auto-record')
      chkEnableIcd          = root.querySelector('#chk-enable-icd')
      chkEnableCdi          = root.querySelector('#chk-enable-cdi')
      cdiModeRow            = root.querySelector('#cdi-mode-row')
      cdiModeSelect         = root.querySelector('#cdi-mode-select')
      chkEnableEmScore      = root.querySelector('#chk-enable-em-score')
      chkEnablePatientSummary = root.querySelector('#chk-enable-patient-summary')
      deviceSelect          = root.querySelector('#device-select')
      soapModelSelect       = root.querySelector('#soap-model-select')
      templateModelSelect   = root.querySelector('#template-model-select')
      btnAdvancedToggle     = root.querySelector('#btn-advanced-toggle')
      advancedSettingsContent = root.querySelector('#advanced-settings-content')
      notesDirPath          = root.querySelector('#notes-dir-path')
      btnChangeNotesDir     = root.querySelector('#btn-change-notes-dir')
      apiKeyMasked          = root.querySelector('#api-key-masked')
      apiKeyDisplayRow      = root.querySelector('#api-key-display-row')
      apiKeyEditRow         = root.querySelector('#api-key-edit-row')
      apiKeyInput           = root.querySelector('#api-key-input')
      btnEditApiKey         = root.querySelector('#btn-edit-api-key')
      btnSaveApiKey         = root.querySelector('#btn-save-api-key')

      on(btnSettingsClose, 'click', close)

      on(chkAutoRecord, 'change', () => {
        ipc.saveSettings({ autoRecord: chkAutoRecord.checked })
      })

      if (chkEnableIcd) {
        on(chkEnableIcd, 'change', () => {
          ipc.saveSettings({ enableIcd: chkEnableIcd.checked })
        })
      }

      if (chkEnableCdi) {
        on(chkEnableCdi, 'change', () => {
          const on_ = chkEnableCdi.checked
          // CDI on ⟹ ICD on. Persist both so disk matches immediately.
          ipc.saveSettings(on_ ? { enableCdi: true, enableIcd: true } : { enableCdi: false })
          if (cdiModeRow) setVisible(cdiModeRow, on_)
          syncIcdLock(on_)
        })
      }

      if (cdiModeSelect) {
        on(cdiModeSelect, 'change', () => {
          ipc.saveSettings({ cdiMode: cdiModeSelect.value })
        })
      }

      if (chkEnableEmScore) {
        on(chkEnableEmScore, 'change', () => {
          ipc.saveSettings({ enableEmScore: chkEnableEmScore.checked })
        })
      }

      if (chkEnablePatientSummary) {
        on(chkEnablePatientSummary, 'change', () => {
          ipc.saveSettings({ enablePatientSummary: chkEnablePatientSummary.checked })
        })
      }

      on(btnAdvancedToggle, 'click', async () => {
        const isOpen = !advancedSettingsContent.classList.contains('hidden')
        if (isOpen) {
          setVisible(advancedSettingsContent, false)
          btnAdvancedToggle.classList.remove('open')
        } else {
          setVisible(advancedSettingsContent, true)
          btnAdvancedToggle.classList.add('open')
          const s = await ipc.getSettings()
          await loadDeviceList(s.selectedDeviceIndex)
          if (soapModelSelect)     soapModelSelect.value     = s.soapModel     || 'claude-sonnet-4-6'
          if (templateModelSelect) templateModelSelect.value = s.templateModel || 'claude-opus-4-8'
        }
      })

      on(soapModelSelect, 'change', () => {
        ipc.saveSettings({ soapModel: soapModelSelect.value })
      })

      on(templateModelSelect, 'change', () => {
        ipc.saveSettings({ templateModel: templateModelSelect.value })
      })

      on(deviceSelect, 'change', () => {
        const val = deviceSelect.value
        ipc.saveSettings({
          manualDeviceSelection: val !== '',
          selectedDeviceIndex: val !== '' ? parseInt(val, 10) : null
        })
      })

      on(btnEditApiKey, 'click', () => {
        apiKeyInput.value = ''
        setVisible(apiKeyDisplayRow, false)
        setVisible(apiKeyEditRow, true)
        apiKeyInput.focus()
      })

      on(btnSaveApiKey, 'click', async () => {
        const key = apiKeyInput.value.trim()
        if (!key) return
        btnSaveApiKey.disabled = true
        const res = await ipc.saveElevenLabsKey(key)
        btnSaveApiKey.disabled = false
        if (res.ok) {
          apiKeyMasked.textContent = maskApiKey(key)
          setVisible(apiKeyEditRow, false)
          setVisible(apiKeyDisplayRow, true)
        }
      })

      on(apiKeyInput, 'keydown', e => {
        if (e.key === 'Enter') btnSaveApiKey.click()
      })

      on(btnChangeNotesDir, 'click', async () => {
        const res = await ipc.changeNotesDir()
        if (res.ok) {
          notesDirPath.textContent = res.path
          notesDirPath.title = res.path
        }
      })
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    open,
    close,
    loadSettings,
  }
}

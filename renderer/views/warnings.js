// Setup / service / config warnings — extracted verbatim from renderer.js
// lines 615-692.
//
//  - Setup warning: BlackHole / ffmpeg / Claude not installed (push-driven).
//  - Service warning: ElevenLabs / Claude runtime errors (push-driven + dismiss).
//  - Config warnings: missing ElevenLabs key / no doctor (queried at startup).
//
// The config-warnings container historically toggled with inline
// `style.display`. To honour the "one visibility mechanism" rule we now drive
// it through setVisible (the `.hidden` class). Behaviour is identical: the
// container is shown when either child warning is visible, hidden otherwise.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

export function createWarnings() {
  let setupWarning, serviceWarning, serviceWarningTitle, serviceWarningMessage,
      btnServiceWarningDismiss, configWarnings, warnElevenLabs, elevenLabsInput,
      btnSaveElevenLabs, warnDoctor, doctorInput, btnSaveDoctor

  // Stored listeners so unmount can detach them.
  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function updateConfigWarningsVisibility() {
    const anyVisible = !warnElevenLabs.classList.contains('hidden') ||
                       !warnDoctor.classList.contains('hidden')
    setVisible(configWarnings, anyVisible)
  }

  function showSetupWarning(msg) {
    setupWarning.textContent = msg
    setVisible(setupWarning, true)
  }

  function showServiceWarning({ title, message }) {
    serviceWarningTitle.textContent = title
    serviceWarningMessage.textContent = message
    setVisible(serviceWarning, true)
  }

  // Hide the "Doctor not set up" warning once a doctor exists. Shared by the
  // doctor-add flows in other views (templates tab, doctor picker).
  function clearDoctorWarning() {
    setVisible(warnDoctor, false)
    updateConfigWarningsVisibility()
  }

  async function initConfigWarnings() {
    const cfg = await ipc.getConfigStatus()

    if (cfg.elevenLabsKeyMissing) {
      setVisible(warnElevenLabs, true)
    }

    if (cfg.elevenLabsKeyInvalid) {
      showServiceWarning({
        title: 'ElevenLabs API key invalid',
        message: 'Your API key was rejected. Update it in Settings to enable transcription.'
      })
    }

    if (cfg.noDoctors) {
      setVisible(warnDoctor, true)
    }

    updateConfigWarningsVisibility()
  }

  return {
    mount(root) {
      setupWarning            = root.querySelector('#setup-warning')
      serviceWarning          = root.querySelector('#service-warning')
      serviceWarningTitle     = root.querySelector('#service-warning-title')
      serviceWarningMessage   = root.querySelector('#service-warning-message')
      btnServiceWarningDismiss = root.querySelector('#btn-service-warning-dismiss')
      configWarnings          = root.querySelector('#config-warnings')
      warnElevenLabs          = root.querySelector('#warn-elevenlabs')
      elevenLabsInput         = root.querySelector('#elevenlabs-input')
      btnSaveElevenLabs       = root.querySelector('#btn-save-elevenlabs')
      warnDoctor              = root.querySelector('#warn-doctor')
      doctorInput             = root.querySelector('#doctor-input')
      btnSaveDoctor           = root.querySelector('#btn-save-doctor')

      on(btnServiceWarningDismiss, 'click', () => {
        setVisible(serviceWarning, false)
      })

      on(btnSaveElevenLabs, 'click', async () => {
        const key = elevenLabsInput.value.trim()
        if (!key) return
        btnSaveElevenLabs.disabled = true
        const res = await ipc.saveElevenLabsKey(key)
        if (res.ok) {
          setVisible(warnElevenLabs, false)
          updateConfigWarningsVisibility()
        }
        btnSaveElevenLabs.disabled = false
      })

      on(elevenLabsInput, 'keydown', e => {
        if (e.key === 'Enter') btnSaveElevenLabs.click()
      })

      on(btnSaveDoctor, 'click', async () => {
        const name = doctorInput.value.trim()
        if (!name) return
        btnSaveDoctor.disabled = true
        const res = await ipc.addDoctor(name)
        btnSaveDoctor.disabled = false
        if (res.ok) {
          doctorInput.value = ''
          setVisible(warnDoctor, false)
          updateConfigWarningsVisibility()
        }
      })

      on(doctorInput, 'keydown', e => {
        if (e.key === 'Enter') btnSaveDoctor.click()
      })
    },

    update() { /* state changes don't affect warnings */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    // Extra surface the router + other views call:
    initConfigWarnings,
    showSetupWarning,
    showServiceWarning,
    clearDoctorWarning,
    updateConfigWarningsVisibility,
  }
}

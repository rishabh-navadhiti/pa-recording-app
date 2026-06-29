// Costigan-report-ready banner. The Costigan procedure checklist runs detached
// from the pre-chart job (fired-and-not-awaited), so the report file only exists
// some seconds after the pre-chart success banner has come and gone. Main pushes
// a `costigan-report-ready` event when the .pdf/.html is on disk; this banner
// surfaces an "Open report" button. It's a global, persistent banner (it does NOT
// auto-dismiss) so the scribe can find and click it.
//
// Opening reuses the existing open-soap-note IPC (the report lives inside
// casesDir, which that handler confines to) — no new open channel needed.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

const OVERALL_LABEL = {
  audit_ready:   'audit-ready',
  needs_edits:   'needs edits',
  likely_denied: 'likely denied',
}

export function createCostiganBanner() {
  let banner, textEl, btnOpen, btnDismiss
  let reportPath = null

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function show(payload) {
    if (!banner || !payload || !payload.reportPath) return
    reportPath = payload.reportPath
    const status = OVERALL_LABEL[payload.overallStatus]
    textEl.innerHTML = `Costigan checklist ready for <strong>${escapeHtml(payload.patient || 'patient')}</strong>`
      + (status ? ` — <span class="costigan-verdict">${status}</span>` : '')
    setVisible(banner, true)
  }

  function hide() {
    if (banner) setVisible(banner, false)
    reportPath = null
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  return {
    mount(root) {
      banner     = root.querySelector('#costigan-report-banner')
      textEl     = root.querySelector('#costigan-report-text')
      btnOpen    = root.querySelector('#btn-costigan-report-open')
      btnDismiss = root.querySelector('#btn-costigan-report-dismiss')
      on(btnOpen, 'click', () => { if (reportPath) ipc.openSoapNote(reportPath) })
      on(btnDismiss, 'click', hide)
    },

    show,
    hide,

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },
  }
}

// Background-job banner + polling + changes panel + cancel — extracted verbatim
// from renderer.js lines 1486-1627. Shared across tabs (template create/update +
// pre-chart all push to the same banner via the onTemplateJobStatus channel).
//
// handleTemplateJobStatus(job) drives the banner DOM from a job object;
// startJobPolling/stopJobPolling keep elapsed-time fresh; the changes panel
// shows the update report; the cancel button confirms + cancels a running job.
//
// On a successful (non-prechart) template job the original refreshed the doctor
// list + cleared the "no doctor" warning. Those touch the Templates tab, so they
// arrive via the onTemplateUpdated callback (the router/templatesView wires it).
//
// All show/hide goes through setVisible. The banner's success/failed *styling*
// classes (banner-success / banner-failed) are toggled directly as before —
// they are not visibility, they're appearance.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'
import { confirmAction } from '../components/confirm.js'

export function createJobBanner() {
  let templateJobBanner, templateJobBannerText, btnTemplateJobCancel,
      btnTemplateViewChanges, templateChangesPanel, btnTemplateChangesClose,
      templateChangesText, templateListView

  let jobPollInterval = null
  let currentChangesReport = null
  let onTemplateUpdatedCb = null

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000))
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return m > 0 ? `${m} min ${s}s` : `${s}s`
  }

  function startJobPolling() {
    if (jobPollInterval) return
    jobPollInterval = setInterval(async () => {
      const job = await ipc.getTemplateJobStatus()
      // Keep the banner fresh so elapsed-time updates even if no push arrived
      handleTemplateJobStatus(job)
    }, 3000)
  }

  function stopJobPolling() {
    if (jobPollInterval) {
      clearInterval(jobPollInterval)
      jobPollInterval = null
    }
  }

  function handleTemplateJobStatus(job) {
    if (!templateJobBanner) return
    if (!job || job.status === 'idle') {
      setVisible(templateJobBanner, false)
      stopJobPolling()
      return
    }
    const isUpdate   = job.type === 'update'
    const isPrechart = job.type === 'prechart'
    const isCdi      = job.type === 'cdi'
    if (job.status === 'running') {
      setVisible(templateJobBanner, true)
      templateJobBanner.classList.remove('banner-failed', 'banner-success')
      const elapsed = formatElapsed(Date.now() - (job.startedAt || Date.now()))
      if (isPrechart) {
        templateJobBannerText.innerHTML = `Pre-charting <strong>${job.doctorName || 'patient'}</strong> — ${elapsed}`
      } else if (isCdi) {
        templateJobBannerText.innerHTML = `Running CDI review for <strong>${job.doctorName || 'doctor'}</strong> — ${elapsed}`
      } else {
        const verb = isUpdate ? 'Updating' : 'Creating'
        templateJobBannerText.innerHTML = `${verb} template for <strong>${job.doctorName || 'doctor'}</strong> — ${elapsed}`
      }
      if (btnTemplateJobCancel) setVisible(btnTemplateJobCancel, isCdi ? false : true)
      startJobPolling()
    } else if (job.status === 'success') {
      setVisible(templateJobBanner, true)
      templateJobBanner.classList.add('banner-success')
      templateJobBanner.classList.remove('banner-failed')
      if (isPrechart) {
        templateJobBannerText.innerHTML = `Pre-chart applied to <strong>${job.doctorName || 'patient'}</strong>'s note`
      } else if (isCdi) {
        templateJobBannerText.innerHTML = `CDI report ready for <strong>${job.doctorName || 'doctor'}</strong>`
      } else {
        const doneText = isUpdate ? 'Template updated for' : 'Template ready for'
        templateJobBannerText.innerHTML = `${doneText} <strong>${job.doctorName || 'doctor'}</strong>`
      }
      if (btnTemplateJobCancel) setVisible(btnTemplateJobCancel, false)
      stopJobPolling()
      if (!isPrechart && !isCdi) {
        // A doctor/template was created or updated — refresh the doctor list +
        // dismiss the "Doctor not set up" warning (router/templatesView wiring).
        if (onTemplateUpdatedCb) onTemplateUpdatedCb()

        // Show "View changes" button if a changes report is available
        if (job.changesReport) {
          currentChangesReport = job.changesReport
          if (btnTemplateViewChanges) setVisible(btnTemplateViewChanges, true)
        } else {
          if (btnTemplateViewChanges) setVisible(btnTemplateViewChanges, false)
        }
      }

      // Auto-dismiss for prechart; for CDI the tab shows Save/Discard so we keep banner
      // visible briefly but allow the tab to handle the final UX.
      if (isPrechart) {
        setTimeout(() => {
          if (templateJobBanner && templateJobBanner.classList.contains('banner-success')) {
            setVisible(templateJobBanner, false)
            ipc.dismissTemplateJob()
          }
        }, 6000)
      } else if (isCdi) {
        // Auto-dismiss after short delay; cdiView shows the Save/Discard buttons.
        setTimeout(() => {
          if (templateJobBanner && templateJobBanner.classList.contains('banner-success')) {
            setVisible(templateJobBanner, false)
          }
        }, 4000)
      } else if (!job.changesReport) {
        setTimeout(() => {
          if (templateJobBanner && templateJobBanner.classList.contains('banner-success')) {
            setVisible(templateJobBanner, false)
            ipc.dismissTemplateJob()
          }
        }, 6000)
      }
    } else if (job.status === 'failed') {
      setVisible(templateJobBanner, true)
      templateJobBanner.classList.add('banner-failed')
      templateJobBanner.classList.remove('banner-success')
      const failLabel = isPrechart ? 'Pre-chart failed'
                      : isCdi      ? 'CDI review failed'
                      : isUpdate   ? 'Template update failed'
                                   : 'Template creation failed'
      templateJobBannerText.innerHTML = `<strong>${failLabel}</strong> — ${job.error || 'unknown error'}`
      if (btnTemplateJobCancel) setVisible(btnTemplateJobCancel, isCdi ? false : true)
      stopJobPolling()
    }
  }

  async function refreshTemplateJobBanner() {
    if (!ipc.getTemplateJobStatus) return
    const job = await ipc.getTemplateJobStatus()
    handleTemplateJobStatus(job)
  }

  return {
    mount(root, ctx = {}) {
      onTemplateUpdatedCb = ctx.onTemplateUpdated || null

      templateJobBanner      = root.querySelector('#template-job-banner')
      templateJobBannerText  = root.querySelector('#template-job-banner-text')
      btnTemplateJobCancel   = root.querySelector('#btn-template-job-cancel')
      btnTemplateViewChanges = root.querySelector('#btn-template-view-changes')
      templateChangesPanel   = root.querySelector('#template-changes-panel')
      btnTemplateChangesClose = root.querySelector('#btn-template-changes-close')
      templateChangesText    = root.querySelector('#template-changes-text')
      templateListView       = root.querySelector('#template-list-view')

      if (btnTemplateViewChanges) {
        on(btnTemplateViewChanges, 'click', () => {
          if (!currentChangesReport) return
          if (templateChangesText) templateChangesText.textContent = currentChangesReport
          if (templateListView) setVisible(templateListView, false)
          if (templateChangesPanel) setVisible(templateChangesPanel, true)
        })
      }

      if (btnTemplateChangesClose) {
        on(btnTemplateChangesClose, 'click', () => {
          if (templateChangesPanel) setVisible(templateChangesPanel, false)
          if (templateListView) setVisible(templateListView, true)
        })
      }

      if (btnTemplateJobCancel) {
        on(btnTemplateJobCancel, 'click', async () => {
          const job = await ipc.getTemplateJobStatus()
          if (!job || job.status !== 'running') {
            await ipc.dismissTemplateJob()
            setVisible(templateJobBanner, false)
            return
          }
          const cancelMsg = job.type === 'prechart'
            ? 'Cancel pre-chart? Progress will be lost.'
            : job.type === 'update'
              ? 'Cancel template update? Progress will be lost.'
              : 'Cancel template creation? Progress will be lost.'
          if (!confirmAction(cancelMsg)) return
          btnTemplateJobCancel.disabled = true
          await ipc.cancelTemplateCreation()
          btnTemplateJobCancel.disabled = false
        })
      }
    },

    update() { /* state-independent */ },

    unmount() {
      stopJobPolling()
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    // Surface the router / push channel + templates/prechart views call:
    handleTemplateJobStatus,
    refreshTemplateJobBanner,
  }
}

import { setVisible } from './visible.js'

/**
 * Format a second count as MM:SS, or HH:MM:SS once it reaches an hour.
 * Pure — unit-testable without a DOM.
 */
export function formatTime(secs) {
  if (secs >= 3600) {
    const h = String(Math.floor(secs / 3600)).padStart(2, '0')
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0')
    const s = String(secs % 60).padStart(2, '0')
    return `${h}:${m}:${s}`
  }
  const m = String(Math.floor(secs / 60)).padStart(2, '0')
  const s = String(secs % 60).padStart(2, '0')
  return `${m}:${s}`
}

/**
 * Recording timer bound to a display element.
 * Behaviour-identical to the original startTimer/stopTimer/pauseTimer/resumeTimer:
 *  - start():  reset to 0, show, tick every 1s
 *  - stop():   clear interval, hide
 *  - pause():  clear interval, stay visible, keep elapsed
 *  - resume(): tick again from the kept elapsed value
 *
 * @param {HTMLElement} el  The #timer element.
 * @returns {{ start, stop, pause, resume, seconds }}
 */
export function createTimer(el) {
  let interval = null
  let seconds = 0

  function tick() {
    interval = setInterval(() => {
      seconds++
      if (el) el.textContent = formatTime(seconds)
    }, 1000)
  }

  return {
    start() {
      seconds = 0
      if (el) { el.textContent = '00:00'; setVisible(el, true) }
      if (interval) clearInterval(interval)
      tick()
    },
    stop() {
      if (interval) { clearInterval(interval); interval = null }
      if (el) setVisible(el, false)
    },
    pause() {
      if (interval) { clearInterval(interval); interval = null }
      // stay visible, keep elapsed seconds
    },
    resume() {
      if (interval) clearInterval(interval)
      tick()
    },
    get seconds() { return seconds },
  }
}

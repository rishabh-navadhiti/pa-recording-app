'use strict'

const { STATE } = require('../src/shared/state')

/**
 * Create the app state machine.
 *
 * @param {object} opts
 * @param {Function} opts.onChange  Called with the new state after every transition.
 * @returns {{ getState(): string, setState(s: string): void, setQuitting(): void, isQuitting(): boolean }}
 */
function createStateMachine({ onChange } = {}) {
  let current  = STATE.IDLE
  let quitting = false

  return {
    getState() { return current },

    setState(newState) {
      if (!Object.values(STATE).includes(newState)) {
        console.error(`[state] Unknown state: ${newState}`)
        return
      }
      current = newState
      if (onChange) onChange(newState)
    },

    setQuitting() { quitting = true },
    isQuitting()  { return quitting },
  }
}

module.exports = { createStateMachine }

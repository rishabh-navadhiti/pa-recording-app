'use strict'

const cp = require('child_process')

/**
 * Thin injectable wrapper over child_process.spawn.
 * Injecting a fake `spawnFn` lets tests drive the provider with canned
 * stdout/stderr without a real subprocess.
 *
 * @param {Function} [spawnFn]  Defaults to child_process.spawn.
 * @returns {{ run(cmd, args, opts): ChildProcess }}
 */
function createChildRunner(spawnFn) {
  const _spawn = spawnFn || cp.spawn
  return {
    run(cmd, args, opts) {
      return _spawn(cmd, args, opts)
    }
  }
}

/**
 * Return the platform-correct way to invoke the `claude` CLI.
 *
 * On Windows, `claude` is installed as `claude.cmd` (a batch file).
 * Node's spawn with shell:false cannot run .cmd files directly, but
 * `cmd.exe /c claude` resolves .cmd files from PATH with no shell involved
 * in argument processing — so injection via the prompt arg is impossible.
 *
 * On Linux/mac, `claude` is a regular binary/script that spawn handles
 * directly with shell:false.
 */
function resolveClaudeCommand() {
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', baseArgs: ['/c', 'claude'] }
  }
  return { cmd: 'claude', baseArgs: [] }
}

module.exports = { createChildRunner, resolveClaudeCommand }

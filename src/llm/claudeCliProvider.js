'use strict'

const { createChildRunner, resolveClaudeCommand } = require('./childRunner')
const { extractUsage, logSkillStream } = require('./usage')

/**
 * Claude CLI provider — implements LlmProvider using `claude -p` with
 * stream-json output format.
 *
 * Injection bug fix: uses an arg array instead of a shell command string.
 * On Windows: spawn('cmd.exe', ['/c', 'claude', '-p', prompt, ...flags], {shell:false})
 * On Linux/mac: spawn('claude', ['-p', prompt, ...flags], {shell:false})
 * In both cases the prompt is a separate argv element — never interpolated
 * into a shell string — so shell metacharacters in prompts are inert.
 *
 * @param {object} opts
 * @param {string}   opts.cwd          Working directory for the subprocess (notesDir).
 * @param {Function} opts.log          Logger function.
 * @param {object}   [opts.runner]     childRunner instance (injectable for tests).
 * @returns {LlmProvider}
 */
function createClaudeCliProvider({ cwd, log, runner }) {
  const _runner = runner || createChildRunner()
  const { cmd, baseArgs } = resolveClaudeCommand()

  return {
    /**
     * Run a skill prompt through `claude -p` and return the result.
     * Always resolves — spawn errors surface as {code: null, errText}.
     *
     * @param {RunSkillOpts} opts
     * @returns {Promise<RunSkillResult>}
     */
    runSkill({ prompt, model, effort, tag = '', label = 'claude', env }) {
      return new Promise(resolve => {
        const spawnEnv = {
          ...process.env,
          ...(effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {}),
          ...(env || {})
        }

        const args = [
          ...baseArgs,
          '-p', prompt,
          '--output-format', 'stream-json',
          '--verbose',
          '--dangerously-skip-permissions',
        ]
        if (model) args.push('--model', model)

        // Log the equivalent shell command for copy-paste debugging.
        const envPrefix = [
          effort ? `CLAUDE_CODE_EFFORT_LEVEL=${effort}` : null,
          ...(env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : [])
        ].filter(Boolean).join(' ')
        const displayCmd = `claude -p "${prompt}"${model ? ` --model ${model}` : ''} --output-format stream-json --verbose --dangerously-skip-permissions`
        log(`${tag}[${label}] $ ${envPrefix ? envPrefix + ' ' : ''}${displayCmd}`)

        const proc = _runner.run(cmd, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          env: spawnEnv,
        })

        let buf = ''
        let resultText = ''
        let resultEvent = null
        const errChunks = []

        function processLine(line) {
          if (!line.trim()) return
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'result') {
              resultEvent = ev
              resultText = ev.result || ''
              const u = ev.usage || {}
              const cost = ev.total_cost_usd != null ? `$${ev.total_cost_usd.toFixed(4)}` : 'n/a'
              log(`${tag}[${label}][usage] input=${u.input_tokens || 0} output=${u.output_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} cache_created=${u.cache_creation_input_tokens || 0} cost=${cost} turns=${ev.num_turns || '?'} time=${Math.round((ev.duration_ms || 0) / 1000)}s`)
            }
          } catch (_) {
            if (line.trim()) log(`${tag}[${label}] ${line.trim()}`)
          }
        }

        proc.stdout.on('data', chunk => {
          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) processLine(line)
        })

        proc.stderr.on('data', d => {
          const msg = d.toString()
          errChunks.push(msg)
          log(`${tag}[${label} ERR] ${msg.trim()}`)
        })

        proc.on('close', code => {
          if (buf.trim()) processLine(buf)
          log(`${tag}[${label}] claude exited ${code}`)
          logSkillStream(log, tag, label, resultEvent)
          resolve({ code, text: resultText, resultEvent, errText: errChunks.join('') })
        })

        proc.on('error', err => {
          log(`${tag}[${label} ERR] failed to spawn claude: ${err.message}`)
          resolve({ code: null, text: '', resultEvent: null, errText: err.message })
        })
      })
    }
  }
}

module.exports = { createClaudeCliProvider }

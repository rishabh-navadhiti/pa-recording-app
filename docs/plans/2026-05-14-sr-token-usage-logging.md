# Token usage logging for Claude background jobs

## Context

The app spawns `claude -p` for four background jobs: SOAP note generation, template create, template update, and pre-chart. Currently each spawn site independently manages its own stdout/stderr chunks and error detection. Token counts and cost are invisible.

The Claude CLI supports `--output-format stream-json`, which emits one JSON event per line. The final `result` event carries totals: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cost_usd`, `num_turns`, `duration_ms`.

---

## What to build

A single shared `spawnClaude()` wrapper in `main.js` that all Claude invocations go through. Token logging is baked in once — any future Claude feature gets it automatically with no extra work.

**Log format — one line per job:**
```
[<case>] [soap][usage] input=12800 output=1100 cache_read=9200 cache_created=0 cost=$0.0420 turns=3 time=18s
```

Same single-line pattern for `[template]`, `[template-update]`, `[prechart]`, and any future job. Per-turn breakdown intentionally omitted — a long job can span 20-30 turns and would flood the log.

---

## Implementation

### 1. `spawnClaude(opts)` — shared wrapper in `main.js`

Add before `spawnSoapGeneration`. All Claude invocations go through this one function.

```
spawnClaude({
  prompt,       // string — the -p argument
  model,        // string — --model value
  effort,       // string|null — CLAUDE_CODE_EFFORT_LEVEL env var, omit if not needed
  cwd,          // string — working directory (always NOTES_DIR)
  tag,          // string — log prefix e.g. '[MyCase] '
  label,        // string — job name e.g. 'soap', 'template', 'prechart'
  env,          // object|null — extra env vars merged with process.env
  onClose,      // function(code, resultEvent, errText) — called when the process exits
})
→ returns the spawned ChildProcess
```

Internally:
- Builds the command: `claude -p "..." --model X --output-format stream-json --dangerously-skip-permissions`
- Buffers stdout line-by-line; on the `result` JSON event logs the usage line and passes the event to `onClose`
- Non-JSON stdout lines logged as plain text (startup messages etc.)
- Stderr captured raw into `errChunks`; logged with `ERR` tag; full text passed to `onClose` for rate-limit detection
- On process error (`ENOENT`): logs and calls `onClose(null, null, '')` so the caller can surface the "Claude not installed" warning

### 2. Refactor the four spawn sites to use `spawnClaude()`

| Function | `label` | Notes |
|---|---|---|
| `spawnSoapGeneration` | `'soap'` | `onClose` checks rate-limit, checks file exists, calls `spawnDocxConversion` |
| `spawnTemplateCreation` | `'template'` | `onClose` checks rate-limit, registers doctor in settings.json |
| `spawnTemplateUpdate` | `'template-update'` | `onClose` checks rate-limit; extract `changesReport` from `resultEvent.result` |
| `spawnPrechartJob` | `'prechart'` | `onClose` checks rate-limit, calls `spawnDocxConversion` on updated note |

The `onClose` callbacks own all the existing post-job logic unchanged — `spawnClaude()` only handles process lifecycle + logging.

### 3. Rate-limit detection

Each `onClose(code, resultEvent, errText)` checks:
```javascript
const isRateLimited = /rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i
  .test((resultEvent?.result || '') + errText)
```
Same regex as today, just applied to the parsed result text + raw stderr instead of a raw stdout+stderr blob.

### 4. Future Claude features

Any new background job just calls `spawnClaude({ ..., label: 'my-new-job' })` and automatically gets:
- `--output-format stream-json` applied
- usage logged to `app.log`
- stderr captured and passed through
- rate-limit text available in `onClose`

No extra wiring needed.

---

## No doc updates needed

This change only touches `main.js` internals — no new IPC channels, no state machine changes, no settings fields. CLAUDE.md and ARCHITECTURE.md stay as-is.

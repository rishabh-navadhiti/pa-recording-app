# 02 — Target Architecture

> The modular structure we're refactoring toward. Grounded in the problems in [01-problems.md](01-problems.md) and the engine roadmap in [docs/pa-planning/05-engines.md](../pa-planning/05-engines.md). It reflects the decisions in [07-open-questions-and-decisions.md](07-open-questions-and-decisions.md): **vanilla JS + JSDoc now (TypeScript after packaging), bolder-but-safe larger-chunk extraction, a provider-agnostic LLM seam (the `claude` CLI is one swappable implementation), and packaging as a later phase.**
>
> This is a target, not a line-by-line spec. The implementer (you, later) decides local details. What's **load-bearing** — the seams that make engines drop in, the globals dying into an `AppContext`, the contract module, the provider abstraction — is called out as such.

---

## Design principles

1. **One responsibility per module; leaf modules over god-files.** Mirror what `db/` already does: small files, a single clear job, dependencies injected at the call site, no reach-back into the orchestrator.
2. **Kill the globals with an injected `AppContext`.** The ~18 mutable globals become a handful of small stores owned by one context object threaded through the app. Functions take `ctx`; they stop reaching for module-scope state. *This is the change that makes everything testable.*
3. **Make "add an engine" a local change.** A new review/generation engine = one descriptor + one registry line + one migration + one skill folder. The runner, provider, status, persistence, and chaining are shared infrastructure it plugs into.
4. **The LLM is a swappable provider behind one interface.** Today it's the `claude` CLI; tomorrow it may be the Agent SDK on an org API key or a different vendor entirely. Engines call `ctx.llm.runSkill(...)`; they never know which provider answers.
5. **Contracts are data in one place, not literals scattered across 19 sites.** Prompt builders, marker regexes, and manifest schemas live in `src/skills/contracts/` and are round-trip tested.
6. **Files on disk stay canonical; the DB stays an index.** Unchanged. The notes folder must survive a DB delete (it does today).
7. **Pure where possible; Electron/fs/child_process at the edges.** Push decision logic into pure functions (gates, prompt-building, manifest parsing, planning, status shaping) that an AI can unit-test in milliseconds; keep the unavoidable I/O in thin shells.
8. **Behavior-preserving by default.** Larger chunks are fine (AI does the work), but each landed change keeps the production pipeline byte-identical unless a fix is explicitly intended. Verify on a real case before promoting.

---

## Target source layout

```
src/
  main.js                      thin entry: single-instance guard → bootstrap(ctx)

  shared/                      ← imported by BOTH main and renderer (single source of truth)
    state.js                   STATE enum + legal transitions (kills the dual-declaration)
    ipc-channels.js            frozen CHANNELS map (kills 52 magic strings; typo → load-time undefined)
    pipeline-status.js         PIPELINE_STAGE enum + labels + css-class map (kills the 3-file drift)
    specialties.js             DOCTOR_SPECIALTIES (matches standards filenames + the CDI gate)
    ipc-contract.js            per-channel request/response + event payload shapes (JSDoc typedefs + validators)

  context/
    appContext.js              builds + holds the ctx: { paths, config, secrets, db, llm, stores, log, renderer, platform }
    stateMachine.js            currentState + setState behind onChange; no `win` coupling
    sessionStore.js            active doctor/session/dir (was 3 globals)
    recordingsStore.js         sessionRecordings + mutators + serialize() + onChange (was 1 global + 6 helpers + 2 projections)
    recorderController.js      the live record.py handle + stdin stop/pause/resume (was recordingProcess/tempMp3Path + Decision #1)

  config/
    paths.js                   Paths object from notesDir / userDataDir (was 4 mutable globals)
    settings.js                settings store + DEFAULT_SETTINGS (inject base dir; cache; one merge point)
    secrets.js                 API keys — file today, OS keychain (DPAPI/Keychain) when packaging
    jobState.js                generic background-job state file (was .template_job.json)
    mcp.js                     writes .mcp.json from notes-claude (no duplicate JS const)

  platform/
    index.js                   interface: isStaging(), resolvePython(), hideInternal(p), notify(), secretStore()
    windows.js  macos.js       implementations — macos.js gets real branches, not just no-ops

  llm/                         ← the provider-agnostic seam (LOAD-BEARING)
    provider.js                interface: runSkill({ skillId, input, model, effort, cwd, signal }) → { text, manifest?, usage, costUsd, durationMs, code }
    claudeCliProvider.js       current impl: arg-array spawn of `claude -p` (no shell:true) + stream-json parse
    childRunner.js             injectable spawn wrapper (testable against canned stdout/stderr)
    usage.js                   extractUsage / stream logging
    # future: agentSdkProvider.js, <vendor>Provider.js — engines unchanged when these arrive

  skills/                      ← the Node side of the skills + their contracts
    contracts/
      prompts.js               buildPrompt(skillId, input) → safe args (proper encoding, no shell escaping)
      markers.js               named regexes: rateLimited, mcpAuth, duration, errorLine, backupOk (single source)
      manifest.js              parseSkillManifest (moved here) + validateManifest(obj, schema)

  engines/                     ← THE CENTERPIECE (the PA roadmap drops in here)
    registry.js                ordered list of engine descriptors the chain iterates
    engineRunner.js            runEngine(engine, ctx): gates → buildInput → ctx.llm.runSkill → interpret → persist → reportStage
    soap.js  icd.js  cdi.js    the 3 current engines as descriptors (~50–80 lines each, mostly declarative)
    # future: workersComp.js, priorAuth.js, emScorer.js, soapValidator.js, orders.js, patientSummary.js, quality.js

  pipeline/
    ingest.js                  audio → case folder → DB row → spawn transcription (shared by record + upload; kills the dup)
    transcription.js           the transcribe step (pre-chain; fires before the engine registry; not engine "0")
    chain.js                   the per-case engine chain (single + multi); iterates registry; owns "which engine completes the case"
    multiPatient.js            planChildCases (pure) + materializeChild (io) — split from the 207-line monster
    artifacts.js               case file naming + copyArtifact + relForSkill (path-safety helper)
    caseStatus.js              markCaseFailed / markEvent — resilient DB-write wrappers (kills ~20 inline try/catch)

  jobs/
    jobRunner.js               single-flight lock (or queue) for template/prechart jobs (was 3 globals + scattered guards)
    templateCreate.js  templateUpdate.js  prechart.js   job descriptors (buildInput / parseResult / onSuccess)

  ipc/
    index.js                   thin registrar: register{Recording,Doctors,Templates,Prechart,Config,Status,AudioUpload,Lifecycle}Ipc(ctx)
    envelope.js                respondOk/respondErr + wrapHandler (try/catch → {ok,error}) + arg validation
    recording.js doctors.js templates.js prechart.js config.js status.js audioUpload.js lifecycle.js

  db/                          ← existing, hardened (see §DB)
    init.js (transactional migrations + injectable getDb) doctors.js sessions.js cases.js events.js cdi_flags.js
    withDb.js                  the try/catch+null-guard wrapper (kills ~25 copies)
    migrations/*.sql

  windows/
    mainWindow.js  statusWindow.js  tray.js   factories + geometry constants + guarded send

  startup/
    bootstrap.js               ordered steps extracted from app.whenReady
    bootstrapNotesDir.js       mkdir + sync .claude/MCP + hide + initDB + migrate/restore (shared with change-notes-dir)

  update/
    autoUpdate.js              git-pull today → electron-updater after packaging (see 04)

  log/
    logger.js                  levels + redact(PII) + rotation; processing_events stays the structured truth

renderer/
  index.html
  app.js                       bootstrap + viewRouter (replaces render()'s switch + showTab + show/hide functions)
  ipc/client.js                typed wrapper over window.api (one place for versioned feature flags)
  views/                       per-screen { mount(root, ctx), update(state), unmount() } modules
    recordView.js patientForm.js uploadForm.js prechartView.js settingsView.js
    doctorList.js templatesView.js createTemplateView.js updateTemplateView.js
    jobBanner.js folderSetup.js doctorPicker.js warnings.js statusPanel.js
  components/
    fileListField.js           the 4×-duplicated widget → 1
    timer.js                   pure timer object (unit-testable)
    button.js confirmDialog.js
  styles/                      styles.css may be split per-view (optional)

python/                        restructured into a package + thin CLI (see §Python); render_cdi.py extracted from the skill
notes-claude/                  unchanged source-of-truth for skills + standards (cleaned of repo-internal leakage)
tests/                         unit/ + integration/ + fixtures/ (see 05)
```

`main.js` shrinks from 3,530 lines to a few dozen: a single-instance guard and a `bootstrap(ctx)` call.

---

## The AppContext (how the globals die)

One object, built once at startup, threaded into everything (IPC handlers, engines, pipeline, jobs). It *is* the app's state, but encapsulated and injectable.

```js
// context/appContext.js  (shape, not final)
function createAppContext({ notesDir, userDataDir, platform, logger }) {
  const paths    = createPaths(notesDir, userDataDir)
  const config   = createSettingsStore(paths)
  const secrets  = createSecretStore(platform)
  const db       = initDb(paths.notesDir)               // injectable; :memory: in tests
  const llm      = createClaudeCliProvider({ cwd: paths.notesDir, log: logger })  // swap impl here
  const stores   = {
    state:      createStateMachine({ onChange: s => renderer.broadcast(CHANNELS.STATE_CHANGE, s) }),
    session:    createSessionStore(),
    recordings: createRecordingsStore({ onChange: serialized => renderer.broadcast(CHANNELS.RECORDING_STATUS, serialized) }),
    recorder:   createRecorderController({ platform, paths }),
    jobs:       createJobRunner({ paths, llm, db, log: logger }),
  }
  const renderer = createRendererBridge(/* windows */)  // guarded send(); no direct win.* anywhere else
  return { paths, config, secrets, db, llm, stores, renderer, platform, log: logger }
}
```

Rules:
- **No module-level mutable state outside a store.** If something needs to be remembered, it lives in a store with explicit methods + an `onChange`.
- **The two cross-handler promise resolvers** (`patientNameResolver`, `doctorPickerResolver`) move into the relevant controller/store as an explicit pending-request with a method to resolve it — no Promise stashed in a free variable.
- **`renderer.send()` is the only path to the windows** — one guarded implementation, so the unguarded-send crash class disappears.

This is a *larger* chunk than tiny PRs, which your decision endorses — but it's mechanical and behavior-preserving, and it's the unlock for unit-testing everything downstream.

---

## The LLM provider seam (decision #3)

You're migrating off the `claude` CLI *soon* but haven't chosen the target (Anthropic org API key vs another vendor) — so the deliverable now is **the seam, not the migration.** One interface; the CLI is the first implementation; future providers slot in without touching engines.

```js
// llm/provider.js  — the interface every provider implements
/**
 * @typedef {Object} RunSkillInput
 * @property {string} skillId           // 'generate-note' | 'cdi-review' | 'add-icd-codes' | ...
 * @property {object} input             // structured args (NOT a prebuilt shell string)
 * @property {string} model
 * @property {'low'|'high'|'max'} [effort]
 * @property {AbortSignal} [signal]
 * @returns {Promise<{ text:string, manifest?:object, usage:object, costUsd:number, durationMs:number, code:number }>}
 */
```

```js
// llm/claudeCliProvider.js  — current implementation
//  - prompts.buildPrompt(skillId, input) → arg array (no shell:true, no string-escaping bug)
//  - childRunner.run('claude', ['-p', prompt, '--output-format','stream-json', ...], { cwd, signal })
//  - parse stream-json result event → usage/cost (llm/usage.js)
//  - skills/contracts/manifest.js parses + validates the manifest
```

When you decide the target provider, you write one new file (`agentSdkProvider.js` or `<vendor>Provider.js`) implementing the same interface and flip the line in `appContext.js`. **Every engine, the pipeline, the status UI, and the DB writes are unaffected.** This is exactly why the seam is worth building before the provider decision — it decouples "restructure the code" (now) from "choose the vendor" (after your token-data + testing).

> Why this is better than committing to C1 or C2: the agents' research surfaced that the Agent SDK requires API-key auth (Pro/Max OAuth not permitted as of Feb 2026) and that subscription `claude -p` usage moves to a separate credit pool from June 2026 — i.e. the provider choice has billing/TOS consequences you're still evaluating. The seam lets you defer that without blocking the refactor. (More in [04](04-distribution-and-updates.md).)

---

## The engine framework (the centerpiece)

Today `spawnIcdCoding` / `spawnCdiReview` / `spawnSoapGeneration` are three copies of one shape. Make that shape explicit. An **engine** is a declarative descriptor; a shared **runner** executes it.

```js
// engines/cdi.js — a descriptor (≈ all engines look like this)
module.exports = {
  id:           'cdi',
  skillId:      'cdi-review',           // skill folder name — required; id and skillId can differ
  label:        'CDI review',
  jobKind:      'cdi',                 // processing_events.job_kind
  stage:        PIPELINE_STAGE.CDI,    // shared/pipeline-status.js
  model:        (cfg) => cfg.soapModel,
  effort:       'high',
  completesCase: false,               // exactly one engine (soap) sets true — see chain.js
  standards:    (ctx) => ['icd10_fy2026', 'ahima_acdis_2026', `specialties/${ctx.doctor.specialty}`],

  // PURE: returns [{skip, reason}] or [] — unit-testable with a fake ctx
  gates: (ctx) => cdiGates(ctx.config, ctx.doctor, ctx.paths),

  // PURE: structured input for the provider (no shell string)
  buildInput: (ctx) => ({ caseDir: ctx.caseDir, specialty: ctx.doctor.specialty,
                          mode: ctx.config.cdiMode, doctor: ctx.doctor.name,
                          standards: ctx.paths.standardsDir }),

  // PURE-ish: provider result → normalized engine result (+ on-disk fallback for CDI)
  interpret: (runResult, ctx) => interpretCdi(runResult, ctx.caseDir, ctx.fs),

  // I/O: DB writes (cdi_* columns + cdi_flags rows) via injected db
  persist: (result, ctx) => persistCdi(result, ctx.db, ctx.caseId),

  // PURE: status payload (generic badges/stats — NOT cdi-special fields)
  render: (result) => ({ badges: result.approvalRequired ? [{text:'⚠ Review', severity:'warn'}] : [],
                         stats: [{label:'flags', value:result.flagCount}, {label:'quality', value:result.qualityScore}],
                         openPath: result.docxPath }),
}
```

```js
// engines/engineRunner.js — the shared executor (one place, ~60 lines)
async function runEngine(engine, ctx) {
  const skips = engine.gates(ctx)
  if (skips.length) { ctx.reportStage(engine, 'skipped', skips[0].reason); return engine.onSkip?.(ctx) ?? null }
  ctx.reportStage(engine, 'running')
  const eventId = ctx.db.startEvent({ jobKind: engine.jobKind, caseId: ctx.caseId })
  try {
    const run    = await ctx.llm.runSkill({ skillId: engine.skillId, input: engine.buildInput(ctx),
                                            model: engine.model(ctx.config), effort: engine.effort, signal: ctx.signal })
    const result = engine.interpret(run, ctx)
    engine.persist(result, ctx)
    ctx.db.finishEvent(eventId, { status: result.status, ...run.usage, costUsd: run.costUsd, durationMs: run.durationMs })
    ctx.reportStage(engine, result.status, null, engine.render(result))
    return result
  } catch (err) {
    ctx.classifyAndWarn(err)            // single rate-limit/MCP classifier (markers.js)
    ctx.db.finishEvent(eventId, { status: 'failed' })
    ctx.reportStage(engine, 'failed')
    return null                          // best-effort: chain continues
  }
}
```

The runner owns everything the 5 functions duplicate today: the UI-stage push (single vs multi-patient is hidden behind `ctx.reportStage`), the `startEvent`/`finishEvent` with usage/cost, the single rate-limit/MCP classifier, the service-warning facade, and the resilient DB wrapper. **A new engine writes only the descriptor.**

```js
// engines/registry.js
module.exports = [ require('./soap'), require('./icd'), require('./cdi') ]
// adding Workers Comp = require('./workersComp') here + the descriptor file + a migration + a skill folder
```

`pipeline/chain.js` iterates the registry per case (single-patient: the case; multi-patient: each child), respecting `completesCase` to decide when the `cases` row flips to `completed` (today that's hard-coded to the soap docx — make it a declared property so the future doesn't fight it). Sequencing stays serial per case (MCP/quota reasons); the runner is the natural home for a global concurrency-1 Claude lock that new engines inherit for free.

**Docx conversion** is **not** an engine in the registry — it is a fixed post-step in `chain.js` that runs per-artifact (soap docx, then cdi docx) after the engine chain completes. The `completesCase` flag fires when the primary engine's (soap) docx lands. A separate `convertMdToDocx(mdPath)` helper keeps the conversion logic independent of the engine abstraction.

**The Auto-Pilot orchestrator** from the PA roadmap (`docs/pa-planning/05-engines.md §Auto-Pilot`) is realized by the **registry + each engine's `gates(ctx)` predicate** — there is no separate dispatcher module. `gates` is where `visit_type`, specialty, and per-doctor opt-in live. Engines that only apply to certain encounter types return a skip reason from `gates`; always-on engines (CDI, ICD) have trivially passing gates. This is the right design: conditional dispatch via per-engine predicates, no central orchestrator that becomes its own monolith.

**`visit_type` and `chief_complaint`** are parsed from the SOAP manifest today but discarded (logged to `app.log` only — no DB column, not in `ctx`). **This must be addressed before any gated/generation engine can drop in.** As part of Phase 2/3, thread these fields from the manifest into the `cases` row and into `ctx` so `engine.gates(ctx)` and `engine.buildInput(ctx)` can read them. See [07 B13](07-open-questions-and-decisions.md).

**Sequencing and parallelism.** Engines run serial per case today for MCP/quota reasons. Running engines in parallel is a roadmap feature Fahd has asked for and is **deliberately deferred** — the concurrency-1 lock makes parallelism a one-flag policy change later, without touching any engine descriptor. See [07 B2](07-open-questions-and-decisions.md).

**This single abstraction is what makes ~6 of the 8-engine roadmap a series of small additions.** The remaining two engine families need additional infrastructure: *generation engines* (Workers Comp, Prior Auth, orders, patient summary) need a per-encounter input-collection step (a form or on-demand trigger with user-supplied context like payer/DOI/language) in addition to the descriptor; *meta engines* (8b Feedback Loop, 8c Self-Learning) need a scribe-action capture surface and a feedback-log persistence layer. These are deferred per [07 B14](07-open-questions-and-decisions.md).

---

## Skills + contracts

- **Move `parseSkillManifest.js` → `src/skills/contracts/manifest.js`** and add `validateManifest(obj, schemaForEngine)` beside it. The parser stays the pure, total function it is; validation is per-engine.
- **`src/skills/contracts/prompts.js`** — one `buildPrompt(skillId, input)` per skill returning a safe arg array; the *only* place a prompt string is assembled. Kills the injection bug and the scattered escaping.
- **`src/skills/contracts/markers.js`** — named regexes (`rateLimited`, `mcpAuth`, `duration`, `errorLine`, `backupOk`), single source for the 6 duplicated rate-limit copies.
- **Standardize every engine/job on the JSON-manifest envelope** (retire `ICD_OK:`, the free-prose `edit-note` output, and `Updated:`). One return protocol → `parseSkillManifest` works for all. *Migrate the skills in lockstep with the spawn side* (they ship together; no in-flight skew because it's one bundle).
- **Inside `notes-claude/`:** move the embedded CDI renderer to `python/render_cdi.py`; strip repo-internal references (`main.js`, table names, `app.log`, "(v1.1)", the hardcoded dev path); replace the recursive "go read the other skill and run its steps" coupling with a shared referenced spec; delete the dead permission-setup heredocs and `draft/`; move per-doctor surnames out of `orthopedics.md`.
- **Standards registry:** a small `standards/manifest.json` mapping engine → files, so engine adapters load standards by lookup, not hardcoded path lists — keeps "drop a specialty file" zero-code.

---

## IPC layer

- **`src/shared/ipc-channels.js`** — one frozen `CHANNELS` map imported by both `preload.js` and `src/ipc/*`. A typo becomes a load-time `undefined`, not a silent hang. (Add a unit test asserting the preload surface ⊆ registered handlers — catches drift with zero Electron.)
- **`src/ipc/envelope.js`** — `wrapHandler(schema, fn)` validates args, runs the handler, normalizes throws to `{ok, error}`. One return shape. (Keep a thin compat shim for the handful of channels that return raw values until the renderer migrates — they ship together, so this is safe in one PR.)
- **Per-domain registrars** — `recording.js`, `doctors.js`, `templates.js`, `prechart.js`, `config.js`, `status.js`, `audioUpload.js`, `lifecycle.js`, each `register(ipcMain, ctx)`. The 979-line god-function becomes 8 focused modules whose handlers are thin: validate → call a service/store method on `ctx` → return the envelope. Business logic (ingest, doctor resolution, bootstrap) moves to `pipeline/`/`context/`/`startup/`.
- Mirror the grouping in preload (`api.recording.*`, `api.doctors.*`, …) and regenerate the CLAUDE.md IPC table from the contract so it can't drift again.

---

## Renderer

- **Shared constants via `src/shared/`** so the `STATE` enum, `DOCTOR_SPECIALTIES`, and `PIPELINE_STAGE` are defined once. (Without a bundler yet, expose them through the preload bridge, e.g. `api.constants` — acceptable until packaging brings a build step that lets the renderer import `src/shared/` directly. Decision #2: vanilla JS + JSDoc now.)
- **A `viewRouter` + per-view modules** (`{ mount(root, ctx), update(state), unmount() }`) replace `render()`'s fused switch, `showTab`, and the show/hide functions. State pushes re-render whatever view is mounted — fixes the `settingsOpen` dropped-update bug.
- **`components/fileListField.js`** replaces the 4 copy-pasted file-list widgets; **`components/timer.js`** is a pure object; **`ipc/client.js`** is the one typed wrapper over `window.api` (feature-flag guards live here, not scattered).
- **One visibility mechanism** (the `.hidden` class via a `setVisible(el,bool)` helper) — ban inline `.style.display`.
- **Engine-driven UI:** the Settings CDI block and per-doctor specialty dropdown are today bespoke one-offs. Drive future per-engine toggles from an **engine registry → UI manifest** (engine id → label, settings schema, per-doctor config) so adding Workers-Comp/PA/E-M to Settings is a config entry, not new imperative DOM. The status panel's per-engine result list (`reviews: [{engine, label, badges, stats, openPath}]`) replaces the flat `cdi*` fields and generalizes to N engines.
- No framework. A hand-rolled `{mount,update,unmount}` pattern over ~13 screens, jsdom-tested. (Revisit a 5–15 KB lib like Preact/Lit only if the hand-rolled pattern strains — note it, don't pre-adopt.)

---

## Config, paths, secrets, platform

- **`config/paths.js`** — a `Paths` object built once from `notesDir` + `userDataDir`; injected, never a mutable global. Solves both the ordering hazard and the packaging blocker (writable config moves to `app.getPath('userData')`).
- **`config/settings.js`** — one cached store + `DEFAULT_SETTINGS`; engine settings get namespaced (`engines.cdi.enabled`, `engines.icd.enabled`, …) instead of piling flat keys.
- **`config/secrets.js`** — file-based today; OS keychain (Windows DPAPI / macOS Keychain) behind the interface when packaging lands. The renderer gets a masked key, never the raw secret.
- **`config/mcp.js`** — writes `.mcp.json` *from* `notes-claude/.mcp.json` (delete the duplicate JS const).
- **`platform/`** — one interface (`isStaging`, `resolvePython`, `hideInternal`, `notify`, `secretStore`) with `windows.js`/`macos.js` implementations. `resolvePython` returns a resolved value (no mutable `PYTHON` global). macOS gets real branches (a dotfile/hidden-subfolder convention for "hide internals", Keychain secrets, an `activate` handler) instead of silent no-ops.

---

## DB (harden the good module)

- **Wrap each migration file in an explicit transaction** and drive `user_version` from the runner so schema + version advance atomically (tolerate the trailing `PRAGMA user_version` in existing files for one release). Surface a migration failure with the failing filename through the logger, not a swallowed `console.error`. *Do this before any engine adds a table.*
- **Make `getDb()` injectable** (`initDbWith(database)` / `__setDb`) so the whole layer is unit-testable against `better-sqlite3` `:memory:` in milliseconds — the single seam the "AI-testable" goal needs (see [05](05-testing-and-ai-workflow.md)).
- **`withDb(label, fn, fallback)`** collapses the ~25 try/catch+null-guard copies and routes errors through the app logger (so DB failures land in `app.log`).
- New-engine schema convention: **one migration per engine + one `db/<engine>.js` mirroring `cdi_flags.js` + one manifest validator.** Or, if the per-engine flag tables proliferate, a single generic `engine_findings` table keyed by `engine` — decide when the 2nd review engine lands (noted in [07](07-open-questions-and-decisions.md)).

---

## Logging

`log/logger.js` with levels (`debug/info/warn/error`), a `redact()` for PII (patient/doctor names), optional JSON-line mode, and rotation; async writes off the main thread's hot path. Keep the `[<case>][<phase>]` tags. **`processing_events` remains the structured source of truth** for usage/cost/status — `app.log` is debug narrative, not the analytics store.

---

## What deliberately stays the same

- **The skills-sync model** (`notes-claude/` → `<NOTES_DIR>/.claude/` on launch). Source-of-truth in the repo; runtime copy synced. (Add a delete-stale pass to `copyDirSync`.)
- **Files-on-disk canonical; DB as index.** The notes folder survives a DB delete.
- **The stdin stop/pause/resume protocol** (Decision #1) — moved into `recorderController.js` but the protocol is unchanged.
- **The state machine's shape** (`IDLE/SESSION_ACTIVE/RECORDING/PAUSED/PROCESSING`) — single-sourced, not redesigned.
- **The branch promotion flow** (`develop → staging → main`) and the staging marker (which becomes a `channel` setting once packaging lands).
- **The non-blocking pipeline** (UI freed before transcription) — re-expressed in `pipeline/`, same behavior.

---

## Language & tooling stance (decision #2)

- **Now:** vanilla JS + **JSDoc typedefs** (`shared/ipc-contract.js`, the provider/engine interfaces). `node:test` + `node:assert` as the runner (zero deps, runs under the bundled Node). No bundler while still on git-pull — use native ESM/`require` and expose shared constants to the renderer via preload.
- **After packaging (Phase 6):** adopt **TypeScript** — the build step then lives in CI (electron-builder), not on user machines, so it doesn't fight the ship model. The JSDoc typedefs convert to real types cheaply, and types will catch exactly the string-contract-drift class of bug that dominates table B. JSDoc now is a deliberate down-payment on that conversion.

---

## Worked example — adding the Workers-Comp engine (the payoff)

To prove the structure: shipping a future engine becomes these local steps, touching no monolith:

1. **Skill:** `notes-claude/skills/workers-comp/SKILL.md` (+ standards files; register in `standards/manifest.json`).
2. **Descriptor:** `src/engines/workersComp.js` — `id:'wc'`, `skillId:'workers-comp'`, `jobKind:'wc'`, `gates: (ctx) => ctx.encounter?.visit_type?.startsWith('wc_') ? [] : [{skip:true, reason:'not a WC visit'}]`, `buildInput` (includes payer, DOI, employer from `ctx.encounter`), `interpret`, `persist`, `render`. *(Note: `visit_type` must be captured from the SOAP manifest into `ctx.encounter` / a `cases` column — see Phase 2/3 in [03](03-migration-plan.md) and [07 B13](07-open-questions-and-decisions.md). Also note WC is a generation engine requiring a per-encounter form for payer/DOI — see §engine-framework above.)*
3. **Registry:** add one line to `src/engines/registry.js`.
4. **DB:** one migration (`00N_add_wc.sql`) + `db/wc.js` (or a row in the generic findings table — see [07 B3](07-open-questions-and-decisions.md); lean generic once the 2nd engine lands).
5. **Contract:** add the WC manifest schema to `skills/contracts/manifest.js`.
6. **UI:** appears automatically in Settings + the status panel via the engine→UI manifest; no imperative DOM.
7. **Tests:** unit-test `gates`/`buildInput`/`interpret`/`persist` with a fake `ctx` and fixture manifests — no Electron, no real Claude.

The provider, chaining, status reporting, token logging, docx conversion, file hiding, and error handling are all inherited from shared infrastructure. *That* is the architecture's purpose.

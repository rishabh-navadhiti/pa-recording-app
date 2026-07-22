# Architecture

Pipeline, processes, and file flow for AI Medical Scribe. Sister doc to [CLAUDE.md](../CLAUDE.md) — this is the deeper view; CLAUDE.md is the quick reference.

---

## Process model

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron main process (main.js — thin bootstrap + shims)        │
│   • Tray icon (left-click toggles main window)                  │
│   • Main window (full taskbar entry, close-to-minimize)         │
│   • Optional floating status window (multi-case progress)       │
│   • State machine (context/stateMachine.js, via ctx.stores)     │
│   • IPC handlers (8 registrars in src/ipc/)                     │
│   • Spawns and supervises all child processes                   │
│   • Single-instance lock                                        │
└────────────┬───────────────────────────────────┬────────────────┘
             │ contextBridge                     │ ctx.llm.runSkill /
             │ (preload.js)                      │ child_process.spawn
             ▼                                   ▼
┌──────────────────────────────────────┐    ┌──────────────────────────────────┐
│ Renderer (2 windows)                 │    │ Children (one per task)          │
│   • app.js (viewRouter)              │    │   • python record.py             │
│   • views/ + components/             │    │   • python md_to_docx.py         │
│   • ipc/client.js (window.api seam)  │    │   • claude -p (SOAP — runEngine) │
│   • statusPanel.js (mini status      │    │   • claude -p (template/update)  │
│      window, opt-in)                 │    │   • claude -p (edit-note)        │
│   • Listens for state + events       │    │   • claude -p (ICD — runEngine)  │
│                                      │    │   • claude -p (CDI — runEngine)  │
│                                      │    │   • git pull (auto-update)       │
└──────────────────────────────────────┘    └──────────────────────────────────┘

All `claude -p` invocations go through `ctx.llm.runSkill(...)`
(`src/llm/claudeCliProvider.js` — arg-array spawn, `shell:false`); the old
`spawnClaude` helper is gone. Transcription (ElevenLabs) and Pre-chart
attachment-combining used to be Python children too; as of Phase 5 they run
in-process in Node (`src/pipeline/elevenLabs.js` + `attachments.js`) as awaited
`fetch` / library calls, so they're no longer in the children box.
```

The renderer cannot touch Node, fs, or `child_process` — it must go through `window.api` (`preload.js`). Children are short-lived and unsupervised after spawn except `record.py`, which is held in `ctx.stores.recorder` (`context/recorderController.js`) and stopped via stdin.

Two BrowserWindows exist: the **main window** (`win`, 280×420, framed false, alwaysOnTop, full taskbar entry) and an optional **status window** (`statusWin`, 300×380, framed false, alwaysOnTop, `skipTaskbar: true`) the user can open to see per-case progress while the main window is closed/minimized. The status window receives a separate `recording-status-update` channel driven by `getSessionRecordings()`.

---

## The `ctx` object (dependency injection)

The Phase 0–5 refactor turned a 3,555-line `main.js` monolith (with ~18 module-level globals) into a modular codebase wired together by a single **app context** object, `ctx`. `main.js` is now a ~675-line bootstrap + a handful of thin shims (`spawnSoapGeneration`, `spawnTranscription` re-exports) + a deps-assembling `registerIpcHandlers`.

`ctx` is built by `context/appContext.js → createAppContext(notesDir)` and assembled / attached to windows during `startup/bootstrap.js`. It carries:

| Field | What it is |
|---|---|
| `ctx.config` | Settings store (`config/settings.js`) — `ctx.config.get()` / `.save()`; enforces the `enableCdi ⟹ enableIcd` invariant |
| `ctx.secrets` | `.env` reader/writer (`config/secrets.js`) — ElevenLabs key |
| `ctx.paths` | Resolved paths (`config/paths.js`) — `notesDir`, `casesDir`, `logFile`, … |
| `ctx.platform` | Platform seam (`platform/index.js` → `windows.js`/`macos.js`) — `hideInternal`, `notify`, `isStaging`, … |
| `ctx.llm` | Agentic LLM provider (`src/llm/claudeCliProvider.js`) — `ctx.llm.runSkill({prompt, model, effort, …})`, `shell:false` arg-array spawn. The `claude -p` seam; there is no `spawnClaude`. |
| `ctx.api` / `ctx.gemini` / `ctx.openai` | Single-call HTTP API providers — `runSingleCall({system, user, model, …})`, `fetch`, no tools, always-resolves. `ctx.api` = Anthropic Messages (`anthropicApiProvider.js`), `ctx.gemini` = Gemini OpenAI-compat (`geminiApiProvider.js`), `ctx.openai` = OpenAI Chat Completions (`openaiApiProvider.js`, gpt-5.6-luna — `max_completion_tokens` + `reasoning_effort:'minimal'`). The SOAP note-gen API path picks one by `resolveOption(soapModel).provider`; usage is normalized by `src/llm/pricing.js`. |
| `ctx.log` / `ctx.logger` | The `log()` helper writing to `<NOTES_DIR>/app.log` |
| `ctx.db` / `ctx.setDb` | The `better-sqlite3` handle (set by bootstrap after `initDb`) |
| `ctx.stores.state` | State machine (`context/stateMachine.js`) — the `IDLE…PROCESSING` enum + transitions |
| `ctx.stores.session` | Current-session store (`context/sessionStore.js`) — sessionId, doctorId, counters |
| `ctx.stores.recordings` | Per-case status store (`context/recordingsStore.js`) — drives the floating status window |
| `ctx.stores.recorder` | The live record.py child + stdin protocol (`context/recorderController.js`) |
| `ctx.stores.jobs` | Single-flight job lock for template/prechart jobs (`jobs/jobRunner.js`) |
| `ctx.renderer` / `ctx.sendStatus` | Guarded send facades to the main + status windows (no-op until windows exist) |

**The rule:** modules take `ctx` as a parameter and reach for what they need off it — they do **not** reach for module-level globals. The former globals (`recordingProcess`, `templateJobProc`, `currentState`, settings cache, …) now live in stores. LLM work goes through `ctx.llm`; DB work through `ctx.db` + the `db/` helpers.

---

## Engine framework + chain orchestration

The three Claude-backed per-case steps — **SOAP**, **ICD**, **CDI** — are uniform **engine descriptors** in `src/engines/{soap,icd,cdi}.js`, run by a single shared lifecycle, `runEngine(engine, ctx, caseCtx)` (`src/engines/engineRunner.js`). Each descriptor declares: `id`, `skillId`, `jobKind`, `stage` (status-popup label), `model(cfg)`, `effort`, `gates(ctx, caseCtx)`, `buildInput(ctx, caseCtx)`, `interpret(runResult, ctx, caseCtx)`, `persist(...)`, and `render(result)`.

`runEngine` walks every engine through the same steps:

```
gates → status(running) → startEvent → run-the-LLM → classify(rate-limit/MCP-error)
      → interpret → finishEvent → persist → service-warning → status(complete)
```

**run-the-LLM has two modes.** Engines with no `runLlm` method (SOAP, ICD, CDI) run agentically via `ctx.llm.runSkill` (`claude -p`). Engines that expose `runLlm(input, ctx, caseCtx, {model, provider})` (em-score, patient-summary) instead run as a single Anthropic Messages-API call: `runEngine` branches on `!!engine.runLlm`, passes `ctx.api` (pinned Anthropic — never Gemini, model via `pinnedAnthropicModel()`), and the engine's `runLlm` reads inputs, calls `provider.runSingleCall`, writes its `_em.json`/`_patient_summary.json`, and returns a normalized `{code, text(=synthesized manifest), usage}` so the rest of the lifecycle is identical for both modes. See DECISIONS 2026-06-29. (These two need `ANTHROPIC_API_KEY` even on the "Agentic" SOAP option.)

If `gates()` returns a reason the step is skipped (logged + reported `skipped`, no skill call). Engines are best-effort: a failure returns `null` and the chain continues. `src/engines/registry.js` declares the canonical order `[soap, icd, cdi, em-score, patient-summary]`.

The **chain** that drives these per case is `src/pipeline/chain.js`:
- `runCaseChain(ctx, caseCtx)` — single-patient: `runEngine(icd)` → `runEngine(cdi)` → `runEngine(emScore)` → `runEngine(patientSummary)` → `docx.spawnDocxConversion(soap)` → `docx(cdi)` → `report.renderCaseReport(...)`. em-score + patient-summary self-gate off when their toggles are off, are JSON-only (no docx), and persist to `engine_outputs`. `renderCaseReport` is the final post-step (see *Engine-output rendering* below).
- `runMultiPatientChain(ctx, opts)` — plans child folders (`src/pipeline/multiPatient.js → planChildCases`), publishes the full patient list to the status UI, then loops children sequentially, materializing each folder and calling `runCaseChain` on it (so the two new engines apply per child automatically).

(SOAP itself runs slightly upstream of the chain, in `main.js → spawnSoapGeneration`, which parses the manifest and then dispatches to `runCaseChain` / `runMultiPatientChain`. ICD + CDI + em-score + patient-summary run via `runEngine` inside the chain; docx is a fixed post-step, not an engine.)

**Adding a new per-case engine** = (1) write a descriptor in `src/engines/`, (2) add one line to `src/engines/registry.js` (and call it from the chain), (3) for DB persistence either write one `engine_outputs` row (the generic, no-schema-change path — see `db/engine_outputs.js`, what em-score/patient-summary use) or, only if the status UI needs denormalized summary columns, add a migration, (4) drop a skill folder into `notes-claude/skills/`.

> **CDI persist (resolved 2026-06-09, commit `7c39e13`):** `runEngine` calls `engine.persist(...)` after `interpret()`. `cdi.persist()` writes the `cases.cdi_*` summary columns (`updateCaseCdi`) + the per-flag `cdi_flags` rows (`insertFlags`, reading the on-disk `_cdi.json`). `engine.render(...)` is defined on descriptors but still **not** invoked by `runEngine` — it's reserved for a future status-UI hook; persistence does not depend on it. The two v0.2 engines (em-score, patient-summary) persist via `engine_outputs` instead of per-`cases` columns (the anti-splatter pattern — see *DB* below).

---

## Recording-pipeline sequence

```
User           Renderer            Main                Python              ElevenLabs       Claude CLI
 │               │                  │                   │                       │              │
 │ Start Rec ──▶ │ startRecording() │                   │                       │              │
 │               │ ──IPC──────────▶ │ spawn record.py ─▶│ open WAV in tmpdir    │              │
 │               │                  │ setState RECORDING│ stream audio frames   │              │
 │               │ ◀─state-change── │                   │                       │              │
 │               │ render timer     │                   │                       │              │
 │ Stop ───────▶ │ stopRecording()  │                   │                       │              │
 │               │ ──IPC──────────▶ │ stdin "stop\n" ──▶│ flush WAV, MP3 export │              │
 │               │                  │ await exit        │ exit 0                │              │
 │               │                  │ setState PROCESSING                       │              │
 │               │ ◀─show-patient-form                  │                       │              │
 │               │ open form        │                   │                       │              │
 │ Save name ──▶ │ submitPatientName│                   │                       │              │
 │               │ ──IPC──────────▶ │ resolve promise   │                       │              │
 │               │                  │ build case dir    │                       │              │
 │               │                  │ rename MP3 in     │                       │              │
 │               │                  │ transcribe (Node fetch, in-process) ─────▶│ POST          │
 │               │                  │ setState SESSION_ACTIVE  (UI freed!)      │ /v1/speech    │
 │               │ ◀─state-change── │                                           │              │
 │               │                  │              ◀──── transcript JSON ───────│              │
 │               │                  │ formatTranscript() → write transcript.md  │              │
 │               │                  │ on success: ctx.llm.runSkill (SOAP) ─────────────────────▶│
 │               │                  │                   │                       │  generate-note
 │               │                  │                   │                       │  reads template
 │               │                  │                   │                       │  + transcript
 │               │                  │                   │                       │  writes one or more
 │               │                  │                   │                       │  _soap_note.md into
 │               │                  │                   │                       │  the case folder
 │               │                  │                   │                       │  ends response with
 │               │                  │                   │                       │  JSON manifest line
 │               │                  │ on runSkill resolve (spawnSoapGeneration):                │
 │               │                  │   parseSkillManifest(resultText)  (src/llm/skill-io/      │
 │               │                  │                                    manifest.js)          │
 │               │                  │   single → chain.runCaseChain(ctx, caseCtx)               │
 │               │                  │   multi  → chain.runMultiPatientChain(ctx, opts)          │
 │               │                  │   per case folder (single=parent; multi=each child):      │
 │               │                  │     runEngine(icd) → ctx.llm.runSkill (add-icd-codes)     │
 │               │                  │       → appends ## ICD-10-CM Codes table to <case>.md     │
 │               │                  │       → best-effort; failure falls through to next step   │
 │               │                  │     runEngine(cdi) → ctx.llm.runSkill (cdi-review)        │
 │               │                  │       → produces <case>_cdi.json + <case>_cdi.md          │
 │               │                  │       → SKIPPED if enableCdi=false, no specialty, or no   │
 │               │                  │         standards file (cdi.gates() before runSkill)      │
 │               │                  │       → emits JSON manifest (last line of final response) │
 │               │                  │         consumed via parseSkillManifest()                 │
 │               │                  │       → manifest miss → cdi.interpret() falls back to     │
 │               │                  │         on-disk _cdi.json (recovery layer, intact)        │
 │               │                  │       → cdi.persist() writes cdi_* cols + cdi_flags rows  │
 │               │                  │       → best-effort; failure falls through to docx        │
 │               │                  │     runEngine(emScore) → Anthropic API → <case>_em.json   │
 │               │                  │     runEngine(patientSummary) → API → _patient_summary    │
 │               │                  │       → API-only (runLlm); JSON only; 1 engine_outputs row │
 │               │                  │     docx.spawnDocxConversion on the now-coded soap .md    │
 │               │                  │     docx.spawnDocxConversion on cdi .md (if CDI succeeded)│
 │               │                  │   if  multi_patient: per cases[] entry —                  │
 │               │                  │     mkdir <slug>_<YYYY-MM-DD>/,                           │
 │               │                  │     copy mp3 + transcript + transcript.docx + soap.md in, │
 │               │                  │     insert child cases row,                               │
 │               │                  │     await runCaseChain on child (sequential across kids), │
 │               │                  │     docx on the now-coded child soap .md,                 │
 │               │                  │     docx on cdi .md (if CDI succeeded),                   │
 │               │                  │     hide audit .md in recording folder (Windows)          │
 │               │                  │   mark parent row completed (soap_note_path=NULL on multi)│
 │               │                  │   (audit folder is never ICD-coded, CDI-reviewed, or      │
 │               │                  │    docx-converted)                                        │
```

Key properties:
- **Non-blocking**: state returns to `SESSION_ACTIVE` *before* transcription completes. The scribe can start the next case while the pipeline runs.
- **Detached subtree**: transcribe → soap → (ICD → CDI → docx) is a chain, not a supervisor tree. Transcription is an awaited Node `fetch`; the SOAP/ICD/CDI steps are awaited `ctx.llm.runSkill(...)` promises; docx is a spawned Python child whose `close` event finalizes the case. The chain spine is `src/pipeline/chain.js` (`runCaseChain` / `runMultiPatientChain`).
- **Single log stream**: every child's stdout/stderr is captured by the main process and written to `<NOTES_DIR>/app.log` with a `[<case>]` tag, so the whole pipeline is reconstructable from one file.
- **Skill is a pure note generator.** The `generate-note` skill writes `.md` files and declares them in a JSON manifest; it does not create sub-folders, copy files, or convert DOCX. All file shuffling and DOCX is owned by `main.js` after the manifest is parsed. See *Skill manifest contract* and *Multi-patient split* below.

### Skill manifest contract

The `generate-note` skill ends its final assistant response with a **single line of valid JSON** describing what it produced. The line is the **last** thing in the response — any chief-complaint prose, narrative confirmation, etc. appears before it. `main.js`'s `spawnSoapGeneration` consumes the manifest via `parseSkillManifest()` (in [src/llm/skill-io/manifest.js](../src/llm/skill-io/manifest.js)). Schema lives in [notes-claude/skills/generate-note/SKILL.md](../notes-claude/skills/generate-note/SKILL.md) Step 7; the load-bearing fields are:

| Field | Used by app for |
|---|---|
| `schema_version` | Version gate. v1 only; future versions fail closed until app catches up. |
| `status` | `failed` → mark case failed, no docx, no split. |
| `multi_patient` | Branch decision: single vs multi-patient post-processing. |
| `recording_folder` | Diagnostic only — the app uses `dirname(soap_note_md)` as authoritative. |
| `cases[].soap_note_md` | Absolute path the skill claims to have written. App verifies on disk before docx/copy. |
| `cases[].patient_name` | Source of the child folder slug (sanitised app-side). `null` falls back to `unknown_<n>`. |
| `cases[].status` | Per-case gate — `failed` skips that case's post-processing. |

Non-DB fields (`visit_type`, `chief_complaint`, `placeholders`, `warnings`, `summary`) are logged once to `app.log` via the parsed manifest object — never persisted to `app.db`. Adding columns later for any of these is a one-line migration; preallocating is not.

The parser is layered defensive: (1) last non-empty line, direct `JSON.parse`; (2) strip ```` ```json ```` / ```` ``` ```` fences; (3) brace-balance scan from the rightmost `}` walking left for a matching `{`. On total failure: returns `null`; caller marks the run failed and logs the trailing stdout for debugging. Unit-tested via [tests/unit/manifest.test.js](../tests/unit/manifest.test.js) (fixtures in `tests/fixtures/manifests/`) — run with `npm test`.

### Multi-patient split

When the manifest sets `multi_patient: true`, the parent recording folder becomes an audit folder and the app fans out per-patient child folders next to it:

```
Cases/2026-05-22/
  recording_2026-05-22_14-33-10/      ← audit folder (parent cases row, soap_note_path=NULL)
    recording.mp3
    transcript.md
    transcript.docx
    jane_doe_soap_note.md              ← retained (audit, .md hidden on Windows)
    john_smith_soap_note.md
    maria_garcia_soap_note.md
  jane_doe_2026-05-22/                  ← child (own cases row, same session_id as parent)
    jane_doe.mp3                       ← copy of parent's MP3 renamed to single-patient convention
    transcript.md                       ← copy
    transcript.docx                     ← copy
    jane_doe_2026-05-22_soap_note.md   ← copy of the audit .md, renamed to single-patient convention
    jane_doe_2026-05-22_soap_note.docx ← generated by app
  john_smith_2026-05-22/
    ...
  maria_garcia_2026-05-22/
    ...
```

Properties:
- **Child folders are indistinguishable from single-patient cases on disk.** Pre-chart, the file picker, recent-cases listings, DB queries — none of them have to special-case multi-patient children.
- **Recording folder retains everything the skill wrote.** No files are moved out, only copied. The audit `.md` files stay in the recording folder (hidden on Windows) alongside the original MP3 and transcript.
- **DB shape: 1 parent row + N child rows, all sharing `session_id` and `doctor_id`.** Parent has `soap_note_path=NULL`, `status='completed'`. Each child has all paths populated and progresses `converting → completed` via the existing docx success path. Children are inserted in `src/pipeline/chain.js → runMultiPatientChain` via `db/cases.js → createCase` then `updateCasePaths(..., { status:'converting', ... })` — they skip the `transcribing` → `generating_note` stages. (`createChildCase` also exists in `db/cases.js` but the live multi-patient chain uses `createCase`.)
- **`processing_events` for the SOAP step stays attached to the parent's `case_id`.** Only one Claude invocation, only one usage event. Each child docx run gets its own `docx` event row with `case_id` pointing to the child.
- **`processing_events` for the ICD step is per child.** Each child's ICD invocation gets its own `icd` event row with `case_id` pointing to the child — never the parent. The audit folder is not ICD-coded, so the parent gets zero `icd` events.
- **`session.case_count` counts children, not recordings.** A 5-patient recording bumps `case_count` by 5 because `bumpSessionCounters` fires per docx-success and docx runs once per child. Parent (audit) rows never docx so they never bump the counter. Pre-existing develop behavior.
- **`audio_duration` and `audio_size_bytes` live only on the parent row.** Children inherit nothing audio-specific — one audio file is shared across all patients in the recording. The child's `mp3_path` points to the per-child *copy* of that audio.
- **Per-patient cost attribution for SOAP is intrinsically not separable.** One Claude invocation generates content for all patients, so SOAP cost lives on the audit row only. Per-child queries see ICD + docx costs only. Per-session totals (joining through `case_id` → `cases.session_id`) include the SOAP cost via the parent row.
- **No cleanup or "resume" logic in v1.** If the app crashes between skill exit and split completion, the recording folder is durable; the user can re-process manually. A future "resume split" feature could re-read the manifest from `app.log`.

### Per-case post-processing chain (ICD → CDI → E/M score → patient summary → docx → report)

Both single-patient and multi-patient cases run the same per-case post-processing chain after the SOAP `.md` is in its final on-disk location:

The chain itself lives in `src/pipeline/chain.js` (`runCaseChain` for single-patient, `runMultiPatientChain` for the per-child loop). ICD and CDI are **engine descriptors** (`src/engines/icd.js`, `src/engines/cdi.js`) run through the shared `runEngine()` lifecycle (`src/engines/engineRunner.js`); docx is a fixed post-step, not an engine. See *Engine framework + chain orchestration* below.

1. **`runEngine(icd, ctx, caseCtx)`** invokes the `add-icd-codes` skill via `ctx.llm.runSkill(...)` (prompt: `add ICD codes. Soap note: <rel-path>.`). The skill reads the SOAP `.md`, extracts diagnoses, looks them up via the claude.ai ICD-10 MCP connector, and appends an `## ICD-10-CM Codes` table at the end of the file. `runEngine` resolves on completion (success OR failure — it never rejects). A `processing_events` row with `job_kind='icd'` is recorded with token usage, cost, duration, and status (`success` / `failed` / `rate_limited`). Status-popup label transitions through `coding_icd` while it runs. **One gate short-circuits before the skill runs** — `icd.gates()` requires the global `enableIcd` setting on, else `runEngine` logs `[icd] SKIPPED: disabled`, reports `skipped`, and returns null with no skill call, no codes appended.

2. **`runEngine(cdi, ctx, caseCtx)`** invokes the `cdi-review` skill via `ctx.llm.runSkill(...)` (prompt: `review cdi. Case: …. Specialty: …. Mode: …. Doctor: …. Standards: …`). The skill validates the SOAP note against the standards packs in `<NOTES_DIR>/.claude/standards/` (now including `em_mdm_2021.md` for the per-flag E/M `reimbursement_impact` signal), produces `<case>_cdi.json` + `<case>_cdi.md` in the case folder — including provider queries (`provider_query` per flag + a top-level `queries[]`, AHIMA-compliant) — and emits a **JSON manifest** as the last line of its final assistant text (schema in SKILL.md Step 9; `schema_version:1` + `skill:'cdi-review'` + `status:'ok'|'skipped'|'failed'` + summary fields incl. `query_count`). `cdi.interpret()` consumes the manifest via `parseSkillManifest()`. On `status:'ok'`, **`cdi.persist()` writes** the summary fields to the `cases.cdi_*` columns (via `dbCases.updateCaseCdi`) and the per-flag payload to `cdi_flags` (via `dbCdiFlags.insertFlags` reading the full `_cdi.json` from disk — including `reimbursement_impact`, which has an existing nullable column).

   A `processing_events` row with `job_kind='cdi'` captures token usage. Status-popup label transitions through `running_cdi`. **Three gates short-circuit before the skill runs** — saves tokens + latency: (a) global `enableCdi` setting must be on; (b) `doctor.specialty` must be non-empty; (c) `<NOTES_DIR>/.claude/standards/specialties/<specialty>.md` must exist (all checked in `cdi.gates()`). **Filesystem fallback** is the load-bearing reliability layer: when the manifest line is missing, malformed, or `status:'failed'`, `cdi.interpret()` reads the on-disk `<case>_cdi.json` (which the skill writes in Step 8, before Step 9's manifest emission) via `synthesizeManifestFromDisk()` and rebuilds a manifest from its `summary` + `flags` + `code_validation` content. If the file exists and validates, the run is recovered to `status:'ok'` as if the manifest had been emitted cleanly. **ICD-aware**: the skill notices any ICD codes already in the SOAP note (from step 1) and validates them, populating an optional `code_validation` block in the output JSON and setting `icd_validated:true` in the manifest.

3. **`runEngine(emScore)` → `runEngine(patientSummary)`** (v0.2, sequential, after CDI, before docx). Each is gated by its own toggle (`enableEmScore` / `enablePatientSummary`) — off ⇒ skipped with no skill call. **em-score** (`em-score` skill, prompt `score em. Case: …. Specialty: …. Standards: …`) scores the AMA 2021 Office/Outpatient E/M level from the SOAP note against `em_mdm_2021.md`, writes `<case>_em.json` (predicted level, per-element MDM, downcode risk, upgrade path, time alternative). **patient-summary** (`patient-summary` skill, prompt `summarize for patient. Case: …`) writes `<case>_patient_summary.json` (plain-language, ~grade-6, five sections). Both are **JSON only — no MD, no docx** (presentation renders from JSON in a later step). Both are connector-free. `interpret()` parses the manifest with an on-disk-JSON fallback (mirroring CDI). `persist()` writes **one row to the generic `engine_outputs` table** (`db/engine_outputs.js insertOutput`, keyed by `(case_id, engine)`) — NOT per-`cases` columns. A `processing_events` row (`job_kind` `em_score` / `patient_summary`) captures usage; status labels transition through `scoring_em` / `patient_summary`.

4. **`docx.spawnDocxConversion(soapNoteMdPath, …)`** (`src/pipeline/docx.js`) runs after the engines resolve, generating the soap `.docx` from the now-coded `.md`. A second `spawnDocxConversion(cdiMdPath, …)` runs when CDI produced a `.md`, generating the cdi `.docx`. The kind ('soap' / 'cdi' / 'transcript') is detected from the filename (`*_cdi.md` → 'cdi'); the close handler branches accordingly. Soap-docx success flips the case to `'completed'` (primary deliverable); cdi-docx success only populates `cdi_docx_path` (via `dbCases.updateCaseCdi`) and surfaces the Open CDI Review button in the popup. **The two v0.2 engines get no docx** — their output is JSON.

5. **`report.renderCaseReport(ctx, caseCtx)`** (`src/pipeline/report.js`) runs last — the *Engine-output rendering* step below. It renders ONE combined "Clinical Cockpit" `<stem>_report.html` + `<stem>_report.pdf` from whatever engine JSONs landed; awaited (one offscreen render at a time), best-effort.

Properties:
- **ICD + CDI are both best-effort.** Failure (MCP unreachable, model error, rate limit, network, skill bug) logs + emits a `service-warning` IPC + records the failure status on `processing_events`, but the chain always falls through to docx. A SOAP note without codes — or without a CDI review — is still useful.
- **ICD + CDI are per case folder, never on audit folders.** Single-patient runs them once on the parent's `.md`. Multi-patient runs them once per child folder's `.md`. The recording (audit) folder retains the SOAP `.md` files the skill wrote — never appended to, never CDI-reviewed, never converted to docx.
- **Sequential across children.** In multi-patient runs the per-child loop awaits each child's ICD then CDI before continuing to the next. This keeps MCP connector load + Anthropic rate-limit pressure + log-block readability sensible. Across-child parallelism is a future optimization.
- **CDI sequentially after ICD.** The ICD-aware behavior in `cdi-review/SKILL.md` Step 3 requires codes to already be in the note when CDI runs. Running ICD and CDI in parallel would make the validation behavior non-deterministic — sometimes CDI sees codes, sometimes not. Sequential is correct.
- **CDI on ⟹ ICD on (one-way invariant).** Because CDI depends on ICD codes being in the note, enabling `enableCdi` forces `enableIcd` on. Enforced in two places: the settings store's read normalizes the merged object (covers legacy `settings.json` and the live `icd.gates()` read), and the `save-settings` handler re-applies it before persisting. The renderer mirrors this in the UI — while CDI is checked, the ICD checkbox is shown checked + disabled (`syncIcdLock`). The reverse is not coupled: ICD can run with CDI off.
- **Pre-chart re-runs ICD only.** When `edit-note` rewrites a SOAP `.md`, the diagnoses may have changed — `runEngine(icd, …)` re-runs before the docx refresh. CDI is **not** re-run automatically (v1.1 follow-up); the old `_cdi.{json,md,docx}` artifacts remain in the case folder.
- **All children visible in the status UI upfront.** `runMultiPatientChain` (`src/pipeline/chain.js`) does a planning pass (`planChildCases`, `src/pipeline/multiPatient.js`) to compute every child's slug + folder + UI entry, calls `ctx.stores.recordings.setPatients` once, then runs the processing pass. Each child starts in state `queued` (muted, static dot in the popup); the active one transitions to `coding_icd` → `running_cdi` → `converting` → `completed` (or `failed`) while siblings sit on `queued`. This decouples "show all patients" from "process them one at a time" — the per-child sequencing only affects work, not visibility.
- **CDI UI fields ride alongside the main status.** Each entry / patient is intended to carry `cdiStatus`, `cdiFlagCount`, `cdiQualityScore`, `cdiClinicianApprovalRequired`, `cdiDocxPath` independent of the main status state machine. The status popup uses these to render the "⚠ Review" badge (when approval required) and the Open CDI Review button (when `cdiDocxPath` is set). The recordings store's `onChange` payload and `get-session-recordings` spread the entry, so these fields flow to the renderer without a separate IPC channel. ⚠️ Tied to the regression above: only `cdiDocxPath` is populated by the live pipeline today (set in docx.js); the other `cdi*` UI fields are produced by `cdi.render()`, which `engineRunner` does not currently call.

### Engine-output rendering (combined "Clinical Cockpit" HTML → PDF)

The review/scoring engines (CDI, E/M MDM, patient-summary) keep their **JSON as canonical**; the *presentation* of those JSONs is one combined report per case, rendered by `src/pipeline/report.js → renderCaseReport(ctx, caseCtx)` — a **fixed post-step** after the engines + docx, structured like docx (not an engine, not inside `runEngine`).

Flow:
1. **Assemble `PA_DATA`.** `assemblePaData(caseDir)` resolves the file stem from the `*_soap_note.md` name (NOT always the folder/patient name) and reads whatever of `<stem>_{cdi,em,patient_summary}.json` exist. Returns `{ meta, cdi, em, patient_summary }` with `meta` sourced from the richest engine (CDI carries specialty + mode + standards versions). If **no** engine JSON exists, the step no-ops (nothing to render).
2. **Inject into the template.** `buildReportHtml(template, paData)` reads `templates/engine-report/cockpit.html` (the committed, shipped template — the scroller's CSS + render layer with the hardcoded data block replaced by a `<script id="pa-data" type="application/json">__PA_DATA_JSON__</script>` seam) and replaces the placeholder with the JSON. `<`/`>` (and the U+2028/U+2029 separators) are escaped to their `\uXXXX` forms so a stray `</script>` or `<` in note text can't break out of the inline script block; the template's render layer `JSON.parse`s the seam's `textContent`, which decodes them back. The render layer reads **only** from `PA_DATA` — case-agnostic; swap the data and it re-renders for any case.
3. **Write HTML.** `<stem>_report.html` is written first — a self-contained, offline, shareable artifact even if the PDF render later fails.
4. **Print to PDF.** An **offscreen Electron `BrowserWindow`** (`show:false`, sandboxed) loads the HTML; `webContents.printToPDF({ printBackground:true, preferCSSPageSize:true })` honors the template's `@page { size:Letter; margin… }` + `break-inside:avoid` rules and preserves the navy header + severity palette. The Buffer is written to `<stem>_report.pdf`; the window is destroyed in `finally`. Chromium, **zero new deps**.
5. **Persist + surface.** Both paths are written to `cases.report_html_path` / `report_pdf_path` (migration 008); a `processing_events` row (`job_kind:'report'`) records duration/status. The recordings store gets `reportPdfPath`/`reportHtmlPath` (via `setReport`/`setPatientReport`), and the status popup shows an **"Open Report"** button (prefers the PDF, falls back to HTML; opened through the existing `open-soap-note` IPC, which confines to `CASES_DIR`).

Design choices (see the 2026-06-26 DECISIONS entry):
- **One combined report per case, not per-engine.** Matches the cockpit reference's "one cockpit per case" intent; makes this a single case-level post-step rather than per-engine `toDocument()` hooks.
- **Both HTML and PDF stay on disk and visible** (the `.md`-hiding logic doesn't touch `.html`/`.pdf`).
- **Best-effort.** A render failure logs and leaves the engine JSONs untouched — SOAP completion is the primary deliverable.
- **Data-driven, no hardcoded codes.** em-score now emits `billed_em_code`/`billed_em_source` (parsed from the note's Level-of-Service placeholder, null when absent); the report's billed-vs-supported card + downcode banner render from that field and are omitted when it's null or equals the predicted level.
- **Multi-patient:** because the report runs inside `runCaseChain`, each child folder gets its own report; the parent (audit) folder gets none.
- **Reference + sandbox:** `docs/notes/cdi-ui-reference/presentation_cockpit_scroller.html` is the design sandbox the shipped template was lifted from; `presentation_cockpit.html` (tabbed) is the reference for a future in-app interactive surface, which can consume the same `PA_DATA` contract.

---

## Template + Pre-chart pipelines

All three operations (template create, template update, pre-chart edit-note) share the same single-flight job lock and `.template_job.json` persistence. The lock is owned by `ctx.stores.jobs` (the job runner — `jobs/jobRunner.js`); each operation is a **descriptor** in `src/jobs/{templateCreate,templateUpdate,prechart}.js` executed by `runJob(descriptor, input, ctx, extra)` in `src/jobs/jobDispatcher.js`. `runJob` acquires the lock synchronously before the first `await`, registers an `AbortController` so `cancel-template-creation` can SIGTERM the run, calls `ctx.llm.runSkill(...)`, and releases the lock in a `finally`. The old `templateJobProc` global is gone. The job object has a `type` field (`'create'`, `'update'`, or `'prechart'`) so the renderer banner shows the right text. Only one of these jobs can run at a time (`ctx.stores.jobs.isRunning()` guard in the IPC handlers).

**Create:**
```
User           Renderer                Main                            Claude CLI (skill)
 │               │                      │                                │
 │ Templates tab │                      │                                │
 │ pick files,   │ startTemplateCreation│                                │
 │ enter name ──▶│ ──IPC──────────────▶ │ stage files into               │
 │               │                      │ <NOTES>/templates/_staging/<x>/│
 │               │                      │ runJob(templateCreate, …)      │
 │               │                      │   onRunning → broadcast        │
 │               │                      │     {type:'create',running}    │
 │               │                      │ ctx.llm.runSkill ─────────────▶│ create-doctor-profile
 │               │                      │   --model opus-4-8             │   reads staging
 │               │ ◀─template-job-status│   effort=max                   │   analyses N notes
 │ banner shown  │                      │                                │   writes <lastname>.md
 │               │                      │ on close + file exists:        │
 │               │                      │   register doctor in settings  │
 │               │                      │   delete staging               │
 │               │                      │   broadcast {status: 'success'}│
 │               │ ◀─template-job-status│                                │
 │ banner ✓      │                      │                                │
```

**Update:**
```
User           Renderer                Main                            Claude CLI (skill)
 │               │                      │                                │
 │ pick doctor,  │ startTemplateUpdate  │                                │
 │ type fixes ──▶│ ──IPC──────────────▶ │ resolve templatePath           │
 │               │                      │   from settings.json           │
 │               │                      │ runJob(templateUpdate, …)      │
 │               │                      │   onRunning → broadcast        │
 │               │                      │     {type:'update',running}    │
 │               │                      │ ctx.llm.runSkill ─────────────▶│ update-doctor-profile
 │               │ ◀─template-job-status│                                │   verify file exists
 │ banner shown  │                      │                                │   backup → backups/
 │               │                      │                                │   read full template
 │               │                      │                                │   apply surgical edits
 │               │                      │                                │   write back in place
 │               │                      │ on close (code 0):             │
 │               │                      │   broadcast {status: 'success'}│
 │               │ ◀─template-job-status│                                │
 │ banner ✓      │                      │                                │
```

**Pre-chart (edit-note):**
```
User           Renderer                Main                            Claude CLI (skill)
 │               │                      │                                │
 │ Record tab    │                      │                                │
 │ click         │ showPrechartView()   │                                │
 │ Pre-chart     │ list recent cases    │                                │
 │ pick case,    │                      │                                │
 │ type instr,   │                      │                                │
 │ add files ──▶ │ startPrechartJob ──▶ │ resolve template from          │
 │               │                      │   *_soap_note.md "**Doctor:**" │
 │               │                      │ attachments.js combine ──▶     │
 │               │                      │   write tmp combined.md (Node) │
 │               │                      │ runJob(prechart, …)            │
 │               │                      │   onRunning → broadcast        │
 │               │                      │     {type:'prechart',running}  │
 │               │                      │ ctx.llm.runSkill ─────────────▶│ edit-note
 │               │ ◀─template-job-status│   --model soapModel            │   backup soap note
 │ banner shown  │                      │   effort=high                  │   read template+note
 │               │                      │                                │   integrate attachment
 │               │                      │                                │   re-enforce template
 │               │                      │                                │   overwrite *_soap_note.md
 │               │                      │ onSuccess (code 0):            │
 │               │                      │   delete tmp combined.md       │
 │               │                      │   re-run ICD + docx (soap)     │
 │               │                      │   broadcast {status: 'success'}│
 │               │ ◀─template-job-status│                                │
 │ banner ✓      │                      │                                │
```

The user picks 1+ files in the picker; `src/pipeline/attachments.js` (Node — as of Phase 5) concatenates their text in-process (handling `.md`/`.txt` directly, `.docx` via `mammoth`, `.pdf` via `pdf-parse`) into a single `prechart_<ts>.md` in OS temp — no Python child (`python/extract_attachments.py` was deleted). That single path is what the skill receives as `Attachment:` — the skill itself only ever processes one attachment, matching its existing contract.

`.template_job.json` (owned by `ctx.stores.jobs` / `jobs/jobRunner.js`) ensures:
- popup can close/reopen and still see status
- one job at a time (`ctx.stores.jobs.isRunning()` guard)
- stale `running` from a crash is cleared on next launch

---

## Audio-upload pipeline (alt path)

If the user uploads an existing audio file instead of recording:

1. `browse-audio-file` → file picker → user picks `.mp3/.wav/.m4a/.ogg/.flac/.mp4`
2. `process-audio-file(path, name)` → file copied into a new case folder (no record.py involved)
3. From there, identical pipeline: `spawnTranscription → spawnSoapGeneration → runCaseChain (ICD → CDI → docx)`

Both flows funnel through `src/pipeline/ingest.js → ingestAudio`, which copies/renames the audio into the case folder and probes its duration (shared core for `stop-recording` and `process-audio-file`). `spawnTranscription` (`src/pipeline/transcription.js`) is the joining point of both flows — it transcribes via Node ElevenLabs and, on success, fires its `onSuccess` (SOAP gen) and `spawnDocx` (transcript.docx) callbacks. Don't bake recording-specific assumptions into it.

**In-recording Pre-chart.** The scribe can open a Pre-chart screen (a sub-view of the Record tab — see `renderer/views/prechartCapture.js`) to type context and attach `.md/.txt/.docx/.pdf` files — reachable from the recording action row (RECORDING/PAUSED) **and** from both patient-name forms (post-recording and upload), so context can be added even if it was forgotten during recording or for an uploaded file. The screen is a **pure overlay**: it hides whatever controls are visible and restores them on close, never re-rendering the record state — so the recording timer keeps running (the v1 bug was a re-render calling `timer.start()`). Opening it from the post-recording name form pauses that form's 30s auto-save countdown. The capture is held in `recorderController` (`save-prechart-context`/`get-prechart-context` IPC, saved on every change so it survives window hide/show). At `stop-recording`/`process-audio-file` the text + extracted attachments are combined by `buildPrechartTempFile()` (`src/pipeline/attachments.js`) into a temp `.md`, passed to `ingestAudio` as `prechartSrc`, and written into the case folder as `prechart.md`. On the API note-gen path, `generateSoapViaApi` reads `prechart.md` and `buildSingleCallNoteGen` injects a `PRE-CHART CONTEXT` block into every note-gen call (single + multi-patient fan-out) via `prechartText`. A single skill, `generate-note-api`, handles both cases — its `PRE-CHART CONTEXT` rule is optional and engages only when the block is present. The CLI/agentic path ignores it.

---

## Audio capture (record.py)

Single Python file, two platform branches selected by `sys.platform`.

| Platform | Library | Mechanism | Sample rate |
|---|---|---|---|
| Windows | `pyaudiowpatch` | WASAPI loopback on the default output device | Native (44.1 / 48 kHz), downsampled to 16 kHz on MP3 export |
| macOS   | `sounddevice` | Reads from BlackHole virtual device (must be installed and in a Multi-Output Device) | 48 kHz native |

Both branches:
- Write PCM frames into a WAV in a temp file as audio arrives
- Listen for `stop` / `pause` / `resume` lines on stdin (a thread reads stdin, sets events)
- On `stop`: flush the WAV, convert to MP3 via `pydub` (requires `ffmpeg` on PATH), delete WAV, exit 0
- On unexpected error: print `ERROR: ...` to stderr → main surfaces it as a setup-warning IPC

`--list-devices` mode prints JSON of the loopback / input devices and exits — used by the Settings advanced panel.

---

## Skills integration (the `notes-claude` → `<NOTES_DIR>/.claude` sync)

This is the most non-obvious part of the app.

```
repo/notes-claude/                       ← source of truth, version-controlled
  skills/
    generate-note/SKILL.md
    create-doctor-profile/SKILL.md
    update-doctor-profile/SKILL.md
    edit-note/SKILL.md
    add-icd-codes/SKILL.md
    cdi-review/SKILL.md
  standards/                              ← consumed by cdi-review
  .mcp.json, settings.json
                  │
                  │  copyDirSync on every app start (skills + standards)
                  │  writeMcpConfig writes <NOTES_DIR>/.mcp.json
                  ▼
~/Documents/AI Medical Notes/.claude/    ← runtime workspace for `claude -p`
  skills/... + standards/...
```

When the app runs a skill via `ctx.llm.runSkill(...)` (`src/llm/claudeCliProvider.js` — `claude -p`, arg-array spawn, `shell:false`), the cwd is set to `<NOTES_DIR>` (the AI Medical Notes folder, not the repo). The `claude` CLI auto-discovers `<cwd>/.claude/` and loads the skills there. Prompts are assembled by `src/llm/skill-io/prompts.js → buildPrompt(skillId, input)`.

Implications:
- Edit skills in `notes-claude/`, never in `<NOTES_DIR>/.claude/` — your edits will be overwritten on next launch.
- Adding a new skill = drop a folder into `notes-claude/skills/`. The next app launch copies it.
- The auto-update flow (`git pull`) re-syncs after pulling new code.

Prompt formats the skills expect:
- `generate-note`: `generate a note using template "<rel>" and transcript "<rel>"`  *(or omit template to fall back to doctor lookup)*
- `create-doctor-profile`: `create a doctor profile for "<name>" from source folder "<rel>"`
- `update-doctor-profile`: `update doctor profile. Doctor: <name>. Template: <abs-path>. Corrections: <text>`  *(path is absolute; multi-line corrections are collapsed to ` | ` separators)*
- `edit-note` (pre-chart): `edit note. Case: <abs-case-dir>. Template: <abs-template-path>. Attachment: <abs-attachment-path-or-empty>. Instructions: <scribe-text-or-empty>`  *(at least one of Attachment/Instructions must be non-empty; multi-file attachments are pre-combined by `src/pipeline/attachments.js`)*
- `add-icd-codes`: `add ICD codes. Soap note: "<rel-or-abs-soap-md-path>".`  *(emits `ICD_OK` / `ICD_SKIPPED` / `ICD_ERROR` on stdout)*
- `cdi-review`: `review cdi. Case: <abs-case-dir>. Specialty: <name>. Mode: <balanced|compliance|aggressive>. Doctor: <name>. Standards: <abs-standards-dir>`  *(emits a JSON manifest as the last line)*

The first two use paths relative to cwd (= `<NOTES_DIR>`). The remaining prompts use absolute paths because they're already resolved before `buildPrompt` is called.

---

## File system layout (runtime)

```
<NOTES_DIR>/                                    e.g. ~/Documents/AI Medical Notes
├── settings.json                               app + user-editable (doctors[] migrated to app.db on first launch)
├── app.db                                      SQLite metadata store — doctors, sessions, cases, processing_events
├── app.db-wal / app.db-shm                     WAL journal (auto-managed; safe to delete when app is closed)
├── settings.doctors.backup.json                one-time backup of doctors[] at migration (hand-recovery only)
├── .template_job.json                          live + last-finished template job
├── app.log                                     append-only diagnostic log
├── .claude/                                    synced from repo notes-claude/
│   ├── skills/...
│   └── standards/                              cdi-review consumes these at runtime
├── .mcp.json                                   project-scope MCP config (ICD-10 connector)
├── Cases/
│   └── <patient>_<YYYY-MM-DD>/
│       ├── <patient>.mp3                       (or recording.mp3 if name skipped)
│       ├── prechart.md                         in-recording pre-chart context (if any; Windows: hidden) — fed into note gen
│       ├── transcript.md                       diarised, by speaker
│       ├── transcript.docx                     auto-converted
│       ├── <case>_soap_note.md                 SOAP note from skill (with ## ICD-10-CM Codes table appended)
│       ├── <case>_soap_note.docx               auto-converted (primary deliverable)
│       ├── <case>_cdi.json                     CDI review — canonical structured output (Windows: hidden)
│       ├── <case>_cdi.md                       CDI review — rendered from JSON (Windows: hidden)
│       └── <case>_cdi.docx                     CDI review — auto-converted (visible)
├── templates/
│   ├── <lastname>.md                           per-doctor template
│   ├── _staging/                               transient — used during AI template creation
│   └── backups/
│       └── <lastname>_backup_<YYYYMMDD_HHMMSS>.md   timestamped backup created before each AI update
└── (folder picked at install time wraps all the above)
```

```
<repo>/                                         the cloned source dir
├── .env                                        ELEVENLABS_API_KEY, NOTES_DIR_PATH
├── notes-claude/                               source of truth for skills
├── main.js, preload.js, renderer/, python/
└── docs/, CLAUDE.md, README.md
```

`NOTES_DIR_PATH` lives in repo `.env` so the user can move the notes folder without losing app state. `settings.json` lives **inside** notes-dir so it travels with the data.

---

## State machine details

States: `IDLE`, `SESSION_ACTIVE`, `RECORDING`, `PAUSED`, `PROCESSING`.

```
       ┌──────────────────────── stop-session ─────────────────────────┐
       │                                                               │
       ▼                                                               │
  ┌────────┐  start-session   ┌──────────────┐  start-recording   ┌──────────┐
  │  IDLE  │ ───────────────▶ │SESSION_ACTIVE│ ─────────────────▶ │RECORDING │
  └────────┘                  └──────────────┘                    └──────────┘
                                    ▲   ▲                            │  ▲
                                    │   │                       pause│  │resume
                                    │   │                            ▼  │
                                    │   │                          ┌─────────┐
                                    │   │                          │ PAUSED  │
                                    │   │                          └─────────┘
                                    │   │                            │
                                    │   │                            │ stop-recording
                                    │   │                            ▼
                                    │   │                       ┌────────────┐
                                    │   └─── (name resolved) ─── │ PROCESSING │
                                    │                            └────────────┘
                                    │
                                    └─ (also: discard, save-with-name, auto-record next)
```

`PROCESSING` is brief — it covers only the patient-name form. As soon as the user submits, the case folder is built, transcription is spawned, and state returns to `SESSION_ACTIVE`. The pipeline that follows is invisible to the state machine.

`PAUSED` reuses the same record.py child held in `ctx.stores.recorder` (`context/recorderController.js`) — `pause`/`resume` are `pause\n`/`resume\n` stdin commands the Python side acts on (it stops appending frames to the WAV until resume). This is why a pause+resume gap doesn't show up in the recording.

Rendered identically in main.js and the renderer — the renderer's `viewRouter` (`renderer/app.js`) decides which view is mounted by current `STATE`, and each view decides which buttons are visible.

---

## IPC and event channels

Source: [preload.js](../preload.js). Renderer → main are `invoke`/`handle`; main → renderer are `send`/`on`.

Renderer → main (request/response):
- Lifecycle: `start-session`, `stop-session`, `start-recording`, `stop-recording`, `pause-recording`, `resume-recording`, `discard-recording`, `submit-patient-name`
- Doctors: `get-doctors`, `add-doctor`, `update-doctor`, `update-doctor-template`, `update-doctor-specialty`, `remove-doctor`, `select-doctor`
- Templates tab (create): `browse-notes-files`, `start-template-creation`, `get-template-job-status`, `cancel-template-creation`, `dismiss-template-job`
- Templates tab (update): `start-template-update` (takes typed corrections + optional corrections file + optional extra sample notes), `browse-corrections-file`, `get-doctors-with-templates`
- Pre-chart: `browse-prechart-files`, `list-recent-patient-cases`, `browse-patient-case-folder`, `start-prechart-job` (status uses the shared `get-template-job-status` / `template-job-status` channel)
- In-recording Pre-chart capture: `save-prechart-context`, `get-prechart-context` (context for the live recording → `recorderController` → `prechart.md`)
- Audio upload: `browse-audio-file`, `process-audio-file`
- Config: `get-state`, `get-build-info` (`{isStaging, version, gitSha}` — drives the STAGING badge), `get-config-status`, `get-elevenlabs-key`, `save-elevenlabs-key`, `get-settings`, `save-settings`, `list-audio-devices`, `get-notes-dir`, `change-notes-dir` (now accepts an optional mode)
- Status window: `get-session-recordings`, `open-status-window`, `close-status-window`
- Open output: `open-soap-note(filePath)` — opens the SOAP `.docx` in the OS default handler
- Window: `hide-window` (minimizes the main window)

Main → renderer (events):
- `state-change` — fires on every `setState`
- `show-patient-form` — fires inside `stop-recording` after the Python child exits
- `setup-warning` — BlackHole missing, Claude CLI missing, record.py errors
- `service-warning` — ElevenLabs API errors, Claude usage limits
- `auto-start-recording` — fired after `stop-recording` completes if `autoRecord` setting is on
- `pick-doctor` — fires on `start-session` if more than one doctor configured
- `template-job-status` — fires on every state change of a template-creation, template-update, or pre-chart job (carries `type` field)
- `recording-status-update` — drives the optional floating status window with per-case pipeline stage (recording → transcribing → soap → icd → docx → done)

---

## Single-instance and lifecycle

`app.requestSingleInstanceLock()` — second launches focus the existing window and exit.

**Close-to-minimize.** Clicking the window close button minimizes the window instead of quitting. Only the tray menu's "Quit" or `before-quit` actually exits. An `isQuitting` flag gates `win.on('close', …)` to decide whether to preventDefault.

**Quit path:** tray → Quit → `before-quit` handler sets `isQuitting = true`, kills the record.py child via `ctx.stores.recorder` so the temp WAV doesn't linger, and lets Electron tear down.

**macOS:** `app.dock?.hide()` keeps the dock icon hidden — the app still has a tray icon and a window, but it doesn't clutter the dock. (The window itself is normal — taskbar/dock behaviour differs from Windows where the window does appear in the taskbar.)

---

## Windows file hiding (`attrib +h`)

To keep the notes folder presentable to non-technical users on Windows, the app hides files the user doesn't need to see:

- **Inside `<NOTES_DIR>`** — every entry except `Cases/` is hidden (so `.claude/`, `.mcp.json`, `settings.json`, `app.log`, `.template_job.json`, and the `templates/` folder don't show by default).
- **Inside each case folder** — every `.md` file is hidden, leaving only the `.mp3` audio and the `.docx` finals visible. The `.md` files still exist (the skills read them) — they're just hidden from the user.

Helpers: `hideFileFromUser(path)`, `hideNotesDirInternals()`, `hideExistingCaseMdFiles()`. All no-op on non-Windows platforms. New `.md` files generated by the pipeline are hidden on write.

---

## Auto-update

`checkForUpdates(ctx, deps)` lives in `src/update/autoUpdate.js` and is wired in from `startup/bootstrap.js` (which `main.js` injects with `{ appRoot, copyDirSync, writeMcpConfig }`). It runs on every launch:
1. `git pull --ff-only` in the repo working tree
2. If output is `Already up to date.` → done
3. Otherwise re-run the `notes-claude → <NOTES_DIR>/.claude` sync **and** rewrite `.mcp.json` (via `writeMcpConfig`), so updated skills + MCP config are immediately available
4. `runPostUpdateSetup()`: `npm install --no-audit --silent` (picks up new/changed deps) then `electron-rebuild -f -w better-sqlite3` (recompiles the native module for this Electron ABI). Failure here is logged but non-fatal; a startup safety net shows a recovery dialog if the user restarts before the rebuild finished.
5. Set tray tooltip + OS notification: "restart to apply"

Failures (no git, conflicts, network, npm/rebuild errors) are logged and ignored. The app never blocks on this.

> The whole git-pull model is slated to be replaced by `electron-updater` in Phase 6; `autoUpdate.js` is isolated so that swap is a single-file change.

The pull is branch-agnostic — whatever branch the clone is on. User installs (`install.ps1`) clone `main`; staging installs (`install-staging.ps1`) clone `staging` and write a local `.staging-marker` that flips the UI badge and prefixes tooltip / notification titles with `(staging)`. See CLAUDE.md → *Branching + release flow* for the promotion rules.

---

## DB schema overview

See [DB-SCHEMA.md](DB-SCHEMA.md) for column-by-column reference, FK diagram, and paste-ready debug queries.

SQLite database at `<NOTES_DIR>/app.db`. WAL mode, `better-sqlite3` in main process. All writes are `try/catch` — a failed write never breaks the pipeline.

| Table | Key columns | Written by |
|---|---|---|
| `doctors` | `id` (preserves settings.json ids), `name`, `lastname`, `template_path`, `specialty`, `enable_cdi` | `db/doctors.js` — upserted by `add-doctor`, `update-doctor`, `update-doctor-template`, `update-doctor-specialty`, and the `templateCreate` job's `onSuccess` |
| `sessions` | `id` (UUID), `session_folder`, `doctor_id`, `started_at`, `ended_at`, `case_count`, `failed_count` | `db/sessions.js` — inserted by `start-session`, updated by `stop-session`; counters bumped when cases reach terminal status |
| `cases` | `id` (UUID), `case_dir` (UNIQUE), `status`, `revision`, file paths, audio metadata, `cdi_*` columns | `db/cases.js` — inserted in `stop-recording`/`process-audio-file`; updated at each pipeline stage. `cdi_docx_path` is written by `src/pipeline/docx.js`; the rest of `cdi_*` is intended for `updateCaseCdi` but **see the regression note below**. |
| `processing_events` | `job_kind` (`transcribe`/`soap`/`icd`/`cdi`/`docx`/`prechart`/`template_create`/`template_update`), token columns, `cost_usd`, `duration_ms`, `backup_path` | `db/events.js` — `startEvent()` before each skill/spawn (in `engineRunner.js`, `jobDispatcher.js`, `transcription.js`, `docx.js`), `finishEvent()` on completion |
| `cdi_flags` | `case_id`, `cdi_run_id`, `flag_index`, `type`, `category`, `title`, `action` (imperative TL;DR), `body`, `guideline_reference`, `reimbursement_impact` (nullable), `current_code`, `suggested_codes` (JSON), `confidence`, `evidence_found` (JSON), `evidence_missing` (JSON) | `db/cdi_flags.js → insertFlags`. **Intended:** bulk-inserted on a successful CDI run, attached to the case row that owns the SOAP it flagged (never to multi-patient parent rows). ⚠️ **KNOWN REGRESSION (flagged 2026-06-09): not currently populated by the live pipeline** — `insertFlags` has no live caller (`cdi.persist()` is a no-op and `engineRunner` never calls `render()`). The on-disk `<case>_cdi.json` still has the full flag payload. See [DB-SCHEMA.md](DB-SCHEMA.md) §3.3. |

`cases.status` transitions: `transcribing → generating_note → converting → completed` (or `failed` at any stage). `cases.revision` starts at 1 and increments on each successful prechart. `processing_events.backup_path` is populated from the `BACKUP_OK: <path>` line printed by the edit-note skill.

Module layout: `db/init.js` (singleton + migration runner + doctor migration/restore), `db/withDb.js` (try/catch + null-db guard wrapper), `db/doctors.js`, `db/sessions.js`, `db/cases.js`, `db/events.js`, `db/cdi_flags.js`. Migrations are versioned SQL files in `db/migrations/` (`001_init.sql` … `004_extend_cdi_flags.sql`); `runMigrations()` applies any file whose `NNN` prefix exceeds the current `user_version`, **inside a `db.transaction(...)`** that `db.exec`s the SQL and then advances `user_version` itself — the runner strips each file's trailing `PRAGMA user_version = N;` line so the runner (not the file) is the single authority for the version bump. `python/db_helper.py` is scaffolded for future Python workers (not used in v1).

## Cross-cutting: error surfacing

| Error class | Where detected | Surfaced as |
|---|---|---|
| BlackHole missing | startup probe + record.py stderr | `setup-warning` IPC → yellow banner |
| ffmpeg missing | startup probe (warn-only) | `app.log` only |
| Claude CLI missing (`ENOENT`) | spawn error in soap/template | `setup-warning` IPC |
| ElevenLabs key invalid (401) | `ELEVENLABS_AUTH_ERROR` regex on transcribe error text (transcription.js) | `service-warning` IPC → orange banner |
| ElevenLabs quota (429) | `ELEVENLABS_RATE_LIMITED` regex on transcribe error text | `service-warning` IPC |
| Claude usage limit | `CLAUDE_RATE_LIMITED` regex on claude output | `service-warning` IPC |
| Recording process died unexpectedly | record.py exit handler in `ctx.stores.recorder` with a live child | state recovers to `SESSION_ACTIVE` |
| Template/prechart job orphaned by crash | startup check on `.template_job.json` (`ctx.stores.jobs`) | rewritten as `failed` |
| ICD MCP not authenticated / 401 | `engineRunner` regex (`MCP_AUTH_ERROR`) on icd output, `engine.id==='icd'` | `service-warning` IPC ("ICD-10 connector unavailable"; best-effort — pipeline still falls through to CDI and DOCX) |
| CDI skill non-zero exit / no usable output | `runEngine(cdi)` (`runResult.code !== 0` or `interpret()` returns no manifest) | run treated as failed; `service-warning` IPC; pipeline still falls through to DOCX |
| CDI rate-limited (Claude usage limit) | `engineRunner` regex (`CLAUDE_RATE_LIMITED`) on cdi output | `service-warning` IPC ("Claude usage limit reached") |
| CDI specialty unsupported / NULL | `cdi.gates()` short-circuits before the skill runs; OR skill emits `status:'skipped'` manifest | reported `skipped`; popup shows the skip reason; no warning IPC (not an error condition) |
| CDI manifest line missing / malformed | `parseSkillManifest` returns null or wrong shape | `cdi.interpret()` falls back to reading on-disk `<case>_cdi.json` (`synthesizeManifestFromDisk`); if usable, recovers the run to `status:'ok'`; if not, treated as failed |

Adding a new failure mode? Pick `setup-warning` (config issue, fix once) vs `service-warning` (runtime issue, may recover) and route accordingly.

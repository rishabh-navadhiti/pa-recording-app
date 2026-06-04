# 03 — Migration Plan

> How we get from [00-current-state](00-current-state.md) to [02-target-architecture](02-target-architecture.md) without breaking the scribes on `main`. Per [decisions](07-open-questions-and-decisions.md): **bolder, larger-chunk extractions are fine (AI does the work) as long as each landed change is behavior-preserving and verified before it reaches production.** "Big but safe."
>
> This is an ordering + risk-gating plan, not a task list. Each phase says *what moves, why now, how we know it's safe, and the prod risk.* The implementer sequences PRs within a phase.

---

## Operating rules (apply to every phase)

1. **Behavior-preserving by default.** A phase moves/renames/encapsulates code; it does not change what the pipeline produces — unless a fix is the explicit point of that change (the Phase-0 safety bugs). When in doubt, the output `.docx`/`.md`/DB rows for a real case must be identical before and after.
2. **Ship through the existing flow.** Each phase is one or a few PRs into `develop`, promoted `develop → staging → main` per the rules in CLAUDE.md. **No giant long-lived `refactor/*` branch** — that recreates exactly the `icd10-coding`-vs-`develop` divergence pain the team already hit. Keep `main` shippable at every step.
3. **Two gates before production, every phase:**
   - **Automated:** the unit/integration suite (built in Phase 0) is green in CI.
   - **Manual real-case smoke** (rish, on a real machine): run the per-phase checklist below; confirm a single-patient *and* a multi-patient recording still produce identical SOAP/ICD/CDI/docx + DB rows.
   - Then a **staging soak**: sit on `staging` long enough for at least one auto-update cycle to fire on a dev install before `staging → main` (existing rule).
4. **Rollback = revert the phase's merge.** Because phases are behavior-preserving and shippable independently, a regression found on staging is a `git revert` of that phase's merge commit, not a forensic untangle.
5. **Protect the data.** Any change touching the DB schema, on-disk layout, or the notes-dir must preserve or migrate existing data. Users received `app.db` on `main` only yesterday (at `user_version=4`); migration hardening must be backward-compatible with those installs.
6. **Docs in the same PR.** Update CLAUDE.md / ARCHITECTURE.md / DECISIONS.md as code moves (the repo's standing rule). Append a DECISIONS entry per phase explaining the seam introduced.

---

## Dependency order (why this sequence)

```
Phase 0  Foundations & safety        ── unlocks testing + single-sources enums + un-nests the file
   │                                    (no behavior change; high value; near-zero risk)
   ▼
Phase 1  Context & state (kill globals) ── the unlock: makes everything downstream testable/injectable
   │
   ▼
Phase 2  LLM seam + contracts + ENGINE FRAMEWORK  ── the strategic core (provider-agnostic; engines drop in)
   │
   ▼
Phase 3  Pipeline + jobs + IPC + startup + windows ── modularize the orchestration on top of the seams
   │
   ▼
Phase 4  Renderer modularization      ── views/components/router on the now-clean IPC contract
   │
   ▼
Phase 5  Python restructure           ── package + CLI; bundle-ready; mac record.py hardening
   │
   ▼
Phase 6  Distribution program         ── electron-builder + updater + signing + bundled runtimes + TypeScript
   │        (can begin in parallel after Phase 1; config-to-userData depends on Phase 1's paths/secrets)
   ▼
Phase 7  macOS first-class            ── fill in the platform seam's mac branches end-to-end
```

Phases 0→1→2 are the spine: testing first, then kill the globals, then the engine framework. After that the order is flexible; 3/4/5 are largely independent and 6 can overlap.

---

## Phase 0 — Foundations & safety

**Goal:** make the codebase testable and safe to refactor, with zero pipeline behavior change (except the safety-bug fixes, which are intended).

**What moves / lands:**
- **Test harness** (`tests/unit`, `tests/integration`, `tests/fixtures`), `node:test` runner, `"test"` script, GitHub Actions CI running `npm run test:unit` on system Node. Port the existing `parseSkillManifest.test.js` in.
- **DB-migration hardening** (safety bug #6): wrap each migration in a transaction; drive `user_version` from the runner (tolerate the trailing PRAGMA in existing files); surface failures with the filename. **Backward-compatible with `user_version=4`.** Add a `db/withDb.js` wrapper and make `getDb` injectable (`:memory:` seam).
- **The safety bugs** (01 §"Safety bugs"): guard the ~5 `win.webContents.send` sites (interim, before the renderer facade); confine `open-soap-note` to `CASES_DIR`; fix the inline `python -c` injection in `process-audio-file` (use a small script or proper arg-encoding). Also delete the misleading "Run each migration in a transaction" comment in `db/init.js` (the code does not open one — the comment is aspirational and will mislead future readers). *(Shell-injection in `spawnClaude` is fixed properly in Phase 2 with the arg-array provider; if it can be made safe sooner cheaply, do it here.)*
- **`src/shared/`**: extract `STATE`, `ipc-channels` (CHANNELS map), `pipeline-status` (stage enum+labels+classes), `specialties`. Wire main + renderer + preload to the single source. **Add the drift test** (preload channels ⊆ registered handlers; renderer STATE == main STATE).
- **`src/llm/skill-io/manifest.js`**: move `parseSkillManifest.js` here, add `validateManifest`, expand its test suite.
- **Un-nest the single-instance `else` block** (mechanical: convert to early-return guard so `whenReady` + handlers are top-level) — its own commit, no behavior change. This is the prerequisite for all later extraction.
- **Delete dead code:** `python/db_helper.py`, `notes-claude/draft/`, `notes-claude/scripts/md_to_docx.py`, `launch.vbs`. Re-baseline doc drift (`scribe_v1`→`v2`, IPC table).

**Why now:** you can't safely do big chunks without a net. The harness + migration hardening + single-sourced enums make every later phase verifiable and removable.

**Safety gate:** full suite green; real single+multi-patient case identical; **migration replay test** from a seeded `user_version=4` fixture DB passes; staging soak.

**Prod risk:** LOW (mostly additive + mechanical), except the migration-runner change — gate that on the replay test specifically.

---

## Phase 1 — Context & state (kill the globals)

**Goal:** replace the ~18 mutable globals with an injected `AppContext` + small stores. *The* unlock for testability. Larger chunk, but mechanical and behavior-preserving.

**What moves:** `context/appContext.js`, `stateMachine.js`, `sessionStore.js`, `recordingsStore.js`, `recorderController.js`; `config/paths.js`, `settings.js`, `secrets.js` (file-backed for now), `jobState.js`, `mcp.js`; `platform/` interface + `windows.js`/`macos.js`; `log/logger.js`; the guarded `renderer.send()` facade. Thread `ctx` into existing functions (they keep their logic; they stop reading globals). Move the two cross-handler promise resolvers into explicit pending-request methods on their controller/store.

**Why now:** everything downstream (engines, pipeline, IPC) needs `ctx` to be testable. Doing it as one coherent chunk avoids a long awkward half-globals state.

**Safety gate:** the stores get real unit tests (recordings roll-up to completed/failed, serialize, session transitions) — proving the extraction. Real single+multi-patient case identical (this is the highest-attention manual check of the program — the recording path is production-critical). Staging soak.

**Prod risk:** MED — it touches the live recording path. Mitigate: land `recorderController` (the stdin-stop protocol, Decision #1) as its own commit with an integration test before the rest; keep each store's behavior byte-identical.

---

## Phase 2 — LLM seam + contracts + engine framework (the strategic core)

**Goal:** the provider-agnostic LLM seam + the engine abstraction. After this, adding an engine and swapping the model provider are both local changes.

**What moves:** `llm/provider.js` + `claudeCliProvider.js` (arg-array spawn, **no `shell:true`** — this is where the injection bug dies) + `childRunner.js` + `usage.js`; `llm/skill-io/prompts.js` + `markers.js` + `manifest.js` (single rate-limit/MCP source; the manifest parser + its **must-preserve on-disk `_cdi.json` fallback**); `engines/engineRunner.js` + `registry.js` + `soap.js`/`icd.js`/`cdi.js` descriptors; `pipeline/chain.js` (single + multi, with `completesCase`). Migrate the skills to the JSON-manifest envelope in lockstep (retire `ICD_OK:`/free-prose/`Updated:`), and move the embedded CDI renderer to `python/render_cdi.py`. Clean repo-internal leakage from `notes-claude/`.

**Why now:** it sits directly on Phase 1's `ctx`. It's the centerpiece for the PA roadmap and the provider migration you're planning — building the seam now lets you defer the vendor choice without blocking.

**Safety gate:** heavy unit tests on the pure pieces (gates, buildInput/prompt round-trip, interpret incl. CDI filesystem-fallback, the marker regexes, chain ordering). **Byte-identical output** on real single+multi-patient cases — this phase rewrites the heart of the pipeline, so diff the produced `.md`/`.docx`/`cdi.json`/DB rows against a pre-phase baseline. Verify token-logging (`processing_events`) still records identically. Staging soak (longer than usual).

**Prod risk:** MED–HIGH — it reimplements the engine path and changes skill output contracts. Mitigate: one engine at a time behind the runner (soap → icd → cdi), each verified before the next; keep the old `spawnXxx` as a fallback branch until its descriptor is proven, then delete. The skill-contract change ships in the same PR as its consumer (one bundle, no skew).

---

## Phase 3 — Pipeline + jobs + IPC + startup + windows

**Goal:** modularize the orchestration now that the seams exist.

**What moves:** `pipeline/ingest.js` (dedup `stop-recording`/`process-audio-file`), `pipeline/transcription.js` (the transcribe step, extracted from `ingest`), `multiPatient.js` (split the 207-line function into pure `planChildCases` + io `materializeChild`), `caseStatus.js`, `artifacts.js`; `jobs/jobRunner.js` + the 3 job descriptors (dedup the ~70%-identical spawn functions, generic job state); `ipc/` per-domain registrars + `envelope.js` (validation + `{ok,error}`); `startup/bootstrap.js` + `bootstrapNotesDir.js` (dedup `whenReady` vs `change-notes-dir`); `windows/` + `tray.js` factories; `update/autoUpdate.js` (extract; still git-pull until Phase 6).

**Why now:** depends on `ctx` (Phase 1) and the engine chain (Phase 2). Mostly mechanical once those exist.

**Safety gate:** unit tests for `planChildCases`, `resolveDoctor`, ingest, envelope/validation, jobRunner (lock rejects 2nd start; cancel finishes event before kill). Real-case smoke across recording, upload, prechart, template create/update. Staging soak.

**Prod risk:** MED — `ingest` and the IPC envelope touch core flows and the renderer contract. Mitigate: keep IPC return shapes compatible (compat shim) so the renderer doesn't need to change in the same PR; land `ingest` behind the proven recorder path.

---

## Phase 4 — Renderer modularization

**Goal:** turn `renderer.js` into a `viewRouter` + per-view modules + shared components on the cleaned IPC contract.

**What moves:** `renderer/app.js` (router), `views/*`, `components/fileListField.js` + `timer.js` + `confirmDialog.js`, `ipc/client.js`. Single visibility mechanism. Shared constants via preload. Generic status panel (`reviews[]` instead of flat `cdi*`). Engine→UI manifest hooks for future per-engine toggles.

**Why now:** depends on the single-sourced `shared/` (Phase 0) and the stable IPC contract (Phase 3). Independent of Python/distribution.

**Safety gate:** jsdom unit tests per view (mount/update, file-list, job-banner status→DOM, doctor-list edit). Manual click-through of every screen. Staging soak.

**Prod risk:** MED — it's the whole UI; do it screen-by-screen behind the existing IPC so a regression is one view, not the app.

---

## Phase 5 — Python restructure

**Goal:** make the Python layer a tidy, testable, bundle-ready package.

**What moves:** `python/scribe/{audio,transcribe,docx,attachments}.py` + a thin `cli.py` (argparse subcommands); pure functions (`format_transcript`, `convert_md_to_docx`, `extract_one`, device-matching, path derivation) become importable + `pytest`-tested; centralize the stdout contracts (`protocol.py` mirrored by a Node `contract.js`); fix `transcribe.py`'s hardcoded `LOG_DIR`; harden mac `record.py` (0-frames guard, stop-in-callback); kill the runtime `pip install`. `render_cdi.py` already landed in Phase 2.

**Why now:** independent of 1–4; prerequisite for clean bundling in Phase 6. (The optional Node-port of transcribe/extract/docx — shrinking Python to just `record.py` — can be evaluated here or deferred to Phase 6; it reduces the bundled-runtime surface but risks docx-formatting regressions, so gate it on golden-file tests.)

**Safety gate:** `pytest` on the pure functions (golden ElevenLabs JSON → transcript; markdown → docx XML incl. tables/`<u>`/ALL-CAPS; attachment combine). Real recording on Windows *and* mac. Staging soak.

**Prod risk:** MED — `record.py` is the capture path; gate behind manual Win+Mac smoke.

---

## Phase 6 — Distribution program (electron-builder + real updates)

**Goal:** a signed installer + atomic auto-update; retire git-pull + user-side `electron-rebuild` + the 4 GB toolchain. Then adopt TypeScript (build now lives in CI). Full detail in [04-distribution-and-updates.md](04-distribution-and-updates.md).

**What lands:** electron-builder (NSIS) + `electron-updater` (GitHub Releases or S3/R2); `better-sqlite3` compiled on CI; bundled Python (python-build-standalone + pinned wheels) + ffmpeg; bundled `claude` CLI + in-app auth health-check; move config to `app.getPath('userData')` with a first-run migration that **reuses the existing `~/Documents/AI Medical Notes`**; Windows code signing (Azure Trusted Signing); `channel` setting replaces `.staging-marker` (beta vs latest); `migrate-to-packaged.ps1`. **Then:** convert JS+JSDoc → TypeScript.

**Why now:** depends on Phase 1 (paths/secrets to userData) and Phase 5 (bundle-ready Python). Can *start* in parallel after Phase 1 since most of it is build/CI infra orthogonal to code structure.

**Safety gate:** install the packaged build on a clean VM (Win); verify it adopts an existing notes folder with zero data loss; verify an end-to-end auto-update (publish → client updates on quit → relaunch works); run the `migrate-to-packaged.ps1` dry-run. The migration of real users is a scheduled ≤5-min call per [04](04-distribution-and-updates.md).

**Prod risk:** MED — it changes how users *get* the app. Mitigate: the NOTES_DIR is fully external to the install (no clinical data lost even on full reinstall); ship the packaged build to staging/beta first and run the dev migration before any user call.

---

## Phase 7 — macOS first-class

**Goal:** fill in the platform seam's mac branches end-to-end. See [06-macos-and-platform.md](06-macos-and-platform.md).

**What lands:** mac "hide internals" convention, Keychain secrets, `activate`/dock behavior, mac record.py polish (done in Phase 5), electron-builder DMG + `@electron/notarize` (Apple Developer $99/yr). Most of the code is already cross-platform by this point because the platform seam (Phase 1) and bundling (Phase 6) were built with mac in mind.

**Prod risk:** LOW for existing Windows users (additive); the work is making mac a shipped target.

---

## What we explicitly are NOT doing

- **Not** rewriting the skills' clinical logic — only their I/O contract (manifest envelope) and packaging (renderer→python file). The prompts that produce good notes are the product's IP; leave the medicine alone.
- **Not** choosing the LLM provider in this program — building the seam, deferring the vendor (your call, pending token data + testing).
- **Not** moving chart artifacts into the DB — files stay canonical.
- **Not** introducing a UI framework — hand-rolled view modules unless they strain.
- **Not** a single big-bang branch — phased PRs through the existing promotion flow.

---

## Sequencing summary

| Phase | Headline | Prod risk | Hard gate |
|---|---|---|---|
| 0 | tests + migration hardening + safety bugs + shared/ + un-nest | LOW | migration replay from `user_version=4`; suite green |
| 1 | AppContext + stores kill the globals | MED | recorder integration test; real case identical |
| 2 | LLM provider seam + engine framework | MED–HIGH | byte-identical output diff; per-engine cutover |
| 3 | pipeline + jobs + IPC + startup + windows | MED | IPC compat shim; all flows smoke |
| 4 | renderer view modules | MED | per-view jsdom tests; click-through |
| 5 | python package + bundle-ready | MED | pytest golden files; Win+Mac record |
| 6 | electron-builder + updater + signing + TS | MED | clean-VM install adopts notes dir; e2e update |
| 7 | macOS first-class | LOW | mac install + notarize + record |

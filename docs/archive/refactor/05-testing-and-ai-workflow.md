# 05 — Testing & the AI Dev/Debug Workflow

> The "make it AI-testable and AI-debuggable" goal, made concrete. Today ~85% of the logic is entangled with Electron/`child_process`/`fs`/globals and there is exactly **one** test file with no `"test"` script and no CI. This doc says what becomes testable after the refactor's seams land, the harness to use, and how a Claude session verifies a change in isolation. It does not replace manual testing — it lets AI catch the regressions that don't need a human, so the human testing focuses on what does.

---

## The core idea: pure core, thin I/O shell

Every seam in [02](02-target-architecture.md) exists partly to move a decision out of an Electron-bound closure into a **pure function** an AI can call with fixtures and assert on — no window, no SQLite file, no real `claude`, no real audio. The unavoidable I/O (spawn, fs, IPC delivery, BrowserWindow) stays in thin shells exercised by a small integration suite.

The codebase already has the proof: **`parseSkillManifest.js`** is pure, total (returns `null`, never throws), and covered by `tests/parseSkillManifest.test.js` — a zero-dependency harness with a custom `it()`/`assert` that exits non-zero on failure. That is exactly the loop we want everywhere: *AI writes a fixture + assertion, runs `node`, reads pass/fail.* The refactor generalizes that file from a lone example into the default.

---

## Harness

- **Runner: `node:test` + `node:assert`** (built into Node 18+). **Zero new dependencies**, runs under the Electron-bundled Node, matches the spirit of the existing test. **Avoid Jest/Vitest** — they pull a large dep tree, fight `better-sqlite3`'s native addon, and add config the project doesn't have. (`node --test --watch` and `--experimental-test-coverage` exist with no install if wanted later.)
- **Python: `pytest`** for the worker package (Phase 5), once `python/` is importable.
- **Structure:**
  ```
  tests/
    unit/          pure modules + :memory: DB tests (fast, no Electron, no network)
    integration/   migration replay, pipeline against temp dirs, contract round-trips, provider against fake childRunner
    fixtures/      sample manifests (the SINGLE_OK/MULTI_OK strings move here, shared), seeded user_version=4 DB,
                   golden ElevenLabs JSON, golden markdown→docx inputs, sample settings/doctors
  ```
- **`package.json` scripts** (only `start` exists today): add `"test": "node --test tests/unit tests/integration"`, `"test:unit": "node --test tests/unit"`, `"test:py": "pytest python/"`.
- **CI (none today):** a GitHub Actions workflow running `npm ci && npm run test:unit` (+ `pytest`) on push. **Native-addon caveat:** `better-sqlite3` must build for the **CI's system Node**, not Electron — fine, because no pure/DB-unit test needs Electron. Document that `npm test` uses the system-Node ABI.

---

## The seams that unlock testing (and what each makes testable)

| Seam (from [02](02-target-architecture.md)) | Unlocks (unit, no Electron) |
|---|---|
| **`db` getDb injectable** (`initDbWith(:memory:)`) | every `db/*` accessor against in-memory SQLite in **milliseconds**; migration 1→N replay on a seeded fixture; FK/cascade behavior |
| **`llm/skill-io/`** (prompts/markers/manifest) | prompt-builder ↔ skill-parser **round-trip**; marker-collision (corrections text containing `Samples:`); the 6 rate-limit regexes as one table; relative-path resolution; manifest parse (valid/fenced/prose-then-manifest/malformed→null) + per-engine `validateManifest` + the **on-disk `_cdi.json` fallback** when the result text is unparseable (e.g. a 429 ended the run) |
| **`childRunner` injectable** | every provider/engine `interpret` against **canned stdout/stderr** — rate-limit/MCP/duration parsing without a real subprocess |
| **`llm/provider` interface** | engines tested against a **fake provider** returning fixture `{text, manifest, usage}` — no real Claude, no tokens |
| **engine descriptors** (`gates`/`buildInput`/`interpret`/`render` pure) | each engine's gates (CDI's 3, ICD's enable flag), input building, result interpretation (incl. **CDI filesystem-fallback**), and status rendering — with a fake `ctx` |
| **`AppContext` + stores** | `recordingsStore` roll-up to completed/failed, `serialize()`, session transitions, `stateMachine` legal transitions — pure data |
| **`pipeline/multiPatient.planChildCases`** (pure) | slug/collision/skip-failed logic from a fake manifest + a `fileExists` predicate (the single most valuable unit hiding in the 207-line monster) |
| **`ipc/envelope` + CHANNELS** | arg-validation per channel; a **drift test**: preload channels ⊆ registered handlers, renderer `STATE` == main `STATE` |
| **renderer views + `ipc/client`** | per-view `mount/update` against jsdom + a mocked `api`; `fileListField`; `timer` (pure); job-banner status→DOM; doctor-list edit |
| **`platform` interface** | `computeStatusWindowBounds`, `resolvePython` (injected exec), `isStaging` (injected marker path), naming helpers (`sanitizeName`/`extractLastname`/`buildCaseFolder`) |

**Estimated shift:** from <15% pure today to the large majority of *decision* logic being unit-testable, with I/O confined to a small integration tier.

---

## What stays integration (and what stays manual)

- **Integration (headless, no Electron UI):** migration replay on a real on-disk DB; the full multi-patient FS materialization against a temp dir; the per-worker subprocess **contract tests** (spawn each Python worker with a fixture, assert the exact stdout markers + exit codes Node depends on — the highest-value integration layer); `bootstrapNotesDir` against a temp dir.
- **Electron integration (Playwright-for-Electron / smoke):** window open/minimize, tray clicks, IPC round-trip delivery, native dialogs, `before-quit`. A thin layer — most logic was pulled below it.
- **Manual (the human gate, unchanged in spirit):** the actual clinical quality of a generated note/CDI review (does it catch the Sabbag EMG gap, honor the doctor's template) — that's a judgment call requiring real cases and a person. Real audio capture on Windows + mac. The per-phase real-case smoke in [03](03-migration-plan.md). **AI testing reduces the manual surface to "did the medicine stay good" — it doesn't try to automate that.**

---

## How a Claude session verifies a change in isolation

The intended loop (what "AI-debuggable" means in practice):

1. **Touch one module** (e.g. add the Workers-Comp engine descriptor, or fix a CDI gate).
2. **Write/extend a unit test** beside it using fixtures from `tests/fixtures/` — call the pure function with a fake `ctx`/fixture manifest, assert the result. No app boot.
3. **Run `node --test tests/unit/<area>`** — read pass/fail directly. Iterate in seconds.
4. **For contract changes**, run the round-trip test (`buildPrompt` → `parseResult`) and the drift test (channels/STATE in sync).
5. **For pipeline changes**, run the integration test against a temp-dir fixture case and **diff the produced `.md`/`.docx`/DB rows against the committed baseline** — this is the behavior-preserving guarantee from [03](03-migration-plan.md), and it's automatable.
6. **Hand off to the human** only the things that need eyes: a real recording, clinical-quality judgment, the staging soak.

This is why the seams matter more than the tests themselves: a function that takes `ctx` and returns a value is one an AI can drive and assert; a closure that reads `NOTES_DIR`/`win`/`activeSessionId` and spawns a real `claude` is not.

---

## Golden-file / fixture strategy (the load-bearing test assets)

- **Manifests:** the `SINGLE_OK`/`MULTI_OK`/malformed strings currently inline in the test → `tests/fixtures/manifests/`, shared by manifest-parser and engine-interpret tests. Add one fixture per engine's manifest shape as engines land.
- **Seeded DB:** a `user_version=4` snapshot (the state real users are in *today*) so the migration-hardening change and every future migration are replay-tested against the actual production starting point — this is what protects the live scribes' `app.db`.
- **Golden case folders:** a small set of real-shaped case dirs (transcript + soap.md + a malformed/valid `_cdi.json`) for `interpret`/fallback/multiPatient tests and the byte-identical pipeline diffs.
- **Golden Python inputs:** ElevenLabs JSON → expected transcript; markdown (with tables/`<u>`/ALL-CAPS) → expected docx structure; attachment sets → combined output. These pin the formatting contract that all current + future engines emit into.
- **Fake-provider fixtures (per job):** curated real-derived `{text, manifest, usage, costUsd}` responses for each job — note-gen, ICD, CDI, template, prechart — so engine/pipeline tests run through `fakeProvider` with **zero tokens, zero network, deterministic output**. (rish will help curate these from real example runs.) The fixtures live in `tests/fixtures/llm/<job>/`.

### The fake provider + opt-in real runs

The provider seam (`ctx.llm`, see [02](02-target-architecture.md)) makes the LLM swappable in tests, not just in production:
- **Default in tests:** inject `fakeProvider`, which returns the per-job fixtures above. An engine test asserts on `interpret`/`persist`/`render` against a known response — no Claude, no cost, instant, repeatable. This is how the bulk of engine + pipeline logic gets verified.
- **Opt-in real runs:** a flag/env (e.g. `LLM_PROVIDER=cli` or a `--real` test flag) swaps in the real `claudeCliProvider`, so a dev can deliberately say "actually run CDI on this fixture case for real" — same test, same seam, real inference. Gate it behind an explicit opt-in so a normal `npm test` never spends tokens or needs `claude login`.
- This is the payoff of the seam: the fake is just another `provider.js` implementation; nothing in the engines knows or cares which one answered.

Pairs with **Playwright-for-Electron** for the renderer/IPC smoke layer (Claude also has a Playwright MCP that can drive the running app). Dev-on-Mac / test-on-Windows is fine — the code is platform-clean except `record.py` + file-hiding (the platform seam), so the same tests run on both; a Claude session can be spun up on the Windows box for on-device verification when needed.

---

## Sequencing (lands in [03](03-migration-plan.md) Phase 0, grows every phase)

- **Phase 0:** stand up the harness + CI; port `parseSkillManifest` test; add the DB `:memory:` seam + migration-replay test; add the channels/STATE drift test. *Nothing else can be verified safely until this exists.*
- **Every later phase ships its own tests** for the modules it extracts (the per-phase gate in [03](03-migration-plan.md) requires them). The suite grows with the refactor rather than as a separate effort — and by the time the engine framework lands (Phase 2), adding a future engine *includes* its unit tests as a matter of course (see the worked example in [02](02-target-architecture.md)).

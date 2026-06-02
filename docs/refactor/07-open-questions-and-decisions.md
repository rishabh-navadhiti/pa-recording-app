# 07 — Open Questions & Decisions

> The genuine forks in this refactor. **Part A** records decisions already made (by rish, this session) — treat them as settled unless revisited. **Part B** is the open questions the implementer or stakeholders still need to answer, each with a recommendation, ordered by how much they gate other work. As decisions land, move them from B to A and (for architectural ones) append to [../DECISIONS.md](../DECISIONS.md).

---

## Part A — Decisions made (settled)

| # | Decision | What it means | Made by / when |
|---|---|---|---|
| **A1** | **Bolder, larger-chunk refactors are OK — but safe.** | Because AI does the dev, we don't need tiny manual-sized PRs. Big, behavior-preserving extractions are fine *as long as* each landed change is verified and never breaks the live scribes. Parallel-vs-in-place layout is the implementer's call per subsystem (see [03](03-migration-plan.md)). | rish, 2026-06-02 |
| **A2** | **Vanilla JS + JSDoc now; TypeScript after packaging.** | Modularize in plain ESM JS with JSDoc typedefs + `node:test` while still on git-pull (no build step on user machines). Convert to TypeScript in Phase 6 once electron-builder puts the build in CI. JSDoc now is a down-payment on that conversion. | rish, 2026-06-02 |
| **A3** | **Build a provider-agnostic LLM seam; defer the vendor choice.** | Migration off the `claude` CLI is coming *soon* but the target is undecided (Anthropic org API key **or a different provider**) pending testing + more token data (DB shipped to `main` users only 2026-06-01). So we build the `llm/provider` interface now (CLI = first impl) and flip one line later. Don't commit to a vendor in this program. | rish, 2026-06-02 |
| **A4** | **Package + auto-update as a dedicated phase, Windows-first.** | electron-builder + electron-updater replace git-pull as a phase after core modularization; macOS is a clean later target via the platform seam. **A thin backend is acceptable** (future API-key broker + telemetry + feedback-loop). | rish, 2026-06-02 |

**Implications threaded through the docs:** A1 → [03](03-migration-plan.md) is phased-but-chunky with hard safety gates. A2 → [02 §tooling](02-target-architecture.md). A3 → [02 §LLM seam](02-target-architecture.md) + [04](04-distribution-and-updates.md). A4 → [04](04-distribution-and-updates.md) + [06](06-macos-and-platform.md).

---

## Part B — Open questions (need an answer before/at the relevant phase)

### Strategic (gate large work)

**B1 — LLM provider target & billing model.** *(Gates: when Phase 2's seam gets its second implementation; the whole billing story.)*
The seam (A3) defers *which* provider, but you'll still need to choose: **(a)** Anthropic org `ANTHROPIC_API_KEY` via Agent SDK/Messages API (per-token, org-paid, brokered by a thin backend), or **(b)** a different vendor, or **(c)** stay on per-scribe subscription CLI indefinitely. Research flagged real constraints: the Agent SDK requires API-key auth (Pro/Max OAuth not permitted as of Feb 2026) and subscription `claude -p` moves to a separate credit pool from June 2026 — so (a) changes billing from "scribe's subscription" to "org pays per token."
**Recommendation:** decide *after* you have token-volume data from the `main` rollout (you said the DB just shipped). Build the seam now regardless. When deciding, lean toward (a) with a key-broker backend *if* per-token cost at your volume is acceptable — it's the TOS-clean, centralized, testable path; keep (c) only as the fallback if cost data says otherwise. **This is a stakeholder/business call, not Claude's.**

**B2 — Engine completion & concurrency policy.** *(Gates: Phase 2 chain design.)*
Today `spawnDocxConversion(soap)` hard-codes "this completes the case." With N engines, which one flips the `cases` row to `completed` — a designated primary engine, or the chain after all engines finish? And should the engine runner own a **global concurrency-1 Claude lock** (like the current `templateJobProc`) so new engines inherit serial execution for free?
**Recommendation:** make `completesCase` a declared property on the engine descriptor (SOAP = true today); the chain marks completion when the primary engine's docx lands, independent of later best-effort engines. Yes to a runner-owned concurrency-1 Claude lock — it matches today's sequential-for-MCP/quota behavior and means a future "run engines in parallel" is one policy change, not an N-engine rewrite. **Note:** running engines in parallel (i.e. CDI + E/M + orders simultaneously) is a feature Fahd has explicitly asked for (`docs/pa-planning/02-feature-landscape.md` §Auto-Pilot). This is deliberately deferred — the concurrency-1 lock makes it a one-flag change when ready; the deferral is for MCP/quota reasons and sequential log-block readability, not a fundamental constraint.

**B3 — Per-engine DB schema convention.** *(Gates: the 2nd review engine's migration.)*
CDI added `cdi_flags` + 8 `cdi_*` columns. Does each future engine get its own `<engine>_findings` table + summary columns (mirrors `cdi_flags.js`, explicit but proliferating), or a **single generic `engine_findings` table** keyed by `engine` + a generic `case_engine_summary`?
**Recommendation:** decide when the 2nd review engine lands (likely SOAP-validator or E/M). Lean generic (`engine_findings` keyed by engine, JSON `data` for engine-specific fields, a few promoted common columns) — the roadmap is 8 engines; eight near-identical flag tables is the wrong shape. But don't pre-build it; let the 2nd engine force the abstraction so it's grounded in two real cases, not one.

### Architectural (implementer's call, but worth confirming)

**B4 — Sharing `src/shared/` constants with the renderer before a bundler exists.** Until Phase 6 brings a build step, the renderer can't `import` from `src/shared/`. Options: expose the enums via the preload bridge (`api.constants`), or a separately-`require`-able shared `.cjs`.
**Recommendation:** preload bridge now (`api.constants.STATE` etc.) + the drift test asserting equality; switch to direct import when TypeScript/bundler lands (A2). Low risk, removes the dual-declaration immediately.

**B5 — IPC return-envelope migration.** Standardizing on `{ok, error}` is clean, but a few channels return raw values today and the renderer ships in the same bundle as main (no version skew).
**Recommendation:** adopt the envelope behind `wrapHandler`, keep a thin compat shim for the handful of raw-return channels until the renderer migrates in Phase 4. Safe in one bundle.

**B6 — Skill output protocol unification scope.** Migrating `add-icd-codes` (`ICD_OK:`), `edit-note` (free prose), and `update-doctor-profile` (`Updated:`) onto the JSON-manifest envelope touches the production parsers on `main`.
**Recommendation:** do it in Phase 2, **skill + consumer in the same PR** (one bundle, no skew), one skill at a time, each verified on a real case before the next. The unification is what makes every future engine share one return channel — worth the care.

**B7 — `findRecentPatientCases` / status store: filesystem vs DB source of truth.** Several reads walk `Cases/` while the DB already indexes cases; `sessionRecordings` is an in-memory parallel truth lost on restart.
**Recommendation:** back recent-cases with the DB (it's populated for all post-DB cases); for pre-DB cases created on old `main`, keep a filesystem fallback for one release. Make `recordingsStore` rehydrate in-progress cases from `cases`/`processing_events` on startup so a restart doesn't blank the status window. Confirm the DB is reliably populated before removing the FS walk.

**B8 — Port the 3 non-audio Python workers to Node?** transcribe/extract/docx are easy Node ports (fetch POST; `mammoth`/`pdf-parse`; the `docx` npm) that would shrink the bundled runtime to just `record.py`.
**Recommendation:** evaluate in Phase 5, gated on **golden-file tests** for the docx renderer (it's load-bearing formatting that existing notes depend on). Lower long-term maintenance, but a real regression risk for the docx output — don't do it without the golden files. Default to "bundle Python" if the golden-file confidence isn't there.

### Product / UX (need a human answer)

**B9 — macOS "hide internals" convention.** Finder has no `attrib +h`. Dot-prefix files? A hidden subfolder? Nothing (show everything on mac)?
**Recommendation:** decide at Phase 7. Leaning: a single hidden `.app-internal/` subfolder for non-case files + dot-prefix nothing in case folders (mac users are likelier to tolerate seeing `.md` than Windows scribes) — but this is a UX call for whoever owns the mac experience.

**B10 — macOS window/dock model.** Tray-only with hidden dock (like Windows), or a real dock presence + `app.on('activate')`? Affects whether close-to-minimize needs a mac branch.
**Recommendation:** match Windows (tray-only, dock hidden) for consistency unless mac users expect a dock app; decide before shipping mac.

**B11 — PII-in-logs redaction timing.** `app.log` contains patient/doctor names today. Land `redact()` with the logger extraction (Phase 1), or defer?
**Recommendation:** land it in Phase 1 with the logger — it's a HIPAA-adjacent app and the cost is small once the logger is a real module. Confirm acceptable that existing logs already contain names (the change is forward-looking).

**B12 — "Second loop" finalize trigger.** [pa-planning/03](../pa-planning/03-architecture-observations.md) §4 notes engines arguably should run on the *scribe-edited final* note, not the raw AI draft (else CDI audits a draft the scribe already fixed). Pre-chart already has a "done editing → re-process" shape.
**Recommendation:** out of scope for the refactor (it's a product-flow decision), but the engine chain in [02](02-target-architecture.md) should be *invocable on demand* (not only auto-after-SOAP) so a future "finalize" trigger can re-run engines without structural change. Note it; don't build it.

**B13 — Encounter-context capture: `visit_type`, `chief_complaint`, and generation-engine inputs.** *(Gates: any gated or generation engine landing — specifically Workers Comp, Prior Auth, orders, patient summary.)*
Today, `visit_type`, `chief_complaint`, `placeholders`, `warnings`, and `summary` are parsed from the SOAP manifest in `spawnSoapGeneration` and **written only to `app.log`** — no DB column, nothing in `ctx`. Yet the engine framework's `gates(ctx)` and `buildInput(ctx)` depend on `visit_type` (WC gating) and `chief_complaint` (PA context); the Auto-Pilot orchestrator dispatches entirely on this metadata; and generation engines need additional per-encounter user-supplied context (payer/DOI/employer for WC; language for patient summary).
**Recommendation:** as part of Phase 2/3, (a) persist at minimum `visit_type` and `chief_complaint` into the `cases` table (a migration) and thread them into `ctx.encounter`; (b) design a small per-generation-engine input-collection step (a form on the pre-chart tab, or an on-demand trigger) for user-supplied fields the auto-after-SOAP pipeline can't know. This is a prereq for the Workers-Comp and Prior-Auth engines, not just a nice-to-have.

**B14 — Scribe approve/edit/reject surface for engines 8b (Feedback Loop) and 8c (Self-Learning).** *(Gates: engines 8b/8c; far-future but should not be silently incompatible with the architecture.)*
The generalized status panel (`reviews: [{engine, label, badges, stats, openPath}]` from [02](02-target-architecture.md)) is a **read-only display** — it has no concept of capturing a scribe's action on an engine output (accept / edit / reject). Engines 8b and 8c structurally require a per-output action log (`pa-planning/05-engines.md §8b: "Records scribe actions"`) and a `feedback_log` persistence layer. This is the one engine family the `descriptor + registry + migration + skill` formula does NOT fully cover.
**Recommendation:** defer 8b/8c implementation, but do NOT design them out of the architecture. When the 2nd review engine lands and the UI is being modularized (Phase 4), add placeholder affordances (e.g. a `onScribeAction(action)` callback slot on the review panel entries + an empty `feedback_log` table) so the feedback loop can be bolted on without a second UI rewrite. Acknowledge that 8b/8c need the "Unified Review Package" UI concept from `pa-planning/02-feature-landscape.md` — a dedicated review panel where the scribe sees all engine outputs and acts on them — which is a product design decision, not just code.

---

## Resolved by the analysis (no longer open)

These came up as agent open-questions but the analysis answered them — recorded so they're not re-litigated:

- **Delete dead code** (`python/db_helper.py`, `notes-claude/draft/`, `notes-claude/scripts/md_to_docx.py` stale copy, `launch.vbs`) — yes, all confirmed unreferenced. Phase 0.
- **`.mcp.json` duplication** (`MCP_CONFIG` const vs the on-disk file) — collapse to copying from `notes-claude/.mcp.json`. Phase 1 (`config/mcp.js`).
- **Un-nest the single-instance `else` block** — yes, as a standalone no-behavior-change commit; it's the prerequisite for extraction. Phase 0.
- **DB migrations not transactional** — fix before any engine adds a table. Phase 0, backward-compatible with `user_version=4`.
- **`shell:true` in `spawnClaude`** — replace with arg-array spawn (fixes injection + cross-platform escaping). Phase 2 (the provider), or Phase 0 if cheaply isolatable.
- **Specialty-gate normalization** (`.toLowerCase()` in main.js vs `+strip-spaces` in the skill) — unify into one rule in the engine gate; the skill gate becomes a defensive backstop. Phase 2.

---

## How decisions get recorded going forward

1. A fork gets answered → move its row from Part B to Part A here, with who/when.
2. If it's architectural (changes a load-bearing seam, schema, or contract), **also** append a dated entry to [../DECISIONS.md](../DECISIONS.md) in the repo's standard format — that's the canonical log; this doc is the refactor-scoped working view.
3. The implementing Claude session reads Part A as settled constraints and surfaces any *new* fork it hits (rather than guessing) into Part B.

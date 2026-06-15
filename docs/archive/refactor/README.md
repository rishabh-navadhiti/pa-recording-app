# Refactor — the big restructure

This folder holds the plan for refactoring AI Medical Scribe from its current state (two multi-thousand-line monoliths, no build step, developer-shaped install) into a modular, testable, distributable app that the planned **Physician Assist engines** can grow into without piling more code onto one file.

It is **not** a normal feature plan (those live in [`../plans/`](../plans/)). It's a multi-document program of work that will run over several PRs. These docs are written to be read by **both** the humans steering the project **and** the Claude sessions that will execute the refactor — so they're concrete about *what's there now* and *where things should go*, while leaving room for the implementer to make local judgment calls.

---

## Read in this order

| Doc | What it is | Audience |
|---|---|---|
| [00-current-state.md](00-current-state.md) | Factual map of the app today — flow, screens, pipeline, processes, files, dependency chain, distribution reality. | everyone — start here |
| [01-problems.md](01-problems.md) | The catalogue of what's wrong, by subsystem, with severities, line refs, and the two master tables (global mutable state; Node↔child string contracts). | everyone |
| [02-target-architecture.md](02-target-architecture.md) | The proposed modular structure: `src/` layout, the **engine framework** the PA roadmap needs, IPC/services/platform seams, renderer modularization, language/tooling stance. | everyone |
| [03-migration-plan.md](03-migration-plan.md) | How we get there in safe, shippable phases **without breaking production scribes**. Ordering, per-phase exit criteria, rollback. | implementer |
| [04-distribution-and-updates.md](04-distribution-and-updates.md) | Packaging (electron-builder), real auto-update, code signing/notarization, the **`claude` CLI dependency fork**, and migrating existing git-clone users to a real installer with no data loss. | everyone |
| [05-testing-and-ai-workflow.md](05-testing-and-ai-workflow.md) | How to make the code AI-testable and AI-debuggable: what becomes pure/unit-testable, the test harness, fixtures, and how a Claude session verifies a change in isolation. | implementer |
| [06-macos-and-platform.md](06-macos-and-platform.md) | What the platform seam looks like and what mac support actually requires once the structure is modular. | implementer |
| [07-open-questions-and-decisions.md](07-open-questions-and-decisions.md) | The genuine forks, each with a recommendation and what's still the user's call. Decisions get recorded here (and promoted to `../DECISIONS.md`) as they're made. | everyone |

A subagent fan-out analyzed every subsystem to produce 01–06; the raw findings are distilled into those docs, not kept separately.

---

## The three constraints that shape everything

1. **Don't break production.** `main` is installed and in active use by real scribes. Migration may cost a ≤5-minute call (quit/restart + a few PowerShell commands), worst case a reinstall — **but the same `~/Documents/AI Medical Notes` folder must keep working** (settings, `app.db`, `Cases/`, `templates/`).
2. **Make room for engines.** The next phase adds ~8 review/generation engines (CDI, SOAP-validator, E/M scorer, Workers-Comp, Prior-Auth, orders, patient summary, quality/feedback). They all hang off the SOAP note in the same shape. The architecture's job is to make "add an engine" a small, local, testable change.
3. **Make it AI-buildable and AI-testable.** All code is written by Claude; testing is manual today. The refactor should pull logic out of Electron/`child_process`/`fs` entanglement into pure modules an AI can unit-test and debug in isolation.

---

## Principles carried over from the existing codebase

The codebase already contains the patterns to emulate — they're just confined to the small files:

- **`db/` is the model module layout.** Singleton connection, numbered SQL migrations gated by `PRAGMA user_version`, `try/catch` around every write, one-time data migrations with backups. Generalize this.
- **`parseSkillManifest.js` is the model for "pure, tested logic."** Extracted from `main.js`, no I/O, covered by the one existing test. Every engine's parsing/decision logic should look like this.
- **Files on disk stay canonical.** The DB indexes them; it never becomes the source of truth for chart artifacts. Keep this — it's why the notes folder survives a DB delete.
- **Skills are the source of truth in the repo, synced to the notes dir.** Keep the sync model; make the spawn-adapter side modular.
- **Append-only `DECISIONS.md`, plan-per-feature, docs-in-the-same-PR.** The refactor follows the same doc discipline.

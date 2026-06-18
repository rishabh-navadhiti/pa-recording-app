# In-flight feature plans

One line per plan currently being worked on. When a feature ships, `git mv` its plan file into [`../archive/plans/`](../archive/plans/) and remove the line below.

Plan files use the convention `YYYY-MM-DD-<initials>-<slug>.md`.

> **Big restructure:** the codebase refactor (modularizing `main.js`/`renderer.js`, the engine framework, distribution/packaging) is a multi-PR program with its own folder — see [`../refactor/`](../refactor/) (start at its [README](../refactor/README.md)). It's not a single-feature plan, so it lives outside this table.

| Plan | Owner | Status |
|---|---|---|
| [2026-05-19-rs-cdi-v1-skill.md](2026-05-19-rs-cdi-v1-skill.md) | rs | Planned (Plan 1 of 2 — CDI skill + standards files; app integration is a separate Plan 2 after this lands) |
| [2026-05-22-rs-unify-docx-generation.md](2026-05-22-rs-unify-docx-generation.md) | rs | Planned (generate-note emits JSON manifest as final line; app owns multi-patient folder splits + all docx; no DB schema changes) |
| [2026-05-22-rs-cdi-v1-app-integration.md](2026-05-22-rs-cdi-v1-app-integration.md) | rs | Planned (Plan 2 of 2 — Phase 1 re-implements the ICD step natively on develop; Phase 2 wires CDI skill into pipeline, UI, DB. **Implementation on a new `cdi-v1` branch off latest develop; `icd10-coding` kept as read-only reference, NOT merged.**) |
| [2026-06-05-rs-costigan-procedure-checklist.md](2026-06-05-rs-costigan-procedure-checklist.md) | rs | Implemented (skill + standards only — `cdi-costigan`, a CDI variant doing procedure-specific medical-necessity validation against Cedars CRI / Medicare LCD checklists for 5 interventional-pain procedures; all ICD codes connector-validated. UI/pipeline wiring deferred to the refactor.) |

---

**To start a plan:**
1. Copy the convention above. Drop a markdown file into this folder.
2. Add a row to the table.
3. Implement against it. Update [`../../CLAUDE.md`](../../CLAUDE.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), and [`../DECISIONS.md`](../DECISIONS.md) as part of the work — not afterwards.
4. After merge: `git mv` the plan file into `../archive/plans/`, delete its row from the table.

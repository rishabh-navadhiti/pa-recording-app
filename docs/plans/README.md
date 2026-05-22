# In-flight feature plans

One line per plan currently being worked on. When a feature ships, `git mv` its plan file into [`../archive/plans/`](../archive/plans/) and remove the line below.

Plan files use the convention `YYYY-MM-DD-<initials>-<slug>.md`.

| Plan | Owner | Status |
|---|---|---|
| [2026-05-13-rs-icd-coding.md](2026-05-13-rs-icd-coding.md) | rs | In progress (impl on `icd10-coding` branch) |
| [2026-05-19-rs-cdi-v1-skill.md](2026-05-19-rs-cdi-v1-skill.md) | rs | Planned (Plan 1 of 2 — CDI skill + standards files; app integration is a separate Plan 2 after this lands) |
| [2026-05-22-rs-unify-docx-generation.md](2026-05-22-rs-unify-docx-generation.md) | rs | Planned (remove inline docx step from generate-note; switch to skill→manifest→app pattern for all skills) |

---

**To start a plan:**
1. Copy the convention above. Drop a markdown file into this folder.
2. Add a row to the table.
3. Implement against it. Update [`../../CLAUDE.md`](../../CLAUDE.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), and [`../DECISIONS.md`](../DECISIONS.md) as part of the work — not afterwards.
4. After merge: `git mv` the plan file into `../archive/plans/`, delete its row from the table.

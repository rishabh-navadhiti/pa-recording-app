# In-flight feature plans

One line per plan currently being worked on. When a feature ships, `git mv` its plan file into [`../archive/plans/`](../archive/plans/) and remove the line below.

Plan files use the convention `YYYY-MM-DD-<initials>-<slug>.md`.

| Plan | Owner | Status |
|---|---|---|
| _(no in-flight plans)_ | — | — |

---

**To start a plan:**
1. Copy the convention above. Drop a markdown file into this folder.
2. Add a row to the table.
3. Implement against it. Update [`../../CLAUDE.md`](../../CLAUDE.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), and [`../DECISIONS.md`](../DECISIONS.md) as part of the work — not afterwards.
4. After merge: `git mv` the plan file into `../archive/plans/`, delete its row from the table.

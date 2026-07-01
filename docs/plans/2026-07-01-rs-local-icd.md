# Local ICD coding — API proposal + bundled FY2026 codeset (retire `claude -p`)

**Status:** Implemented on `feature/local-icd`.
**Owner:** rs

## Problem

ICD coding was the last agentic `claude -p` engine, and the only one still depending on the
claude.ai ICD-10 **MCP connector** (`add-icd-codes` skill + `.mcp.json`). A hands-on test of the
managed-MCP path (Anthropic Messages-API `mcp_servers` connector) on a real note took **~21 min
and ~83k input tokens for one note**, with repeated 300-second connector timeouts — too slow and
flaky for the pipeline. The connector's genuine value (ground-truth code existence, billable
status, and the "don't upgrade specificity unless a more-specific billable child exists"
discipline) is fully reproducible offline from the CMS ICD-10-CM order file.

## Design

Two-phase, mostly-deterministic ICD step. ICD stays a first-class `runEngine` engine, moved onto
the framework's API path (the same `runLlm` hook `em-score`/`patient-summary` use), so **every
call site (`chain.js`, `prechart.js`, `prechartApi.js`) is unchanged**.

- **Phase A — model (one Anthropic API call, no tools).** `notes-claude/skills/add-icd-codes-api/SKILL.md`
  (a tuned outpatient-coder methodology: selection + specificity, no tool-calls) proposes billable
  diagnosis **candidates** from the SOAP note as JSON: `{diagnosis, code, description, search_terms,
  specificity}`. Pinned to `ctx.api` (Anthropic).
- **Phase B — deterministic JS validation.** `src/icd/coder.js` cross-checks each candidate against
  the bundled FY2026 codeset (`src/icd/lookup.js` over `data/icd/icd10cm_fy2026.db`, better-sqlite3,
  read-only). **Dial = cross-check:** accept a code only if it exists + is billable + its official
  description matches the diagnosis; otherwise re-resolve via a codeset search on the model's search
  terms, and if that finds no confident match, **flag** the diagnosis for manual coding rather than
  emit a wrong code. Hallucinated and non-billable header codes can't reach the claim. The
  De-Quervain guard (`hasMoreSpecificBillableChild`) is a prefix query.
- **Phase C — write.** Append (or, on a pre-chart re-run, replace) the same `## ICD-10-CM Codes`
  table in the SOAP `.md` (downstream docx contract unchanged) + write a structured `<stem>_icd.json`
  (hidden on Windows). Flagged diagnoses are listed under the table, never as a code.

## Files

- **New:** `src/icd/lookup.js` (codeset lookup lib — validate/search/hasMoreSpecificBillableChild/children),
  `src/icd/coder.js` (pure cross-check + table render), `notes-claude/skills/add-icd-codes-api/SKILL.md`
  (Phase-A system prompt), `data/icd/icd10cm_fy2026.db` (committed ~21 MB codeset),
  `data/icd/build_icd_db.py` + `data/icd/README.md` (regen tooling + provenance),
  `tests/unit/icd-coder.test.js`, `tests/unit/icd-lookup.test.js`, `tests/unit/engines.test.js` (icd.runLlm cases).
- **Rewritten:** `src/engines/icd.js` (descriptor → `runLlm` Phase A/B/C).
- **Edited:** `src/llm/skill-io/prompts.js` (removed the `add-icd-codes` CLI builder — agentic path now
  throws), `src/engines/engineRunner.js` (MCP-error service-warning repointed `icd` → `cdi`),
  `tests/unit/{prompts,engine-runner}.test.js`.

## DB distribution

The app runs from the git checkout and auto-updates via `git pull`, so the codeset ships as a
committed binary at `data/icd/icd10cm_fy2026.db` — no packaging or download step. `lookup.js`
auto-selects the newest `icd10cm_fy<YEAR>.db`, so a fiscal-year refresh is just dropping in a new
file (regen via `build_icd_db.py`; see `data/icd/README.md`). Parity-test a new build against the
live connector before trusting it.

## Explicitly removed / unchanged

- **Removed (agentic ICD path unsupported in code):** the `add-icd-codes` prompt builder; `buildPrompt('add-icd-codes')` now throws (regression-guarded). `notes-claude/skills/add-icd-codes/` is kept on disk for reference only, invoked by nothing.
- **Unchanged:** `.mcp.json` / the ICD-10 connector (still used by `cdi-review`); `enableIcd` gate + `enableCdi ⟹ enableIcd` invariant; the `## ICD-10-CM Codes` table format; no DB schema change.

## Provider-agnostic upside

Phase B is pure JS, so Phase A can move to Gemini/DeepSeek later without losing the validator —
unlike the managed-MCP connector, which is Anthropic-only.

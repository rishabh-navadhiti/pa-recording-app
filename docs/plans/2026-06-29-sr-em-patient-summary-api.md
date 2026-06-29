# Convert em-score + patient-summary to a single API call

**Owner:** sr · **Date:** 2026-06-29 · **Status:** Planned

### Resolved decisions (2026-06-29)

1. **API only — no CLI branch, no fallback.** em-score and patient-summary **always** run
   through a single Anthropic Messages-API call (unconditional `runLlm`), regardless of the
   SOAP option. This mirrors `prechartApi`, which always uses the API even though the
   `edit-note` CLI skill still exists. There is **no** auto-retry-on-failure and **no**
   provider branch — on an API failure the engine marks the run failed + surfaces a
   `service-warning`, identical to the SOAP API path.
2. **Pinned to Anthropic.** The call always goes to `ctx.api` (never `ctx.gemini`), even
   when SOAP is set to Gemini — no Gemini wiring is added. The model is
   `resolveCliModel(soapModel)` (the underlying Anthropic model, falling back to the
   default Anthropic model for a Gemini SOAP selection).
3. **Leave the old CLI skills + prompt builders on disk, untouched.** The
   `notes-claude/skills/em-score` + `patient-summary` folders and the
   `scoreEm`/`patientSummary` builders in `prompts.js` stay **as-is** — dormant (no longer
   wired to the engines) but available for standalone manual "score em" invocation. Not
   deleted, not modified.

> **Auth implication (accepted):** because these two engines now always use the API, they
> require `ANTHROPIC_API_KEY` even for a user on the "Agentic" SOAP option (which otherwise
> authenticates via `claude login`, no key). This is acceptable — both engines are
> best-effort and toggle-gated (`enableEmScore`/`enablePatientSummary`), and the default
> SOAP option is already API. If the key is missing, the engine fails cleanly with a
> service-warning and the rest of the case chain continues.

## Goal

Move the **em-score** and **patient-summary** engines off the agentic `claude -p` CLI
path onto a single Anthropic/Gemini Messages-API call — mirroring how
`generate-note-api` and `edit-note-api` already work. **ICD and CDI stay on the CLI
path unchanged** (they depend on the ICD-10 MCP connector + standards-pack reasoning;
out of scope here).

### Why

- Both engines are pure "read note (+ transcript [+ MDM pack]) → emit one JSON object"
  jobs with **no tool use and no MCP connector** (em-score is explicitly connector-free;
  patient-summary reads only the note). They never needed an agentic harness.
- The CLI path spawns a full Claude Code agent per case (permission bootstrap, bash file
  globbing, Read/Write tool round-trips, a python JSON-validation step) — slow, and it
  can only run Anthropic models even when the SOAP setting selects Gemini
  (`resolveCliModel` falls back to a default Anthropic model — see commit `e1e40c6`).
- A single API call removes all of that: Node reads the inputs, the model returns the
  JSON, Node writes the file. Faster and cheaper, with no agentic spawn. The call is
  **pinned to the Anthropic API** (see Resolved decisions) — predictable output regardless
  of the SOAP provider selection.

## Reference pattern (already in the tree)

| Piece | SOAP (`generate-note-api`) | Pre-chart (`edit-note-api`) | This plan |
|---|---|---|---|
| System prompt | `generate-note-api/SKILL.md` (frontmatter stripped) | `edit-note-api/SKILL.md` | **new** `em-score-api/`, `patient-summary-api/` SKILL.md |
| Message builder | `buildSingleCallNoteGen()` | `buildSingleCallNoteEdit()` | **new** `buildSingleCallEngineJson()` (generic) |
| Provider call | `provider.runSingleCall()` | `provider.runSingleCall()` | same |
| Provider select | `resolveOption(soapModel)` → `ctx.api`/`ctx.gemini` | always `ctx.api`/`ctx.gemini` (no CLI) | **`ctx.api` only, unconditional** (pinned Anthropic; no CLI branch) |
| Node writes output | `fs.writeFileSync(soapNoteMdPath, noteBody)` | `fs.writeFileSync(existingNotePath, noteBody)` | `fs.writeFileSync(<stem>_em.json / _patient_summary.json, jsonText)` |
| Usage accounting | `normalizeApiUsage()` | `normalizeApiUsage()` | same |

The closest precedent is **`src/jobs/prechartApi.js`**, which introduced a `runLlm` hook
into the job dispatcher so the API call replaces `buildPrompt + ctx.llm.runSkill` while the
rest of the lifecycle is untouched. We mirror that hook into the **engine runner**.

## Design

### 1. Engine runner gains an API branch (`src/engines/engineRunner.js`)

Today `runEngine()` step 4 always does `buildPrompt(...) → ctx.llm.runSkill(...)`. Add a
single branch keyed only on **whether the engine exposes `runLlm`** — no SOAP-provider
check, since the API path is unconditional for these engines. The recorded model stays
`engine.model(cfg)` (= `resolveCliModel(cfg.soapModel)`, the pinned Anthropic model id),
so `modelUsed` needs no change.

- **startEvent** (step 3) keeps `modelUsed: engine.model(cfg)`.
- **Step 4** branches:
  ```js
  if (engine.runLlm) {
    // API-only engines (em-score, patient-summary). Pinned to Anthropic —
    // ctx.gemini is intentionally never used for these engines.
    runResult = await engine.runLlm(engine.buildInput(ctx, caseCtx), ctx, caseCtx, {
      model:    engine.model(cfg),   // resolveCliModel → Anthropic model id
      provider: ctx.api,
    })
  } else { /* existing buildPrompt + ctx.llm.runSkill — byte-for-byte unchanged (ICD/CDI) */ }
  ```
- **Rate limit** (step 5): `const isRateLimited = runResult.isRateLimit || CLAUDE_RATE_LIMITED.test(combined)`.
- **Usage** (step 7): `const usage = runResult.usage || extractUsage(runResult.resultEvent)`
  then `finishEvent({ status, ...usage, ... })`. (`normalizeApiUsage` and `extractUsage`
  emit the same column set — they're already used interchangeably in
  prechartApi/jobDispatcher.)

`runResult` from `runLlm` is the same normalized shape prechartApi returns:
`{ code, text, errText, usage, statusCode?, isRateLimit? }` where `code === 0` on success.
ICD/CDI/SOAP have no `runLlm`, so the branch is false and they are completely untouched.

> **No CLI branch for these engines (decision 1).** Unlike SOAP (which branches on the
> setting between `generate-note-api` and the agentic `generate-note`), em-score and
> patient-summary go API-only — exact parity with `prechartApi`, which always uses the API
> while the `edit-note` CLI skill remains on disk, dormant. The old `em-score` /
> `patient-summary` CLI skills + their `prompts.js` builders stay untouched (decision 3).

### 2. `runLlm` on each engine descriptor

Add `runLlm(input, ctx, caseCtx, { model, provider })` to `src/engines/emScore.js` and
`src/engines/patientSummary.js` (`provider` is always `ctx.api`; "Anthropic" is hardcoded
in any auth/rate-limit service-warning copy). The engines now run API-only — their
`buildInput`/`interpret`/`persist` are reused; only `runLlm` is new. Each `runLlm`:

1. Resolve the output path + file stem (anchor on the existing `*_soap_note.md`, else the
   case-dir basename) — the same logic already in `synthesizeEmFromDisk`; factor it into a
   shared `resolveFileStem(caseDir)` helper so runLlm and the disk-fallback agree.
2. Read inputs from disk (Node, not the model):
   - **em-score:** the SOAP note (required), `transcript.md`/`*_transcript.md` (optional),
     and the MDM pack `<notesDir>/.claude/standards/em_mdm_2021.md` (required — fail if
     absent, same as the CLI skill).
   - **patient-summary:** the SOAP note (required) only.
   - Missing required input → `return { code: 1, errText: 'note_not_found' | 'em_pack_not_found' }`.
3. Read the `*-api` SKILL.md → `system = stripFrontmatter(skillText)`.
4. Build messages via `buildSingleCallEngineJson()` (below).
5. `const r = await provider.runSingleCall({ system, user, model, tag, label })`.
   - `!r.ok` → `return { code: 1, errText: r.errText, statusCode: r.statusCode, isRateLimit: r.statusCode === 429 || r.statusCode === 529, usage: normalizeApiUsage(...) }`.
6. Parse the JSON object out of `r.text` (helper `parseJsonResponse` — strips ```json
   fences, falls back to the largest balanced `{…}` block). On parse failure: write
   `<stem>_em.raw.txt` for debugging and `return { code: 1, errText: 'json parse failed', usage }`.
7. `fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2))`. (No `attrib -h` dance —
   these JSON files aren't pre-hidden the way `.md` notes are; confirm during impl.)
8. Synthesize the engine manifest from the parsed object (reuse/extend the existing
   `synthesizeEmFromDisk` shape, but build it from the in-memory object, and set
   `status: 'skipped'` when the JSON carries a `skipped_reason`, else `'ok'`).
9. `return { code: 0, text: JSON.stringify(manifest), usage: normalizeApiUsage(...) }`.

**`interpret()` and `persist()` are unchanged.** `interpret()` already parses the manifest
line from `runResult.text` and falls back to reading the on-disk JSON — both still hold
(the disk file now exists because *Node* wrote it). `persist()` still inserts into
`engine_outputs`. The model emits **only the JSON object** (the file content) — no manifest
line — so there is no dual-JSON ambiguity; Node owns the manifest.

`model()` keeps returning `resolveCliModel(cfg.soapModel)` for the CLI fallback; the API
branch uses `opt.model` from the runner.

### 3. Generic message builder (`src/llm/skill-io/singleCall.js`)

Add one reusable builder (both engines + future JSON-only engines use it):

```js
function buildSingleCallEngineJson({ skillText, instruction, injectedFacts = [], contextBlocks = [], closer }) {
  const system = stripFrontmatter(skillText)
  const parts = [instruction, '']
  if (injectedFacts.length) parts.push('INJECTED FACTS (authoritative):', ...injectedFacts.map(f => `- ${f}`), '')
  for (const { title, body } of contextBlocks) parts.push(`${title}:`, '---', body, '---', '')
  parts.push(closer)   // e.g. "Output the _em.json JSON object now — raw JSON only, no prose, no code fences."
  return { system, user: parts.join('\n') }
}
```

- **em-score** context blocks: `SOAP NOTE`, `TRANSCRIPT (optional cross-reference)`,
  `MDM FRAMEWORK PACK (em_mdm_2021.md — score against these tables)`; injected facts:
  patient (case stem), date of service (from caseTag), doctor, specialty.
- **patient-summary** context blocks: `SOAP NOTE`; injected facts: patient, doctor.

### 4. New API skill files

- `notes-claude/skills/em-score-api/SKILL.md`
- `notes-claude/skills/patient-summary-api/SKILL.md`

Each is a trimmed system prompt: keep the analytic content (role, MDM scoring methodology /
plain-language rules, the **exact output JSON schema + field constraints**) verbatim from
the CLI skill; **drop** the pre-flight permission bash, Step 0 path-parsing bash, the
"Read tool" / "Write tool" steps, the python JSON-validation step, and the Step 6 manifest
emission. End with: *"You are given all inputs inline. Respond with exactly the JSON object
specified above and nothing else — no prose, no code fences, no manifest line."*

These ship in `notes-claude/` so they sync into `<NOTES_DIR>/.claude/` on launch (skills
sync — `startup/bootstrapNotesDir.js`). runLlm reads them from `ctx.paths.claudeDir`
(the synced copy), same as `generate-note-api`.

## Files touched

| File | Change |
|---|---|
| `src/engines/engineRunner.js` | API branch (resolveOption → runLlm), usage + rate-limit handling |
| `src/engines/emScore.js` | `runLlm()`; `resolveFileStem()` helper; manifest-from-object |
| `src/engines/patientSummary.js` | `runLlm()`; same helpers |
| `src/llm/skill-io/singleCall.js` | `buildSingleCallEngineJson()`, `parseJsonResponse()` |
| `notes-claude/skills/em-score-api/SKILL.md` | NEW (trimmed system prompt) |
| `notes-claude/skills/patient-summary-api/SKILL.md` | NEW |
| `tests/unit/*` | builder + runLlm (mock provider) + engineRunner branch tests |
| `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` | doc updates |

**No DB migration** (engine_outputs already exists, `persist()` unchanged).
**No settings change** (reuses `soapModel` + `enableEmScore` / `enablePatientSummary`).
**ICD / CDI / SOAP / multi-patient chain code: untouched.**

## Testing

- Unit: `buildSingleCallEngineJson` shape; `parseJsonResponse` (raw, fenced, with-prose,
  malformed); `emScore.runLlm`/`patientSummary.runLlm` against a fake provider (ok →
  file written + manifest text; `!ok` → code 1 + statusCode; skip JSON → status skipped;
  malformed → `.raw.txt` + code 1).
- Unit: `engineRunner` — an engine with `runLlm` calls it and prefers `runResult.usage`;
  an engine without `runLlm` (ICD/CDI) still calls `ctx.llm.runSkill` (regression guard).
- Manual (`npm start`): one recording with `enableEmScore` + `enablePatientSummary` on,
  SOAP = "Sonnet 4.6 (API)" → confirm `<stem>_em.json` + `<stem>_patient_summary.json`
  written, `engine_outputs` rows present, app.log shows `runSingleCall` not a `claude -p`
  spawn for these two. Then flip SOAP to "Sonnet 4.6 (Agentic)" → confirm em-score /
  patient-summary **still go through the Anthropic API** (not the CLI), while SOAP itself
  runs agentically — and that they fail cleanly (service-warning, chain continues) if no
  `ANTHROPIC_API_KEY` is set.

## Open questions

1. **`max_tokens`** — `runSingleCall` defaults to 16000. The em JSON + patient summary are
   small; default is fine, but verify the MDM pack injected into the em-score prompt doesn't
   crowd the output budget. Bump per-call if needed.

_(Provider pinning, CLI fallback, and skill retention resolved — see **Resolved decisions**.)_

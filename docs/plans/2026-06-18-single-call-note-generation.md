# Plan — Single-Call API Note Generation (Phase 1, SHIP TONIGHT)

**Date:** 2026-06-18
**Why now (urgent):** the Claude subscription billing is on hold, so the agentic `claude -p` path is **down for scribes right now**. We need a working note-generation path **shipped tonight** via the Anthropic **Messages API** (Sonnet 4.6, API key). Scope is **note generation, single patient, only**. Everything else (template, ICD, CDI, pre-chart, multi-patient) stays on the agentic path / is deferred.
**Hand-off:** implementer-ready. Confirm the call sites in §1 against live code before editing.
**Companion:** [strategy](../notes/2026-06-15-model-and-provider-strategy.md), [catalogue](../notes/2026-06-15-model-pricing-and-capability.md), [API usage + validated prompt](/home/rish/Development/PA/API_USAGE_single_call_notes.md).

---

## 0. The one idea behind every change

A single API call is **not agentic** — the model can't touch the filesystem. So file IO **inverts from the skill to the app**. Today `generate-note` (inside `claude -p`) reads the template + transcript and writes the `.md`s itself; in the API path the **app** reads them inline, the model returns the note text, and the **app writes it**. **Everything downstream of "the `.md` exists + the manifest is parsed" is unchanged** — ICD→CDI→docx and the multi-patient chain are untouched. We only change *how the `.md` is produced*.

| | Today (Agentic CLI) | Phase 1 (Single-call API) |
|---|---|---|
| Read template + transcript | skill (Read tool) | **app**, inlined into the prompt |
| Generate note | skill | model (one response) |
| Write `.md` | skill (Write tool) | **app** |
| Emit manifest (last line) | skill | model (same contract) |
| ICD→CDI→docx | app chain | app chain (**unchanged**) |

---

## 1. Confirmed current call path (read before editing)
- `main.js:277` **`spawnSoapGeneration(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry, templatePath, caseId)`** → builds `buildPrompt('generate-note', {templateRel, transcriptRel})`, calls `ctx.llm.runSkill(...)` (CLI provider; the skill writes the `.md`s), then on completion `parseSkillManifest(text)` → `multi_patient` ? `runMultiPatientChain` (main.js:384) : `runCaseChain` (main.js:372).
- `src/llm/provider.js` — `runSkill({prompt,model,effort,tag,label,env}) → {code,text,resultEvent,errText}` (always resolves).
- `src/llm/skill-io/{prompts,markers,manifest}.js` — `buildPrompt`, `parseSkillManifest` (defensive tail-parse + on-disk fallback), `usage.js` (`extractUsage`).
- `src/pipeline/chain.js` — `runCaseChain` / `runMultiPatientChain`. **Do not touch.**
> **Implementer step 0:** open `spawnSoapGeneration` in full and confirm exact shape before editing.

---

## 2. Components to build (all additive)

### 2.1 Settings = model options (NOT a separate api/agentic flag)
The user picks a **model option** in Settings; the option encodes both the model and the execution path. Add a registry:

`src/llm/modelOptions.js`:
```js
// id -> how to run it. The user only ever sees `label`.
const NOTE_GEN_OPTIONS = {
  'sonnet-4-6-agentic': { label: 'Sonnet 4.6 (Agentic)', provider: 'cli', model: 'claude-sonnet-4-6' },
  'sonnet-4-6-api':     { label: 'Sonnet 4.6 (API)',     provider: 'api', model: 'claude-sonnet-4-6' },
  // future: 'gemini-3-1-pro-api': { label:'Gemini 3.1 Pro (API)', provider:'gemini', model:'gemini-3.1-pro' }
}
```
- **`config/settings.js`**: `soapModel` now stores an **option id** (default below). The settings **normalizer** must map any legacy/unknown value (e.g. the old `'claude-sonnet-4-6'`) to a valid id **without touching other keys**. **Default for this ship → `'sonnet-4-6-api'`** (the agentic path is down; legacy installs auto-resolve to the working API option). Keep `'sonnet-4-6-agentic'` selectable for when billing returns.
- **`config/secrets.js` / `.env`**: add `ANTHROPIC_API_KEY` (+ getter), alongside `ELEVENLABS_API_KEY` / `NOTES_DIR_PATH`.
- **🔴 KEY DISTRIBUTION — the #1 ship-blocker, must be in TONIGHT (not M3).** Scribe machines authed via subscription OAuth; they have **no `ANTHROPIC_API_KEY`**, and `.env` is gitignored so auto-update will **not** deliver one → every install returns "key not set" → **zero notes**. (Staging won't catch this — the dev sets the key by hand.) Fix: **clone the existing ElevenLabs-key flow end-to-end** for the Anthropic key — `getElevenLabsKey`/`saveElevenLabsKey` already exist (preload + `src/ipc/config.js` + the Settings view, writing to repo `.env`). Add `getAnthropicKey`/`saveAnthropicKey` the same way + a Settings field. Then a dev (or the scribe) pastes the key once in Settings. **Trace this for one real scribe box before building anything else — if the key can't land, nothing else matters.** (Emergency: one shared key tonight; rotate later.)
- **Renderer** (`renderer/views/settings.js`): the model dropdown lists the registry `label`s; saves the `id`. Drift-safe (it's just string options). Keep it minimal for tonight.

### 2.2 New provider — `src/llm/anthropicApiProvider.js` (mounted as `ctx.api`)
- `runSingleCall({ system, user, model, maxTokens=16000, thinking=false, tag, label }) → { ok, text, usage, stopReason, errText }`.
- Native **`fetch`** (no new dep — `elevenLabs.js` precedent). `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`. Body `{model, max_tokens, system, messages:[{role:'user',content:user}]}` (thinking OFF for tonight → do not send `thinking`/`budget_tokens`).
- `text` = concat `content[]` where `type==='text'`. Capture `usage`. Handle `stop_reason` (`refusal`, `max_tokens`).
- **Always resolves** (mirror CLI contract): HTTP/network/refusal → `{ok:false, errText}`, never throws. Missing key → `{ok:false, errText:'ANTHROPIC_API_KEY not set'}`.
- Wire `ctx.api` in `context/appContext.js` + `startup/bootstrap.js`. **`ctx.llm` (CLI) stays untouched** for the agentic skills. This is the seam `provider.js` was designed for.

### 2.3 New skill — duplicate + **preamble baked at the top**
- `cp -r notes-claude/skills/generate-note notes-claude/skills/generate-note-api`.
- Edit **only** the top of `generate-note-api/SKILL.md`: keep the original body verbatim (the full skill — validated to work *with* a preamble); set the frontmatter `name: generate-note-api`; and **insert this block immediately after the closing `---` of the frontmatter, before the original `# Medical SOAP Note Generator` heading**:

```markdown
# MODE: SINGLE-CALL — no tools, one response only

The application has ALREADY read the doctor template and the transcript and placed both inline in the user message below, and the application will SAVE your output itself. You have NO filesystem access.

- Do NOT use any tools (no Bash, Read, Write, Edit) — there is no filesystem and no tools are available.
- SKIP Steps 0, 2, 3, 5a, and 6 entirely (permission setup, path resolution, reading the transcript, reading the template, saving files — the app has already done these).
- PERFORM only Steps 1, 4, 5b, 5c, and 7 (parse the request, detect multi-patient, select the note type, generate the note, emit the manifest).
- Write the COMPLETE SOAP note as plain text directly in your reply (no code fences, no preamble).
- END your reply with the single-line JSON manifest exactly as Step 7 defines, using the `recording_folder` and `soap_note_md` paths given in the user message.

---
```

That is the entire skill change for tonight. (The deeper rewrite — physically removing the skipped steps + defining the multi-patient output contract — is the next, separate task you flagged.) The app uses this file's text as the **system prompt** directly; because the preamble is baked in, there is **no runtime preamble code**.

### 2.4 Skill-IO — single-call input + output split (`src/llm/skill-io/`)
- `buildSingleCallNoteGen({ skillText, templateText, transcriptText, caseDir, soapNoteMdPath, doctorLastname }) → { system, user }`:
  - `system = skillText` (strip the leading YAML frontmatter block — tidy, optional).
  - `user` = the **validated** shape from `API_USAGE_single_call_notes.md` §2: `Generate a SOAP note for doctor <lastname>.` + `recording_folder` + `soap_note_md` (for the manifest) + `DOCTOR TEMPLATE:\n---\n{templateText}\n---` + `TRANSCRIPT:\n---\n{transcriptText}\n---` + the single-response reminder. **Copy that wording verbatim — it's the prompt that passed the Sabbag test.**
- `splitNoteAndManifest(text) → { noteBody, manifest }`: reuse `parseSkillManifest` for the last JSON line; `noteBody` = everything before it, trimmed.

### 2.5 Dispatch branch in `spawnSoapGeneration`
Resolve the option: `const opt = NOTE_GEN_OPTIONS[cfg.soapModel] ?? NOTE_GEN_OPTIONS['sonnet-4-6-api']`. If `opt.provider === 'cli'` → existing path unchanged. If `'api'` → new sibling `generateSoapViaApi(...)`:
1. `templateText = readFile(templatePath)`, `transcriptText = readFile(transcriptAbsPath)`.
2. `skillText = readFile(<skill path>)`. **Read from the path guaranteed to exist on a *packaged* install** — the synced `<NOTES_DIR>/.claude/skills/generate-note-api/SKILL.md` (present after the startup skills-sync) resolved via `ctx.paths`, **not** a dev-relative `notes-claude/...` path (which won't resolve in the installed app). Confirm the sync copies the new skill folder.
3. `buildSingleCallNoteGen(...)` → `{system,user}`.
4. `ctx.api.runSingleCall({ system, user, model: opt.model, thinking:false, tag, label:'soap' })`.
5. `splitNoteAndManifest(text)` → `{noteBody, manifest}`.
6. **Write** `noteBody` → **the app's own `soapNoteMdPath`** (the value passed into `spawnSoapGeneration`). ⚠️ The model echoes `recording_folder`/`soap_note_md` into the manifest and **can hallucinate them** — treat the manifest's paths as *advisory only*; never write to or hand downstream a model-supplied path, or docx will operate on a phantom file.
7. Feed `manifest` + **the app's real path** to the same post-skill logic the CLI path uses → `runCaseChain(ctx, …)`. Downstream unchanged.

Keep `generateSoapViaApi` a clean sibling so the CLI path is byte-for-byte untouched.

### 2.6 Usage / cost — one normalized record, provider-agnostic (designed to absorb OpenRouter/Gemini)
Don't special-case the API shape inline. Define:
- A **normalized usage record**: `{ provider, model, inputTokens, outputTokens, cacheReadTokens, cacheCreatedTokens, numTurns, durationMs, costUsd }`.
- **Per-provider extractor** → normalized record:
  - CLI: from `resultEvent` (reuse `src/llm/usage.js`).
  - API: from `response.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`); `numTurns=1`; `durationMs` measured by the app.
- A **price table** `src/llm/pricing.js`: `{ 'claude-sonnet-4-6': {in:3, out:15, cacheRead:0.30, cacheWrite:3.75} }` → `costUsd`. New vendors = new rows.
- **One writer** takes the normalized record → `processing_events` (`job_kind='soap'`, `model_used`, tokens, `cost_usd`, `duration_ms`). This is the seam that makes OpenRouter/Gemini drop in later — only a new extractor + price rows, never a new writer.

### 2.7 Errors → `service-warning`
Map API failures to the existing `service-warning` IPC: `401`/missing key → auth, `429`/`529` → rate/overload, `stop_reason:'refusal'` → refusal, `5xx` → server. Mark the case failed exactly as a CLI failure does (same UI/status), and **also notify devs** per §5.

---

## 3. Multi-patient (tonight: degrade + flag — do NOT block single-patient)
Single-call can't write N files and the multi-note output contract isn't built yet (that's the skill-edit task). Normally we'd fall back to the CLI path — **but the CLI/subscription is down tonight**, so there is no fallback. Therefore, for tonight:
- Single-patient is the supported path.
- If `manifest.multi_patient === true`: **save whatever the model returned** to the soap `.md` (no data lost), **mark the case partial**, and **emit a loud `service-warning` to the scribe AND a dev notification** ("multi-patient recording — needs manual split / re-record per patient until the multi-patient API path ships"). Do not attempt the multi-patient chain with an unproven contract.
- Tell scribes: for tonight, record one patient per session where possible.

---

## 4. Tests (build alongside; CI must pass with no API key)
- **Fake `ctx.api`** (injectable) returning a canned `note + manifest` → deterministic, no key needed.
- Unit: `buildSingleCallNoteGen` system/user assembly; `splitNoteAndManifest`; the normalized-usage extractor + price→cost; the note-write helper.
- Integration: fake provider → `generateSoapViaApi` writes `<case>_soap_note.md` → `runCaseChain` proceeds (fake icd/cdi) → asserts identical on-disk artifacts to the CLI path; + a `multi_patient:true` → degrade-and-flag fixture.
- One **manual opt-in real-API run** (env-gated + key) on a Sabbag + Spencer single-patient case before shipping.

---

## 5. User-impact & safety (hard requirement)
**The ONLY acceptable user impact is "quit/restart the app or restart the system" to pick up the new build. Anything else must be flagged + notified to the devs (us) immediately.** Build it so:
- **Additive only:** new files (provider, skill, skill-io fn, `modelOptions.js`, `pricing.js`) + one branch in `spawnSoapGeneration` + new settings entries. **No deletion of the CLI path. No DB schema migration** (the `processing_events` columns already exist). **Existing case folders / `.md` / `.docx` untouched.**
- **Settings migration is non-destructive:** the normalizer maps legacy `soapModel` → a valid option id and leaves every other key intact; never wipes `settings.json`.
- **No new native deps** (native `fetch`) → no `electron-rebuild`; auto-update's `npm install` is a no-op for binaries.
- **New skill folder** syncs into `<NOTES_DIR>/.claude` harmlessly (the CLI never invokes it; the API path reads it from the bundle).
- **Missing/invalid `ANTHROPIC_API_KEY`** → clear `service-warning`, case marked failed, **no crash**.
- **Dev notification channel:** beyond the scribe-facing `service-warning`, add a dev-facing alert (a distinct `app.log` `[DEV-ALERT]` line, and surface in the status window) for: any API error, any `multi_patient` case, any write/parse failure, or any unexpected exception in `generateSoapViaApi`. **Honesty note:** this is *passive* tonight — it only reaches a dev if someone opens that machine's `app.log` or the scribe reports it. There is **no active push** (no webhook/telemetry) tonight. That's acceptable for the emergency ship *only if the team accepts it* — otherwise the scribe must be told "if a note fails or looks wrong, message us with the case name." Don't let "dev notification" read as automatic.
- **Watch-list to verify before ship** (each must be a no-op for users): existing in-flight/queued cases still complete; the floating status window still renders; `getSettings`/`saveSettings` round-trips with the new option; a CLI-mode install (if billing returns) still behaves identically.

---

## 6. Ship-tonight runbook (follows develop→staging→main; soak compressed)
1. **Dev** on `develop`: implement §2 (M1 only) + tests. `ANTHROPIC_API_KEY` in `.env`, `soapModel='sonnet-4-6-api'`.
2. **Local verify** (`npm start`): record → transcript → single-call note `.md` → ICD/CDI/docx (note: ICD/CDI are agentic and **also down** while subscription is on hold — see ⚠️ below) → `.docx`; check `processing_events` row + that the `.md` matches a known-good note.
3. **develop → staging**, install via `install-staging.ps1` on a dev machine, let auto-update fire, **confirm the new skill synced + the API path runs on the *installed* app** (your stated test).
4. **Run a single-patient generation on the staging install** end-to-end; verify no user-facing breakage beyond restart; check the dev-alert channel is quiet.
5. If clean → **staging → main** (fast-forward) → scribe installs auto-update → scribes **restart** → the API option is the default (or they select "Sonnet 4.6 (API)").
6. ⚠️ **Decision before ship — ICD/CDI:** they run via the agentic CLI *inside* `runCaseChain` — **also down** with the subscription. Gate them **off** for tonight (their `gates()` short-circuit when `enableIcd`/`enableCdi` are off) so the chain is just **note `.md` → docx**. *Verify they were already inactive for these scribes* (our DB pulls showed only `soap`/`transcribe`/`docx` events — no `icd`/`cdi` — strong evidence they're already off, so gating is a no-op). **But:** if ICD *was* appending an ICD-10 table for any scribe, gating it off **silently drops that table from tonight's notes** — a user-visible content change (impact beyond "restart") → **tell those scribes**. Confirm `enableIcd:false`/`enableCdi:false` cleanly skips in `runCaseChain`.
7. 🪢 **Manual stopgap (decide now, not at 11pm):** there is **no CLI fallback** tonight (subscription down). If the in-app API path slips, the **validated standalone script in `API_USAGE_single_call_notes.md`** is the agreed manual per-case stopgap a dev runs by hand (it produced the proven Sabbag/Harris notes). Keep it ready and named in the runbook so a failure is a known procedure, not a scramble.

---

## 7. Milestones
1. **M1 (TONIGHT):** **(a) Anthropic-key Settings field** (clone the ElevenLabs-key flow — the ship-blocker, build first), (b) single-patient API note-gen behind the "Sonnet 4.6 (API)" option (default), (c) ICD/CDI gated off, (d) normalized usage row, (e) service-warning + passive dev-alert, (f) multi-patient degrade-and-flag, (g) fake-provider tests, (h) staging-**install** verify incl. the key field + skill-sync path.
2. **M2 (next):** edit `generate-note-api/SKILL.md` into a proper single-call system prompt (remove the skipped steps; define the multi-patient output contract) → full multi-patient API support.
3. **M3:** Settings-view key entry; re-enable ICD/CDI (on API or after billing); pre-chart → API.

---

## 8. Open decisions for the implementer
- `ctx.api` separate seam (recommended) vs. method on the existing provider. (Plan assumes separate.)
- `generateSoapViaApi` sibling of `spawnSoapGeneration` (recommended) vs. promoting note-gen into the engine framework (defer — bigger change tonight).
- Whether to strip the skill's YAML frontmatter from the system prompt (tidy; optional).
- Reuse `src/llm/usage.js` cost logic for the price table.

---

## 9. Considerations for the OTHER skills (later — not tonight)
- **Pre-chart (`edit-note`)** — easiest next port (inputs inline, app writes regenerated note + backup). Same shape.
- **Template create/update** — rare/one-time; keep agentic or move to Opus API later; large inputs, not cost-sensitive.
- **ICD (`add-icd-codes`)** — blocked on the **claude.ai ICD-10 MCP connector**; can't go single-call until the **offline CMS ICD-10-CM dataset** replaces it (catalogue §13/§7). Keep gated/agentic.
- **CDI (`cdi-review`)** — agentic + connector + reasoning; ports after ICD is de-coupled.
- **General rule:** every agentic skill → single-call = (a) app reads inputs inline, (b) skill text → system prompt (preamble baked at top), (c) app writes outputs + parses manifest, (d) downstream unchanged. The `ctx.api` seam + the model-option registry + the normalized-usage layer (built tonight) are what make each subsequent port — and each new vendor (OpenRouter/Gemini) — a small, neat addition rather than a rewrite.
</content>

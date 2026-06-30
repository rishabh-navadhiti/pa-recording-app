# Plan: edit-note-api — Convert Pre-chart to Anthropic API

**Branch:** `feature/edit-note-api` (from `develop`)

---

## Context

The `edit-note` skill is invoked by the pre-chart job via `claude -p "edit note. Case: ..."`. This spawns the full Claude CLI agent, which uses Bash + Read + Write tools to find files, backup the note, and rewrite it. This CLI path is broken for installs that don't have the `claude` CLI in PATH.

The SOAP generation flow was already converted (`generate-note-api` + `src/llm/anthropicApiProvider.js`). The latest `generate-note-api/SKILL.md` (commit `b9ee6ec`) is now a condensed single-document system prompt: no step numbers, all-caps section headers, "THE TEMPLATE IS THE SOURCE OF TRUTH" as the anchor rule.

This plan mirrors that exact pattern for pre-chart/edit-note.

**Outcome:** When `soapModel` is an API provider (`sonnet-4-6-api` or `gemini-3.5-flash`), pre-charting makes a single direct API call. Node.js handles all file I/O (read, backup, write). CLI path stays intact for `sonnet-4-6-agentic`.

---

## Files Created

### 1. `notes-claude/skills/edit-note-api/SKILL.md`

Condensed system-prompt SKILL.md in the same style as the updated `generate-note-api/SKILL.md`:

- No Bash/Read/Write steps — Node.js handles all file I/O
- `"skill":"edit-note"` in manifest so `prechart.js` `onSuccess` manifest check works unchanged
- All-caps headers, no step numbers
- `backup_path` and `note_path` come from INJECTED FACTS (set by Node before the call)
- Authority hierarchy: instructions > existing note > attachment > template > transcript

### 2. `src/jobs/prechartApi.js`

New job descriptor. Mirrors `src/jobs/prechart.js` shape with a `runLlm(input, ctx, opts)` hook:

1. Resolve provider from `cfg.soapModel` (api → `ctx.api`, gemini → `ctx.gemini`)
2. Glob for existing soap note: `*_soap_note.md` excluding `*_soap_note_backup_*`
3. Read: template, existing note, transcript (optional), attachment (already combined by Node)
4. Read skill file from `notes-claude/skills/edit-note-api/SKILL.md`
5. Create backup via `fs.copyFileSync`
6. Build messages via `buildSingleCallNoteEdit()`
7. Call `provider.runSingleCall()`
8. Strip `attrib +h` before `writeFileSync` — Windows `EPERM` fix (CREATE_ALWAYS fails on hidden files)
9. Write updated note to disk
10. Return synthetic manifest JSON as `runResult.text` (same shape `onSuccess` expects)

`onRunning`, `onRateLimit`, `onSuccess`, `onFailure`, `onError` copied from `prechart.js`.

### 3. `src/llm/skill-io/singleCall.js` — `buildSingleCallNoteEdit()`

Builds user message with: INJECTED FACTS (existing_note_path, backup_path) + DOCTOR TEMPLATE + EXISTING SOAP NOTE + optional TRANSCRIPT + optional ATTACHMENT + optional SCRIBE INSTRUCTIONS.

Also exports `stripFrontmatter` (previously unexported).

---

## Files Modified

### 4. `src/jobs/jobDispatcher.js`

Added `runLlm` hook branch (~8 lines): if `descriptor.runLlm` is defined, call it instead of `buildPrompt + ctx.llm.runSkill`. Also extended rate-limit check with `|| runResult.isRateLimit` for HTTP 429/529.

### 5. `main.js`

Imported `prechartApiJob`. `spawnPrechartJob` now branches on `resolveOption(soapModel).provider` — `cli` uses `prechartJob`, anything else uses `prechartApiJob`.

---

## Key Reuse

| What | Where |
|---|---|
| `resolveOption()` | `src/llm/modelOptions.js` — already imported in main.js |
| `ctx.api` / `ctx.gemini` | `context/appContext.js` — already on ctx |
| `splitNoteAndManifest()` | `src/llm/skill-io/singleCall.js` |
| Lock, DB events, status broadcast | Inherited from `jobDispatcher.runJob` |
| `onSuccess` manifest parsing | Copied from `prechart.js` — manifest shape unchanged |

---

## Windows EPERM Fix

`fs.writeFileSync` uses `CreateFile(CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL)`. Windows returns `ERROR_ACCESS_DENIED` when the target file already has `FILE_ATTRIBUTE_HIDDEN` (set by the app's `attrib +h` after initial SOAP generation). Fix: call `attrib -h` on the file before writing. `onSuccess` re-applies `attrib +h` via `platform.hideInternal`.

---

## Verification

1. Set SOAP model to `Sonnet 4.6 (API)` in Settings.
2. Go to Pre-chart, pick a recent case, enter instructions.
3. Click Pre-chart → status banner shows "Running pre-chart…"
4. After ~10–20s → banner shows "Pre-chart applied".
5. In case folder: `*_soap_note.md` updated, `*_soap_note_backup_*.md` exists, `*_soap_note.docx` regenerated.
6. Check `app.log` for `[prechart][edit-note:api] note written successfully`.
7. Switch to `Sonnet 4.6 (Agentic)` → re-run pre-chart → CLI path still works.
8. Run `npm test` — no regressions.

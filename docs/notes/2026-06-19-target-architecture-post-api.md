# Target Architecture (post-API): single-call + agentic-SDK split

**Date:** 2026-06-19
**Status:** working note — direction, not a committed plan
**Context:** SOAP gen has moved from agentic `claude -p` to a single Anthropic Messages API call (live on `main`). This note records where the architecture is heading as the rest follows, and — importantly — which pieces should **not** become single-call.

---

## TL;DR

The migration makes the app **simpler overall, but it lands on TWO modes, not one** — and that's a feature:

- **Single-call (the bulk)** — fixed inputs → one output. note-gen, edit-note, em-score, patient-summary, and (once the ICD connector is replaced) ICD + CDI.
- **Agentic via the Claude Agent SDK (the few)** — needs to explore a large/variable fileset with tools across multiple passes. **Template create/update.**

The dividing question is simply: **does the task need to explore a large/variable fileset with tools?** No → single-call. Yes → agentic.

The real win is not "everything becomes single-call" — it's **deleting the *subscription-CLI delivery* and its scaffolding**, while *re-homing* (not deleting) the one genuinely-agentic task onto an API-key runtime.

---

## Why single-call simplifies the bulk

Single-call **inverts who orchestrates**: the *app* reads files, injects them, makes one HTTP call, parses the output — instead of bundling an agentic workspace and letting the model drive. That lets a whole category of machinery be deleted once the CLI path is gone:

| Becomes deletable | Why |
|---|---|
| `claudeCliProvider.js` + child-process spawn machinery | no `claude -p` subprocess |
| `notes-claude/` → `<NOTES_DIR>/.claude/` sync, `writeMcpConfig`, `.mcp.json`, bootstrap claude-steps | nothing reads `.claude` |
| `claude login` / subscription auth / bundling the CLI binary | replaced by an API key in settings |
| Trigger-string indirection (`buildPrompt` → `generate a note using template "X"`) | only existed so the CLI could *parse* it; the API path reads files directly (`singleCall.js`) |
| Skill Steps 0/2/3 (permission setup, path resolution, file IO) in each SKILL.md | the app does IO; the skill is just the reasoning prompt |
| `soap.js` agentic descriptor (`skillId: 'generate-note'`) — already orphaned | API note-gen runs **pre-chain** (`runCaseChain` starts at ICD), not via `runEngine(soap)`; the live skill is **`generate-note-api`** loaded by `singleCall.js` |
| `launch.vbs`/git-pull/electron-rebuild update fragility | no CLI to keep in sync → move to electron-updater |

**Setup collapses to "paste an API key."** That alone fixes the class of field problems we debugged on 2026-06-19 (two users wedged: `git pull` aborting on locally-modified tracked `launch.vbs` → never received the migration → stuck on the now-capped subscription `claude -p`, which fails `exited 1` at $0.00 after the June-2026 credit cutoff).

**What is NOT coupled to the CLI and stays unchanged:** DB / stores / IPC / renderer, `record.py`, `md_to_docx.py`, the docx pipeline, ElevenLabs transcription, `chain.js` orchestration, and the manifest/marker output contracts.

### The end-state "skill" shape (single-call)
A skill stops being a folder of agentic steps and becomes three small things:
1. **a system-prompt markdown file** — the reasoning (`generate-note-api/SKILL.md` already is this)
2. **`buildInput()`** — read files + inject known facts (patient/doctor/date) (`singleCall.js` already does this)
3. **`interpret()`** — parse the manifest/markers

`runEngine` then becomes uniform for every single-call engine: read prompt → buildInput → one API call → interpret → persist. The provider seam (`provider.js` + `anthropic`/`gemini`/`openrouter` impls) becomes the one load-bearing abstraction; **provider = a config value.**

---

## The deliberate exception: template creation stays agentic

`create-doctor-profile` (and `update-doctor-profile`) is **agentic by nature, not by accident** — single-call is the *wrong* tool for it:

- **The real work is computational analysis, not LLM reasoning.** Its output is frequency facts — *"'reports' — 275 instances", "review paragraph in 188/188 notes", "she 225 / he 178"* — produced by spawning **python/bash/grep** over 20–200 sample notes. A single-call model would have to *eyeball-estimate* those counts, which is exactly what LLMs are worst at. The tool passes are how it gets the numbers right.
- **It doesn't fit one call.** 20–200 notes ≈ 100k–1M+ tokens. Even at 1M context, one-shot is costlier *and worse* than the skill's smart selective loading (grep for the pattern, count, sample-read the interesting ones instead of loading everything).
- **Nothing to optimize away.** Single-call wins on *per-note cost at scale*; template creation is **rare/one-time** (new doctor or occasional correction). Opus 4.8 + max effort + multiple passes + minutes of runtime + a few dollars are all fine.

**So it stays agentic — but re-homed off the subscription CLI onto the Claude Agent SDK** (the API-key version of `claude -p`: same agentic loop, bash/file/grep tools, native skills, but pay-as-you-go auth). That keeps every migration win (no `claude login`, no subscription cap, no `.claude` sync convention) while preserving the one capability that's genuinely needed.

Two caveats for template creation:
1. **Sample notes are real notes → it touches PHI.** So the Agent SDK runs against the API under the same BAA consideration as everything else. **Managed Agents (Anthropic-hosted container) is out** — not HIPAA-eligible — even though it'd otherwise fit. Agent SDK runs the loop locally; only model calls leave the machine (better posture).
2. **Keep it on Claude/Opus; don't port it.** The single-call tasks are provider-portable (Gemini/DeepSeek bake-offs). Template creation leans on the agentic harness + skills and Opus is genuinely good at it — high value-per-run, low frequency. Don't spend portability effort here.

---

## The other holdout: ICD (and CDI, which depends on it)

`generate-note`, `edit-note`, `em-score`, `patient-summary` are pure reasoning → trivially single-call. **ICD used the Claude-only ICD-10 MCP connector** — the one piece that needs *real work*, not just a path swap. Until it's replaced with the **offline CMS ICD-10-CM dataset** (see the pricing/capability catalogue §7), ICD keeps a Claude-specific dependency alive, and CDI inherits it. ICD is the gating item for "the single-call bulk is fully portable."

---

## Suggested sequence (so you're never *more* complex for long)

The interim — both paths coexisting — is the most complex point (it's why `soap.js`/`generate-note` vs `generate-note-api` looks duplicated). Get off the hump in order:

1. **Migrate the remaining pure-reasoning engines** to single-call (SOAP done ✅; edit-note, em-score, patient-summary next).
2. **Replace ICD's MCP connector** with offline CMS validation → ICD + CDI become single-call.
3. **Re-home template create/update onto the Agent SDK** (API key), then **delete the subscription-CLI path**: `claudeCliProvider`, the `.claude` sync, the `buildPrompt` trigger strings, the orphaned `soap.js`/`generate-note` descriptor.
4. **Drop git-pull auto-update for electron-updater** (no CLI to bundle now → also fixes the `launch.vbs` wedge class).
5. **Collapse `notes-claude/skills/*/SKILL.md`** into a flat `prompts/` of system-prompt files for the single-call engines (template-create's skill folder stays, it's still agentic).

Net: fewer moving parts, dramatically easier setup + updates, one portable provider seam — with **two clearly-named exceptions** (template-create = agentic-SDK; ICD = needs offline-dataset rework) rather than a pretend-uniform "everything is single-call."

---

## Immediate cleanup already visible

`soap.js` (`skillId: 'generate-note'`) is in `registry.js`'s array but **the live chain bypasses it** — `runCaseChain` starts at ICD because API SOAP gen runs before the chain. Low-risk cleanup: confirm nothing else iterates the registry expecting a SOAP entry, then either delete the `soap` descriptor + its registry line, or repoint its `skillId` to `generate-note-api` with a comment that SOAP runs pre-chain. (Flagged 2026-06-19; not yet done.)

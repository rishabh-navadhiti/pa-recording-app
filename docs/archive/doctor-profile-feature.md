# Doctor Profile Feature (Templates Tab)

**Branch:** `develop-rs`
**Date:** 2026-04-22

## What this is

A second tab in the app popup — **Templates** — lets a scribe:

1. See the current list of doctor profiles (templates) registered in the app.
2. Remove or replace a template file.
3. Upload a pre-made `.md` template (existing flow, moved to this tab).
4. **NEW:** Generate a template from scratch by handing the app a folder of sample notes. The app stages the files and runs the `create-doctor-profile` skill via Claude Opus 4.7 (max effort), which analyses the notes and writes out a profile.

The previous flow required a user to generate a template in Claude Code Desktop first, then upload the resulting `.md`. The new flow does that step in-app as a background job.

## Why not XML in the template markdown

Existing templates (`spencer.md`, `ryan.md`, `sabbag.md`, etc.) are plain markdown with headers, bold fields, code blocks, and verbatim quotes. Sonnet 4.6 reads them reliably when generating SOAP notes. Adding XML tags would:

- Add noise without evidence it helps
- Make templates harder to hand-edit
- Create a migration burden for existing templates

If we ever see Sonnet misinterpreting sections, we can revisit. For now the skill emits pure markdown.

## Model selection

Both the note-generation and template-creation models are now declared in `settings.json`:

```json
{
  "soapModel":      "claude-sonnet-4-6",
  "templateModel":  "claude-opus-4-7",
  "templateEffort": "max"
}
```

- `soapModel` is passed as `--model` to `claude -p` during SOAP generation.
- `templateModel` + `templateEffort` are applied to the create-doctor-profile run. `templateEffort` is set via the `CLAUDE_CODE_EFFORT_LEVEL` env var (per [Anthropic's effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)). Supported levels: `low`, `medium`, `high`, `xhigh`, `max`.

UI controls for these will come in a later pass. For now, the values can be changed by editing `settings.json` directly.

## Architecture — where templates live

No change to the existing model:

- Templates are files at `<NOTES_DIR>/templates/<lastname>.md`
- The registry is `settings.doctors[]` in `settings.json`, each entry `{ id, name, templatePath }`
- `generate-note` reads `templatePath` from the active doctor when producing SOAP notes
- The doctor picker at session start uses `settings.doctors`

The AI-generation flow plugs into this same registry — on success, the new doctor is added to `settings.doctors`, same shape as the upload flow.

## The flow (Create with AI)

1. User enters the **Templates** tab and clicks **Create with AI**
2. Sub-view appears: doctor name input + "Add files" button + Start
3. Clicking Add files opens a native multi-select file picker (electron `dialog.showOpenDialog`). The user can add files across multiple rounds — each add merges into the staged list. Individual files can be removed before Start.
4. On Start, main.js:
   - Creates `<NOTES_DIR>/Templates/_staging/<lastname>/`, wiping any leftover from a prior failed run
   - Copies all selected files into that folder
   - Spawns `claude -p "create a doctor profile for \"<name>\" from source folder \"Templates/_staging/<lastname>\"" --model claude-opus-4-7 --dangerously-skip-permissions` with `CLAUDE_CODE_EFFORT_LEVEL=max` and `cwd = NOTES_DIR`
5. The skill (`notes-claude/skills/create-doctor-profile/SKILL.md`) runs: inventories files, classifies notes vs supporting docs, detects format, splits/loads notes, runs the analysis passes, writes `<NOTES_DIR>/templates/<lastname>.md`
6. On successful completion:
   - main.js checks the expected template path exists
   - Registers the doctor in `settings.doctors` (updates existing entry if the doctor was already registered)
   - Deletes the staging folder
   - Fires an OS notification: "Template ready"
   - Updates the Templates tab list
7. On failure (Claude non-zero exit, usage-limit detection, or file not produced):
   - Staging folder is kept for debug
   - A red banner in the Templates tab explains what happened
   - OS notification fires with a "check app.log" hint

## Concurrency

- Only one template-creation job runs at a time (enforced by a lock on `templateJobProc`)
- Job status is persisted to `<NOTES_DIR>/.template_job.json` — the renderer polls this file every 3 seconds while the Templates tab is active, so the banner updates even when the popup is closed and reopened
- On app restart, any stale `running` status in the file is converted to `failed` (the orphaned process is gone)

## File layout (additions)

```
notes-claude/skills/create-doctor-profile/
  SKILL.md                              # new skill, markdown output

docs/
  doctor-profile-feature.md             # this file

<NOTES_DIR>/
  .template_job.json                    # job status (created on first run)
  Templates/_staging/<lastname>/        # transient — deleted on success
  templates/<lastname>.md               # final template output
```

## Files changed in this branch

- `main.js`:
  - `DEFAULT_SETTINGS` extended with `soapModel`, `templateModel`, `templateEffort`
  - `spawnSoapGeneration` now passes `--model` from `settings.soapModel`
  - `spawnTemplateCreation`, `readTemplateJob`, `writeTemplateJob`, `broadcastTemplateJob` added
  - IPC handlers: `browse-notes-files`, `start-template-creation`, `get-template-job-status`, `cancel-template-creation`
  - Startup: clears stale `running` job state
  - Popup height bumped 360 → 420 to fit the bottom tab bar
- `preload.js`: new api methods (`browseNotesFiles`, `startTemplateCreation`, `getTemplateJobStatus`, `cancelTemplateCreation`, `onTemplateJobStatus`)
- `renderer/index.html`:
  - Recording content wrapped in `#tab-record`
  - New `#tab-templates` with list + create-with-AI sub-view + job banner
  - New `#tab-bar` (bottom nav)
  - Header row picks up a `#tab-title` element shown when not on Record
- `renderer/renderer.js`: tab switching, template list rendering, create-with-AI flow, job polling + status banner
- `renderer/styles.css`: all styles for the above

## What was intentionally left alone

- The existing **Settings → Doctors** section. It stays as-is and points at the same `settings.doctors` array — both surfaces read/write the same data. The Templates tab is the richer UX; the Settings entry point is a fallback. It can be removed in a later pass once the Templates tab is proven.
- The doctor picker at session start. Unchanged.
- Existing SOAP generation behavior — the only change is that the model is now explicit (`claude-sonnet-4-6`) instead of relying on the Claude CLI default. If the CLI default was already sonnet, this is a no-op.

## Deciding between the two template paths

| When to use... | Path |
|---|---|
| You already have a finished template file from Claude Code Desktop | "Add .md" |
| You only have sample notes — let the app build the profile | "Create with AI" |

## Open items / future work

- UI to toggle models in Settings (currently edit `settings.json` directly)
- "Modify template through a prompt" — the user mentioned this as a future option; not in this pass
- Show progress beyond elapsed-time (token count, current step from skill stdout) — possible by parsing the log stream
- Retry button on failed banner (currently user has to re-enter the sub-view)

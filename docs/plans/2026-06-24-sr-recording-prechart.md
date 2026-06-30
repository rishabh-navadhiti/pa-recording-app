# Plan: In-recording Pre-chart capture → feed initial note generation

**Branch:** `feature/recording-prechart` (from `develop`)

---

## Context

Today's only "Pre-chart" feature is a top-level tab that **edits an already-generated SOAP note** post-hoc (the `edit-note` / `edit-note-api` skill). There is no way for a scribe to supply pre-visit context (referral text, prior notes, lab PDFs, free-text reminders) *during a live recording* so it shapes the **initial** note.

This feature adds an in-recording **Pre-chart** screen: while a recording is in progress the scribe taps **Pre-chart**, lands on a sub-screen to type context and attach `.md/.txt/.docx/.pdf` files, and taps **Back** — the recording timer/status stays visible the whole time. When the recording is stopped and the SOAP note is generated, that captured context is bundled with the transcript and sent to the Anthropic API via a **new skill** (separate from `edit-note`), so the note is produced *with the pre-chart baked in*.

Decisions (confirmed with user):
- **Availability:** Pre-chart button shows in `RECORDING` and `PAUSED` only (the active recording) — not before recording starts.
- **Flow:** context feeds the **initial** note generation (not a separate document, not an edit).
- **Provider:** wire only the single-call **API** path (`generateSoapViaApi`, the default `soapModel = sonnet-4-6-api`). The CLI/agentic path is left unchanged and ignores pre-chart for now (documented limitation).

---

## Design overview

1. **Capture (renderer):** a new sub-view *inside* `#tab-record` (like `patient-form`/`upload-form`), so the `#indicator`/`#status-label`/`#timer` row — which lives **outside** `#action-buttons` — stays visible automatically. No new app STATE; no tab. Recording timer keeps running.
2. **Hold (main):** captured `{ text, files[] }` is stored in `recorderController` (the in-flight recording store). Renderer pushes on Back/save and pulls on open, so it survives window hide/show and is the source of truth.
3. **Persist (pipeline):** at `stop-recording`, combine text + extracted attachments into one markdown blob, hand it to `ingestAudio`, which writes `<caseDir>/prechart.md` right after creating the case folder (mirroring its existing realtime-JSON copy block) and hides it on Windows.
4. **Generate (API):** `generateSoapViaApi` detects a sibling `prechart.md`; if present it (a) reads it, (b) uses the **new** `generate-note-prechart-api` skill, (c) passes `prechartText` into `buildSingleCallNoteGen` — for the single-patient call **and** every multi-patient fan-out call.

---

## Files created

### 1. `notes-claude/skills/generate-note-prechart-api/SKILL.md`
Copy of `generate-note-api/SKILL.md` (condensed single-document system prompt, all-caps headers) plus one rule:

> **PRE-CHART CONTEXT.** The user message may include a `PRE-CHART CONTEXT` block — clinician-supplied background and instructions for *this* visit, gathered before/during the encounter (referral info, prior notes, labs, scribe reminders). Treat it as authoritative clinical facts and explicit instructions to incorporate, **second only to INJECTED FACTS**. It does NOT override the TEMPLATE's format/structure or invent note sections, and the transcript remains the source for the encounter narrative. Reconcile, never fabricate beyond transcript + pre-chart + injected facts.

Manifest stays `"skill":"generate-note"`, `schema_version:1` — identical shape — so `splitNoteAndManifest()` and the whole downstream chain (`runCaseChain`/`runMultiPatientChain`) are untouched.

### 2. `renderer/views/prechartCapture.js`
A `{ mount, open, close, update, unmount }` sub-view (pattern from `uploadForm.js`/`patientForm.js`). Owns `#prechart-capture-view`:
- `open()` → `ipc.getPrechartContext()` to populate textarea + file list (via shared `renderFileList` from `components/fileListField.js`), hide `#action-buttons` + `#view-status-bar`, show the sub-view.
- **+ Add files** → `ipc.browsePrechartFiles()` (reuse the existing picker — same `.md/.txt/.docx/.pdf` filters), dedupe-append, re-render list.
- **Back** → `ipc.savePrechartContext(text, files)`, then `close()` and re-render record buttons via the callback passed at mount.

---

## Files modified

### 3. `renderer/index.html`
Add `#prechart-capture-view` block inside `#tab-record` (next to `#upload-form`), reusing existing `.subview-header` + `.create-template-files-empty` styles: Back (`←`) header, a `<textarea id="prechart-capture-text">`, `<div id="prechart-capture-files">`, **+ Add files** button, **Back/Done** button.

### 4. `renderer/views/recordView.js`
- Mount `prechartCaptureView` alongside the other sub-views; pass it an `onClose` that re-runs `render(currentRenderedState)`.
- In `render()`'s reset block add `setVisible(prechartCaptureEl, false)` so any state push cleanly closes the capture screen (same as the other sub-views).
- In `RECORDING` and `PAUSED` cases, append a **Pre-chart** button (`makeButton('Pre-chart', () => prechartCaptureView.open(), 'outline')`).

### 5. `context/recorderController.js`
Add a `_prechart` field (default `{ text: '', files: [] }`) + `setPrechart(obj)`, `getPrechart()`, `consumePrechart()` (returns then resets), `clearPrechart()`. Reset it in `discard()` and `clearProcess()` (so a discarded/aborted recording drops its context).

### 6. `src/ipc/recording.js`
- **New handlers** (registered with the recording/session domain): `SAVE_PRECHART_CONTEXT` → `recorder.setPrechart({text, files})`; `GET_PRECHART_CONTEXT` → `recorder.getPrechart()`. Add `recorder` getters + `buildCombinedAttachment`/`combineAttachments` to the `deps` bag in `registerIpcHandlers()` (main.js).
- **`stop-recording`**: after consuming patient name, `consumePrechart()`. If it has text or files: extract files via `combineAttachments(files)` (from `src/pipeline/attachments.js`), prepend a `# Pre-chart context\n\n<text>` block, write to a temp `.md`, and pass its path to `ingestAudio` as a new `prechartSrc` option. Clean up the temp file after ingest. Empty context → pass nothing (no `prechart.md` written).

### 7. `src/pipeline/ingest.js`
Add optional `prechartSrc` to `ingestAudio`. When present, copy it to `path.join(caseDir, 'prechart.md')` immediately after the audio-copy step and `ctx.platform.hideInternal()` it — directly mirroring the existing realtime-transcript copy block (lines ~59-69). Written **before** `spawnTranscription`, guaranteeing it exists when SOAP generation runs.

### 8. `src/llm/skill-io/singleCall.js`
`buildSingleCallNoteGen({ ..., prechartText })`: when `prechartText` is non-empty, insert a labeled block — `PRE-CHART CONTEXT (clinician-supplied — authoritative background for this visit):\n---\n<prechartText>\n---` — between INJECTED FACTS and DOCTOR TEMPLATE. No change when absent (existing callers unaffected).

### 9. `main.js` — `generateSoapViaApi`
After `const caseDir = path.dirname(soapNoteMdPath)`:
- `const prechartPath = path.join(caseDir, 'prechart.md')`; if it exists and is non-empty, read `prechartText` and set `skillPath` to `generate-note-prechart-api/SKILL.md` instead of `generate-note-api`.
- Thread `prechartText` into **both** `buildSingleCallNoteGen` calls (single-patient, line ~485; and the fan-out loop, line ~557).
- Log `[soap:api] using pre-chart context (<N> chars)` when active.

### 10. `src/shared/ipc-channels.js` + `preload.js`
Add `SAVE_PRECHART_CONTEXT: 'save-prechart-context'` and `GET_PRECHART_CONTEXT: 'get-prechart-context'` to `CHANNELS` (prechart section). Expose `savePrechartContext(text, files)` and `getPrechartContext()` in `preload.js` (literal channel strings — the shared-drift test enforces they match). Reuse the existing `browsePrechartFiles`.

### 11. Docs
- `CLAUDE.md`: add the two methods to the IPC table; add a short note to the **Recording pipeline** section (prechart.md capture + new skill) and the skill list.
- `docs/ARCHITECTURE.md`: note `prechart.md` in the case-folder file flow + the generate-note-prechart-api branch.
- `docs/DECISIONS.md`: dated entry — why a separate skill (keep `generate-note-api` clean; manifest unchanged), why API-only, why stored in recorderController.
- After merge: `git mv` this plan into `docs/archive/plans/` and remove its line from `docs/plans/README.md`.

---

## Key reuse

| What | Where |
|---|---|
| Attachment extraction (md/txt/docx/pdf) | `combineAttachments()` — `src/pipeline/attachments.js` |
| File-list UI widget | `renderFileList()` — `renderer/components/fileListField.js` |
| Sub-view-inside-record-tab pattern | `renderer/views/uploadForm.js`, `patientForm.js` |
| File picker (same filters) | existing `BROWSE_PRECHART_FILES` handler — `src/ipc/prechart.js` |
| API single-call build/split | `buildSingleCallNoteGen` / `splitNoteAndManifest` — `src/llm/skill-io/singleCall.js` |
| In-flight recording store | `context/recorderController.js` |
| Provider resolution | `resolveOption()` — `src/llm/modelOptions.js` |

---

## Out of scope / known limitations
- **CLI/agentic provider** (`sonnet-4-6-agentic`) does not consume pre-chart — `prechart.md` is still written to the folder but the CLI `generate-note` skill ignores it. (Default is API, so the live path is covered.)
- Pre-chart context is per **recording**, captured live; it is not editable from the existing Pre-chart (edit-note) tab.

---

## Tests
- `tests/unit/recorder-controller.test.js` (new or extend): set/get/consume/clear prechart; `discard()`/`clearProcess()` reset it.
- `tests/unit/prompts.test.js` (or a `singleCall` test): `buildSingleCallNoteGen` includes the PRE-CHART CONTEXT block when `prechartText` is passed, omits it otherwise.
- `tests/unit/shared-drift.test.js`: auto-covers the two new channels once added to both `CHANNELS` and `preload.js`.
- `npm test` green; `npm run test:py` unaffected.

## Verification (manual, `npm start`)
1. Settings → SOAP model = **Sonnet 4.6 (API)** (default).
2. Start Session → Start Recording → tap **Pre-chart**. Confirm the timer/status indicator stays visible on the capture screen.
3. Type context, **+ Add files** (attach a `.docx` + `.pdf`), tap **Back**. Reopen Pre-chart → fields are repopulated (pulled from main).
4. **Save Case**, name the patient. Confirm `<caseDir>/prechart.md` exists (combined text + attachments) and is hidden on Windows.
5. After generation, open the SOAP `.docx` → pre-chart facts are reflected. Check `app.log` for `[soap:api] using pre-chart context` and that the skill used was `generate-note-prechart-api`.
6. Repeat with **no** pre-chart → no `prechart.md`, generation uses `generate-note-api` exactly as before (regression check).
7. Discard a recording mid-way after adding pre-chart → starting a new recording shows an empty Pre-chart screen (store cleared).

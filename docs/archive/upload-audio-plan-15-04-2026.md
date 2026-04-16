# Plan: Pre-recorded Audio File Processing

## Overview

Add an option in the UI to process a pre-recorded audio file instead of recording live. The selected file is copied into a case folder and fed into the existing transcription → SOAP note → DOCX pipeline unchanged.

---

## Phase 1: UI — Add "Upload Audio" Entry Point

**File:** `renderer/index.html`

Add a second action button alongside "Start Recording" visible in the **SESSION_ACTIVE** state. Label: "Upload Audio File".

**File:** `renderer/renderer.js`

- Show the new button only in `SESSION_ACTIVE` state (same condition as "Start Recording")
- On click, call a new IPC method `api.browseAudioFile()` which opens a native file picker

**File:** `renderer/styles.css`

- Style the new button as a secondary/outline variant so it is visually distinct from the primary "Start Recording" button

---

## Phase 2: IPC — File Picker Dialog

**File:** `preload.js`

Expose a new method `browseAudioFile` on the `api` object via `contextBridge`, invoking a new IPC channel `browse-audio-file`.

**File:** `main.js`

Add an `ipcMain.handle('browse-audio-file')` handler that:
1. Opens `dialog.showOpenDialog` with filters for audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`, `.mp4`)
2. Returns the selected file path, or `null` if cancelled

---

## Phase 3: UI — Patient Name Form for Uploaded File

**File:** `renderer/renderer.js`

After a file is selected (non-null response from `browseAudioFile`):
1. Transition to a new UI state (e.g. `UPLOAD_NAMING`)
2. Show the patient name form immediately — no 30-second countdown needed since the user is present and intentionally uploading
3. "Save" and "Skip" buttons work identically to the post-recording flow
4. On submit, call a new IPC method `api.processAudioFile(filePath, patientName)`

The patient name form structure and behavior should be identical to the post-recording form.

---

## Phase 4: Main Process — File Copy + Pipeline Entry

**File:** `main.js`

Add an `ipcMain.handle('process-audio-file')` handler that accepts `{ filePath, patientName }` and:

1. **Sanitize patient name** — reuse the existing sanitization logic (lines ~482-488)
2. **Create case folder** — same naming logic as recording:
   - With name: `{sanitizedName}_{YYYY-MM-DD}`
   - Without name: `recording_{YYYY-MM-DD}_{timestamp}`
3. **Copy the source audio file** into the case folder:
   - Preserve the original file extension (ElevenLabs accepts mp3, wav, m4a, etc.)
   - Destination filename: `{sanitizedName}{originalExtension}` or `recording{originalExtension}`
4. **Spawn transcription** — call the same transcription spawn logic used in `stop-recording`, passing the copied file path and transcript destination
5. **Let the existing pipeline continue** — the transcription exit handler already calls `spawnSoapGeneration` → `spawnDocxConversion`

Extract patient name sanitization and case folder creation into a shared helper used by both the recording flow and the upload flow.

---

## Phase 5: State Management & UI Feedback

**Files:** `renderer/renderer.js`, `main.js`

- After `process-audio-file` IPC call is sent, transition renderer to `PROCESSING` state with label "Processing uploaded audio..."
- Reuse existing `setState` broadcast so the renderer reacts identically to the recording flow
- When processing completes (or errors), renderer returns to `SESSION_ACTIVE` as normal
- If user cancels the file picker (returns `null`), stay in `SESSION_ACTIVE` — no state change

---

## Summary of Changes

| File | Change |
|------|--------|
| `renderer/index.html` | Add "Upload Audio File" button in SESSION_ACTIVE section |
| `renderer/styles.css` | Style new button as secondary variant |
| `renderer/renderer.js` | Handle button click, new `UPLOAD_NAMING` state, call new IPC methods |
| `preload.js` | Expose `browseAudioFile` and `processAudioFile` on `api` |
| `main.js` | Add `browse-audio-file` dialog handler, `process-audio-file` handler (copy file + run pipeline), extract shared name sanitization + case folder creation helper |

---

## What Stays Unchanged

- `python/transcribe.py` — no changes needed; accepts any audio file path
- `python/record.py` — not involved in this flow
- `notes-claude/skills/generate-note/SKILL.md` — unchanged
- `python/md_to_docx.py` — unchanged

The final folder/file structure produced is identical to the recording flow:

```
Cases/{patientName}_{YYYY-MM-DD}/
├── {patientName}.mp3        (copied source file)
├── transcript.md
├── {patientName}_{YYYY-MM-DD}_soap_note.md
└── {patientName}_{YYYY-MM-DD}_soap_note.docx
```

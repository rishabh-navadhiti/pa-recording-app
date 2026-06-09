# AI Medical Scribe — Overview

Start here if you're new to the project. Sister docs: [ARCHITECTURE.md](ARCHITECTURE.md) for the deep technical view, [DECISIONS.md](DECISIONS.md) for why things are the way they are, [plans/](plans/) for in-flight features.

---

## What this is

A desktop app for **medical scribes** that automates the most tedious parts of their job:

1. **Captures audio** from a doctor's patient consultation (the scribe is remote, joining a Microsoft Teams call and listening through their headset — the app records exactly what they hear via system audio loopback).
2. **Transcribes the audio** to a diarised, speaker-labelled markdown file using ElevenLabs' speech-to-text.
3. **Generates a SOAP note** from the transcript using a **per-doctor template** that captures *that specific doctor's* phrasing, structure, and documentation preferences. Powered by the local `claude` CLI (Anthropic).
4. **Appends ICD-10-CM diagnosis codes** to the note via the claude.ai ICD-10 MCP connector.
5. **Renders the final note as `.docx`** so it can be pasted into the EMR.

Windows is the primary platform; macOS works but needs the BlackHole virtual audio driver.

## Who uses it

Medical scribes — non-clinicians employed by a clinic (or contracted) whose job is to write clinical notes during/after consultations so the doctor doesn't have to. Typically remote, listening to Teams calls.

The app is also designed so that a doctor could use it directly (Phase 2), but Phase 1 targets the scribe-listening-remotely workflow.

## The end-to-end user flow

```
Open app → Start Session → Pick Doctor (if >1) → Start Recording (timer running)
                                                       │
                                                       ▼
                                        ┌── Pause/Resume (mid-call)
                                        │
                                        ▼
        Stop Recording → Patient-name form → Save Case
                                                       │
                                                       ▼
                              ▶ Returns to "Session active" immediately
                                (scribe can start next case right away)
                                                       │
                                  (in the background, pipeline runs:)
                                                       │
                                                       ▼
        audio.mp3 → transcript.md → soap_note.md → ICD codes appended → .docx generated
                                                       │
                                                       ▼
                              ▶ Notification + "open note" button when ready
```

When done for the day, the scribe hits **Stop Session**. All files land in `~/Documents/AI Medical Notes/Cases/<patient>_<YYYY-MM-DD>/`.

## The three tabs

The app's popup window has a bottom tab bar:

| Tab | Purpose |
|---|---|
| **Record** | The main flow above — sessions, recordings, patient names. The default tab. |
| **Pre-chart** | "Edit a note I already generated." Pick a case, attach reference files (lab results, referral letters, PDFs), type corrections — Claude re-generates the SOAP note with the new context. Backs up the previous version. |
| **Templates** | Manage per-doctor templates. Add/remove doctors; assign template files; or use **Create with AI** to generate a fresh template by feeding Claude ~50 sample notes from that doctor; **Update with AI** lets you correct an existing template with natural-language instructions. |

## Doctor templates — the key concept

Every doctor writes SOAP notes differently:
- One uses bulleted lists, another uses prose paragraphs
- One says "patient reports", another says "patient states", another uses "patient endorses"
- One puts a referral disclaimer at the end of every note, another never does
- Field ordering, abbreviations, what's always/never included — all idiosyncratic

The app captures this in a **template file** per doctor (markdown, lives at `<NOTES_DIR>/templates/<lastname>.md`). The template describes:
- Global style rules (attribution verb, tense, pronouns, abbreviations)
- Boilerplate text blocks the doctor reuses verbatim
- Per-note-type sections with field-by-field instructions

When a SOAP note is generated, the template is fed to Claude alongside the transcript. The output is "this doctor's note for this consultation" — not a generic AI note.

Templates can be hand-written, but it's tedious. The **Create with AI** flow analyses ~50 of a doctor's past notes and builds the template automatically (uses Opus 4.8 at max effort by default, takes several minutes).

## Tech stack at a glance

| Layer | Tech | What it does |
|---|---|---|
| Shell | **Electron** (Node.js) | Window, tray icon, IPC, child-process orchestration |
| UI | Vanilla HTML/CSS/JS | Single popup window, state-driven rendering, three tabs |
| Audio capture | **Python + PyAudioWPatch (Windows)** / sounddevice + BlackHole (macOS) | System audio loopback to WAV → MP3 |
| Transcription | **Node + ElevenLabs scribe_v2** API (native `fetch`, `src/pipeline/elevenLabs.js`) | Diarised speech-to-text |
| Attachment extraction | **Node + mammoth/pdf-parse** (`src/pipeline/attachments.js`) | Pre-chart `.docx`/`.pdf` → combined `.md` |
| Note generation | **Local `claude` CLI** (Anthropic), via the `ctx.llm` provider seam | Runs project-bundled skills |
| ICD coding | **claude.ai ICD-10 MCP connector** | Tools called from inside the coding skill |
| Word export | **Python + python-docx** | Markdown → .docx with proper tables, headings, formatting |

**The skills folder** (`notes-claude/`) is the secret sauce. Each skill is a markdown file (`SKILL.md`) that tells Claude exactly how to do one thing — analyse a doctor's notes to build a template, generate a SOAP note from a transcript+template, etc. The app bundles this folder and copies it into the user's notes directory at runtime so the `claude` CLI can find it.

## What's where on disk

Two directories matter:

**Repo** (the cloned source): code, bundled skills (`notes-claude/`), this docs/ folder.

**`<NOTES_DIR>`** (user's notes folder, conventionally `~/Documents/AI Medical Notes/`): all user data — case folders, templates, settings, logs, and the live copy of `.claude/` (synced from the repo).

```
<NOTES_DIR>/
├── settings.json                       app settings (doctors, models, audio device, …)
├── app.log                             single log stream
├── .claude/                            synced from repo notes-claude/ on every launch
├── .mcp.json                           ICD-10 MCP connector config
├── Cases/<patient>_<YYYY-MM-DD>/
│   ├── <patient>.mp3                   the audio recording
│   ├── transcript.md / .docx           diarised, by speaker
│   ├── *_soap_note.md / .docx          final note with ICD codes
└── templates/
    ├── <lastname>.md                   per-doctor template
    ├── _staging/                       transient — during Create with AI
    └── backups/                        timestamped backups before AI edits
```

## What makes the app non-obvious

A few things that surprise new contributors:

- **The state machine is in two places.** `IDLE → SESSION_ACTIVE → RECORDING ↔ PAUSED → PROCESSING → SESSION_ACTIVE` is defined in both `main.js` (via `src/shared/state.js`) and `renderer/constants.js`. They must stay in sync (drift-tested). See [ARCHITECTURE.md § state-machine](ARCHITECTURE.md#state-machine-details).
- **Recording stops via stdin, not signal.** `context/recorderController.js` writes `stop\n` to the Python child's stdin instead of killing it, because Windows' `TerminateProcess` skips Python cleanup code (and we need the WAV→MP3 conversion to finish). See [DECISIONS.md § stop-via-stdin](DECISIONS.md).
- **The pipeline runs detached after Stop.** The UI returns to `SESSION_ACTIVE` as soon as the case folder is built — the transcribe→soap→icd→docx chain runs in the background so the scribe can start the next case immediately.
- **Skills live in the repo, run from the user's notes-dir.** `notes-claude/` is the source of truth and is copied to `<NOTES_DIR>/.claude/` on every app launch. Edits to the runtime copy get overwritten.
- **One job lock for three operations.** Template-create, template-update, and pre-chart-edit-note all share the same single-flight background-job slot (`ctx.stores.jobs`, driven by `src/jobs/jobDispatcher.js`) and status file. Only one at a time.
- **Best-effort ICD coding.** The ICD step runs between SOAP generation and DOCX export. If it fails (MCP auth issue, model glitch), the pipeline falls through to DOCX anyway — a note without codes is still useful.

## Where to read next

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the full technical view: process model, pipeline sequence diagrams, IPC contract, error surfacing, file layout.
- **[DECISIONS.md](DECISIONS.md)** — append-only log of *why* we chose the architecture we did. Read before changing anything load-bearing.
- **[plans/](plans/)** — in-flight feature designs. Shipped plans get moved to `archive/plans/`.
- **`CLAUDE.md` at repo root** — context for Claude Code sessions: code map, conventions, IPC table, do-not-touch list. Loaded automatically when working in this repo with Claude Code.
- **`README.md` at repo root** — setup and run instructions for end users.

# AI Medical Scribe — App Summary

## What it is
A Windows-first system tray Electron app for medical scribes. No window, no dock icon — just a small tray icon that opens a compact popup. The scribe uses it throughout their shift to capture, transcribe, and document patient consultations happening over Microsoft Teams.

## Who uses it
A medical scribe who sits remotely and joins the doctor's Teams calls. They hear the consultation through their headset — the app records exactly that audio (system loopback, no extra hardware needed).

## The workflow
1. **Start of shift** → press **Start Session**
2. **Doctor joins Teams call with patient** → press **Start Recording** → timer counts up in the popup
3. **End of patient case** → press **Save Case** → type patient name (or skip) → app immediately returns to "Session active" so the scribe can start the next recording
4. **In the background**, two things happen automatically:
   - ElevenLabs transcribes the audio → `transcript.md` (diarized, Speaker 1 / Speaker 2)
   - Claude Code generates a SOAP note → `{case}_soap_note.md` using the doctor's template
5. **End of shift** → press **Stop Session**

All files land in `~/Documents/AI Medical Notes/Cases/{patient}_{date}/`.

## How it works — technically

| Layer | Technology | Role |
|---|---|---|
| Shell | Electron (Node.js) | System tray, popup UI, process orchestration |
| UI | Vanilla HTML/CSS/JS | State-driven popup (IDLE → SESSION → RECORDING → PROCESSING) |
| Audio capture | Python + PyAudioWPatch | WASAPI loopback — records all system audio output on Windows |
| Transcription | Python + ElevenLabs API | HTTP POST to `scribe_v1`, diarized, parses `words[]` array → markdown |
| Note generation | Claude Code CLI (`claude -p`) | Runs from `AI Medical Notes/` directory, triggers the bundled `generate-note` skill |
| Skill | `notes-claude/skills/generate-note/SKILL.md` | Reads transcript + doctor template → generates structured SOAP note |

## Key design decisions
- **Non-blocking pipeline**: transcription and SOAP generation run in the background — scribe can start the next patient's recording in seconds
- **stdin stop signal**: on Windows, Node sends `stop\n` to Python's stdin instead of killing the process, giving Python time to flush audio and convert WAV→MP3
- **Self-contained setup**: `notes-claude/` is bundled in the repo and auto-copied to `AI Medical Notes/.claude/` on first app start so the skill is always available
- **Doctor hardcoded** to `'sabbag'` for demo — will be made configurable per-session in a future release

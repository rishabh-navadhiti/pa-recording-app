# Feature Suggestions — 16 Apr 2026

---

## Quick Wins (1-2 days each)

- **MP3 file size validation before transcription** — currently a silent 0-frame recording gets sent to ElevenLabs and returns a 400 error with no useful message to the scribe. Simple file size check before the API call.

- **Startup diagnostics log** — on launch, log OS version, Python version, ffmpeg version, and the full audio device list. Saves hours of remote debugging when a scribe has issues.

- **Mute notifications reminder** — small one-time banner in the UI when a session starts: "Mute system notifications to avoid mixing audio." Teams calls + notification sounds is a real contamination risk.

- **Case history in the popup** — a simple scrollable list of today's cases with their status (processing / done / failed). Right now the scribe has no visibility into what happened to recordings from the current session.

---

## Medium Effort (2-4 days each)

- **Audio device selector** — a dropdown in settings to manually pick the loopback device. Safety net for any future device enumeration issues beyond the 5-pass matching fix.

- **Re-run pipeline on a case** — a button to re-trigger transcription + SOAP generation on an existing MP3 in the Cases folder. Useful when SOAP generation fails or when regenerating with an updated template/doctor profile.

- **Session summary** — when "Stop Session" is pressed, show a summary: "3 cases recorded, 3 processed, 0 failed" with a link to open the Cases folder.

- **Doctor profile switcher in UI** — quick dropdown to switch the active doctor without editing the .env file. Relevant if a scribe works with more than one doctor in a day.

---

## Longer Term / Post-April

- **Per-case status tracking** — a lightweight JSON file tracking each case through pipeline stages (recorded → transcribed → soap_generated → docx_saved). Enables the re-run feature and case history view, and makes failure recovery reliable.

- **Teams integration** — detect when a Teams call starts/ends and auto-start/stop recording. Possible via Windows audio session events or the Teams activity feed API.

- **Audio quality check** — after recording stops, check average amplitude of the MP3. If near-silence (scribe forgot to unmute system audio), warn before submitting to ElevenLabs.

- **Scribe dashboard (web)** — a simple read-only web view of all cases, statuses, and generated notes across all scribes. Useful once 5+ scribes are generating notes daily.

---

## Priority for April (highest impact for live scribes)

1. **Case history in the popup** — scribes need visibility into what happened to their recordings
2. **MP3 size validation** — prevent silent failures reaching ElevenLabs
3. **Re-run pipeline button** — self-service recovery without needing developer intervention

# ElevenLabs Realtime vs Batch Transcription

This note explains how each transcription mode works and when to use one over the other.

---

## Batch mode (default)

**How it works:**

1. Python records audio to a temp WAV file throughout the entire consultation.
2. When you click **Stop**, Python flushes the WAV, converts it to a 16 kHz mono MP3, and exits.
3. Node POSTs the complete MP3 to `https://api.elevenlabs.io/v1/speech-to-text` using the `scribe_v2` model.
4. ElevenLabs processes the entire file from start to finish and returns the full diarised transcript.
5. Node formats the response into `transcript.md` and triggers SOAP generation.

**Latency:** ElevenLabs receives the file *after* recording ends and processes it sequentially — typically 30–90 seconds after a 10–15 minute consultation.

---

## Realtime mode (experimental)

**How it works:**

1. Python starts recording audio as normal (WAV on disk).
2. Simultaneously, a background thread (`RealtimeTranscriber`) opens a WebSocket connection to `wss://api.elevenlabs.io/v1/speech-to-text/stream`.
3. Every PCM audio chunk that the capture callback writes to the WAV is *also* queued and sent to ElevenLabs over the WebSocket as a binary frame.
4. ElevenLabs processes audio as it arrives (in parallel with the recording) and emits transcript events back down the WebSocket.
5. When you click **Stop**, Python sends an end-of-stream message (`{"type":"end"}`), waits for the server's final response (typically a few seconds), and writes the accumulated transcript to `<name>_realtime.json`.
6. WAV→MP3 conversion proceeds normally so the audio file is preserved.
7. Node reads the pre-written JSON, formats it with the same `formatTranscript()` function, and writes `transcript.md` — with no API call needed.

**Latency:** ElevenLabs has been processing the audio throughout the entire recording. When recording stops the server typically delivers its final result within 2–5 seconds, so the transcript is ready almost immediately.

---

## Key differences

| | Batch | Realtime |
|---|---|---|
| **Transcript ready** | 30–90 s after stop | 2–5 s after stop |
| **Network required during recording** | No | Yes — continuous WS connection |
| **Diarization quality** | Full-file context → slightly better on very long recordings | Streaming context → comparable on typical consultation lengths |
| **API cost** | Same (`scribe_v2`, same pricing) | Same |
| **Failure mode** | API error after stop | WS error during recording → automatic fall-back to batch |
| **Audio file preserved** | Yes | Yes |

---

## Fallback behaviour

If the WebSocket fails at any point (network drop, ElevenLabs error, timeout), Python logs the error to stderr and the `_realtime.json` file is either missing or empty. When Node's `transcription.js` reads `readRealtimeTranscript()` and gets `null`, it automatically falls back to the standard batch POST. The user receives a slightly slower transcript rather than a failure — the recording is never lost.

---

## When to use each

**Use Realtime when:**
- The clinic workflow is fast-paced and the scribe starts the next case immediately.
- Network connectivity is reliable (wired or strong WiFi) throughout the consultation.
- Minimising the gap between "Stop" and "SOAP note ready" is important.

**Use Batch when:**
- Network connectivity is intermittent or on mobile data — a dropped connection during recording would trigger the fallback.
- Recording very long consultations (> 30 min) where ElevenLabs full-file context may produce slightly more accurate diarisation.
- Troubleshooting — batch is the simpler, more established path.

---

## Technical notes for developers

- The streaming WS endpoint and init-message schema (`model_id`, `sample_rate`, `channels`, `encoding`) should be verified against the current ElevenLabs API documentation before production use. The implementation follows the published protocol as of mid-2025.
- Audio is sent at the device's native sample rate (typically 44100 or 48000 Hz) with the format declared in the init message; ElevenLabs resamples server-side. The saved MP3 is still downsampled to 16 kHz mono by pydub after recording, matching the batch path exactly.
- The realtime JSON is stored in the case folder as `<patient>_realtime.json` alongside the MP3 and transcript, providing an audit trail. `transcript.md` is always the authoritative formatted output regardless of which path produced it.

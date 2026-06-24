# Plan: "Enable Mic" — also capture the scribe's microphone during recording

**Branch:** `feature/enable-mic-capture` (from `develop`)

---

## Context

Today the app captures **only system audio** (WASAPI loopback on Windows / BlackHole on macOS) — i.e. what comes *out* of the doctor's Teams call. The scribe's own voice is never recorded. There are legitimate cases where the scribe (or anyone physically in the room) speaks and that speech should land in the transcript: in-person + remote hybrid visits, the scribe reading back / clarifying, a clinician dictating in the room.

This feature adds a **Settings → "Enable microphone"** toggle. When on, recording captures the local microphone **in addition to** the loopback stream, mixes the two, and the mixed audio is what gets transcribed. When off, behavior is byte-for-byte identical to today (loopback only).

### Decisions (defaults — confirm any you want changed)

1. **Mix strategy = two WAVs, post-overlay.** Each source records to its own WAV during capture; on stop they're mixed with `pydub.overlay()` before WAV→MP3. This avoids real-time sample-accurate mixing (drift, callback synchronisation) entirely — pydub aligns both from t=0 and normalises rate/channels. Lowest-risk path and it reuses the existing `wav_to_mp3` step.
2. **Default mic, no device picker in v1.** Use the OS default input device (`get_default_input_device_info()` on Windows, default input on macOS). A mic-device dropdown in Advanced Settings is a clean follow-up (see *Out of scope*), not v1.
3. **Mic capture and realtime transcription are mutually exclusive.** Realtime streams loopback only and its JSON is used *instead of* batch transcription — so if mic were on with realtime, the scribe's speech would silently vanish from the transcript. When `enableMic` is on, `recording.js` does **not** pass `--realtime`; transcription runs on the mixed MP3 (which contains both). Documented in the UI hint.
4. **Mic failure never fails the recording.** If the mic device can't be opened, log a warning, surface a `setup-warning`, and continue **loopback-only**. A missing mic must not lose the consultation audio.
5. **Levels:** v1 uses a plain overlay (sample sum). A per-source gain knob is a follow-up; noted as a tunable in `record.py`.

---

## Design overview

```
record.py --output rec.mp3 --mic [--mic-device N]
   ├─ loopback stream  → rec_tmp.wav   (existing path, unchanged)
   └─ mic stream       → rec_mic.wav   (NEW, second concurrent input stream)
on stop:  overlay(rec_tmp.wav, rec_mic.wav) → 16k mono → rec.mp3 → transcribe
on discard: delete both WAVs, exit silently (no MP3)
```

- The mic stream is a **second input stream** opened on the default input device, running its own callback into `rec_mic.wav`, honouring the same `stop_event` / `pause_event` / `discard_event`.
- The mic stream is opened at the **mic device's own native sample rate** (no forced resample) — pydub normalises both WAVs to 16 kHz mono before overlay, so rate/channel mismatch between the two devices is handled in one place at the end.
- Everything is gated on a single new setting `enableMic`. Default off ⇒ zero behavioural change.

---

## Files modified

### 1. `config/settings.js`
- Add `enableMic: false` to `DEFAULT_SETTINGS`.
- No invariant coupling (independent toggle). *(Optional belt-and-braces: in `applyInvariants`, if you want to make the mutual-exclusivity authoritative on disk, force `realtimeTranscription = false` when `enableMic` is true. Recommended to keep the exclusion in one place — see §3 note.)*

### 2. `python/record.py` — the load-bearing change
- **Args:** add `--mic` (store_true) and `--mic-device` (int, default `None`).
- **`record_windows(...)`** — add `mic_enabled` / `mic_device_override` params:
  - Resolve mic device: override index if given, else `p.get_default_input_device_info()`.
  - Open a **second** `p.open(input=True, input_device_index=<mic>, ...)` at the mic's native rate/channels, with its own callback writing `rec_mic.wav` and gated by the same `stop_event`/`pause_event`. Wrap the open in `try/except`; on failure log a warning, `print('ERROR: microphone … — continuing without mic', file=sys.stderr)` is **not** used (that would trip the renderer's hard-error path) — instead emit a softer `MIC_WARNING:` line (see §4 wiring) and proceed loopback-only.
  - Close/flush the mic WAV alongside the loopback WAV in the stop path; delete it in the discard path; delete it in the 0-frames path.
  - Pass the mic WAV path into the mix step.
- **`record_macos(...)`** — same shape with a second `sd.InputStream` on the default input device (`sd.query_devices(kind='input')`), native rate, callback → `rec_mic.wav`.
- **`wav_to_mp3(...)`** → add an optional `mic_wav_path=None`. When present and non-empty:
  ```python
  sys_seg = AudioSegment.from_wav(wav_path).set_frame_rate(16000).set_channels(1)
  mic_seg = AudioSegment.from_wav(mic_wav_path).set_frame_rate(16000).set_channels(1)
  mixed   = sys_seg.overlay(mic_seg)   # aligns from t=0; tail of longer is kept
  mixed.export(mp3_path, format='mp3')
  ```
  then delete **both** WAVs. When absent, the existing single-WAV path runs unchanged.
- **Realtime interaction:** realtime currently sends the loopback callback's PCM. With mic enabled we don't pass `--realtime` (§3), so no change needed inside the transcriber — but add an assertion/log if both flags somehow arrive together (defensive).

### 3. `src/ipc/recording.js` — `start-recording` handler
- After the existing `--device` block, add:
  ```js
  if (settings.enableMic) {
    recordArgs.push('--mic')
    log('Microphone capture enabled — mixing mic + loopback')
  }
  ```
- **Mutual exclusion:** gate the existing `if (settings.realtimeTranscription)` block on `&& !settings.enableMic`, and `log` when realtime was skipped because mic is on. (Single source of truth for the exclusion; pairs with the optional normaliser in §1.)

### 4. Mic-warning surfacing (`src/ipc/recording.js` stderr handler)
The current `recProc.stderr` handler treats any line containing `ERROR` as a `setup-warning`. Mic-open failure should be a **non-fatal** notice, not the same hard error. Add a branch: lines starting with `MIC_WARNING:` → forward as `service-warning` (or a gentle `setup-warning`) with the `MIC_WARNING:` prefix stripped, and **do not** abort. `record.py` emits exactly that prefix on mic-open failure.

### 5. `src/ipc/recording.js` — `discard-recording` cleanup
Add the mic WAV to the temp-file cleanup list (alongside `_tmp.wav` and `_realtime.json`):
```js
const micWav = mp3ToDelete ? mp3ToDelete.replace('.mp3', '_mic.wav') : null
for (const p of [mp3ToDelete, wavPath, micWav, realtimeJson]) { … }
```
(`record.py` already deletes its own WAVs on the normal discard path; this is the belt-and-braces cleanup for the case where Python died before converting.)

### 6. `renderer/index.html`
In the first `.settings-group` (next to `#chk-realtime-transcription`), add:
```html
<label class="setting-row">
  <input type="checkbox" id="chk-enable-mic" />
  <span>Enable microphone</span>
</label>
<div class="setting-hint">Also record your microphone and mix it with the call audio, so anyone speaking in the room is transcribed too. Uses your default microphone. (Disables realtime transcription while on.)</div>
```

### 7. `renderer/views/settingsView.js`
- Declare `chkEnableMic`; `querySelector('#chk-enable-mic')` in `mount`.
- In `loadSettings()`: `if (chkEnableMic) chkEnableMic.checked = !!s.enableMic`.
- Wire `change` → `ipc.saveSettings({ enableMic: chkEnableMic.checked })`.
- *(Optional UX)* if you also enforce exclusivity in the UI: when mic is turned on, uncheck + persist `realtimeTranscription:false` and vice-versa, mirroring the existing `syncIcdLock` pattern. Backend already enforces it (§3), so this is cosmetic-only.

No new IPC channel is needed — `enableMic` rides the existing `getSettings`/`saveSettings` contract.

---

## Settings / config table (CLAUDE.md update)
Add `enableMic` to the `settings.json` row: *"capture the local microphone in addition to loopback and mix both into the recording; mutually exclusive with `realtimeTranscription`."*

---

## Out of scope / known limitations
- **No mic device picker in v1** — default input device only. Follow-up: add `--list-input-devices` to `record.py` + a second `<select id="mic-device-select">` in Advanced Settings, persisting `micDeviceIndex` (mirrors the existing loopback `device-select` flow).
- **No per-source gain / level balancing** — plain overlay. If the scribe's mic overpowers the call audio (or vice-versa), a `mic_gain_db` knob on the mic segment is the next lever.
- **Realtime + mic not combined** — by design (§3). True real-time mixing into the WS stream is a larger effort; deferred.
- **Echo/double-capture:** if the scribe is on the *same* machine playing the call through speakers (not headphones), the mic will also pick up the call audio → mild echo/doubling in the mix. Headphones avoid it. Note in the hint if testing shows it's a problem.

---

## Tests
- **`tests/python/`** (new `test_record_mix.py` or extend existing): unit-test the overlay branch of `wav_to_mp3` — generate two short PCM WAVs (e.g. a tone + a different tone), call `wav_to_mp3(sys, mp3, rate, mic_wav_path=mic)`, assert the MP3 exists, is 16 kHz mono, duration ≈ max(len(sys), len(mic)), and both source WAVs were deleted. Keep it `pydub`-only (already a dep) — no real devices.
- **`tests/unit/`**: `record.py` arg construction is in `recording.js` — if there's an existing arg-builder test, extend it to assert `--mic` is added when `enableMic` and that `--realtime` is **omitted** when `enableMic` is on. Otherwise a small focused test on the settings→args mapping.
- `tests/unit/shared-drift.test.js`: unaffected (no new channel).
- `npm test` green; `npm run test:py` green.

## Verification (manual, `npm start`)
1. Settings → check **Enable microphone**. Confirm Realtime transcription is now effectively off (skipped — check `app.log`).
2. Start Session → Start Recording. Play audio in a Teams/browser tab (loopback source) **and** speak into the mic.
3. Stop → name the case. Open the case folder MP3 → **both** the call audio and your voice are audible/mixed.
4. Open the generated `transcript.md` → your spoken words appear alongside the call audio.
5. Pause mid-recording, speak (should be dropped), resume → paused mic audio is excluded (pause_event honoured on both streams).
6. **Mic-failure path:** temporarily point `--mic-device` at an invalid index (or unplug/disable the mic) → recording still completes loopback-only, a non-fatal mic warning shows, no crash.
7. **Regression:** uncheck Enable microphone → recording is loopback-only and identical to today; realtime works again if enabled.
8. Discard a mic-enabled recording mid-way → both `*_tmp.wav` and `*_mic.wav` are cleaned up (check OS temp).

---

## Docs to update in the same PR
- `CLAUDE.md`: settings table row (`enableMic`); a line in **Recording pipeline** step 1 (two streams when mic on → mixed before MP3); `python/record.py` description (now opens a second input stream + mixes).
- `docs/ARCHITECTURE.md`: recording-pipeline section — the mic stream + overlay-mix step + realtime exclusivity.
- `docs/DECISIONS.md`: dated entry — why post-overlay (not real-time mix), why mic⊕realtime are exclusive, why mic failure is non-fatal.
- After merge: `git mv` this plan into `docs/archive/plans/` and remove its row from `docs/plans/README.md`.

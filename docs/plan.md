# Plan: AI Medical Scribe — Phase 1

## Context
A system tray Electron app for medical scribes who join doctors on Microsoft Teams calls. The scribe sits at their desk with Teams open, connects to the doctor's consultation, and the app silently captures what's playing through the computer (Teams audio) and transcribes it. 

**Primary use case (Phase 1):** Capture system/Teams audio (loopback) — the scribe hears the consultation through their headset/speakers, and the app records exactly what they hear.  
**Future use case (Phase 2):** Microphone recording for doctors who will use the app directly.

**Platform priority:** Windows (primary), macOS (secondary).

---

## Audio Capture Strategy

### Windows (primary platform)
Use **WASAPI loopback** via `PyAudioWPatch` (actively maintained fork of PyAudio with native WASAPI support). This captures all audio being rendered through the default output device — i.e., exactly what the scribe hears on their headset/speakers during the Teams call.

- Library: `PyAudioWPatch` (pip: `pyaudiowpatch`)
- How it works: Enumerates WASAPI loopback devices, finds the loopback device corresponding to the default output, and records from it
- No additional software needed — works out of the box on Windows Vista+
- Records at whatever sample rate the default device uses (typically 44100 or 48000 Hz)
- Caveat: Captures all system audio (Teams + any other audio playing). Acceptable for Phase 1 — instruct scribes to mute other audio during sessions.
- SIGTERM on Windows: Python signal handlers don't fire reliably when Node kills a child process. Use `recordingProcess.kill()` (no arg) in Node and check for the output file after exit.

### macOS (secondary platform)
Use **BlackHole** virtual audio driver + macOS Multi-Output Device. BlackHole is free, open-source, actively maintained (latest release Feb 2025), and the standard community solution.

**How it works:**
1. User installs BlackHole 2ch once (`brew install blackhole-2ch`)
2. User creates a Multi-Output Device in Audio MIDI Setup: Built-in Output + BlackHole 2ch (one-time setup)
3. User sets that Multi-Output Device as system output (or the app prompts them to)
4. Teams audio flows to both speakers (scribe still hears) AND BlackHole
5. Python records from the BlackHole device using `sounddevice`

**The app must:**
- Detect if BlackHole is installed (look for "BlackHole" in `sd.query_devices()`)
- If not found: log a clear error and show a message in the popup UI: "BlackHole not found. Please install: brew install blackhole-2ch"
- If found: auto-select it as the recording device

**macOS-specific:** `sounddevice` works reliably with BlackHole. Match sample rate to what's configured in Audio MIDI Setup (48000 Hz recommended).

---

## File Structure

```
/
  main.js
  preload.js
  renderer/
    index.html
    renderer.js
    styles.css
  python/
    record.py
    transcribe.py
  assets/
    tray-icon.png          ← 16x16 PNG placeholder
  package.json
  .env.example             ← ELEVENLABS_API_KEY=your_key_here
  .gitignore               ← .env, node_modules/, *.log, .DS_Store
  requirements.txt
```

Runtime folder (in `app.getPath('documents')`):
```
AI Medical Notes/
  Cases/{patient_name}_{YYYY-MM-DD}/
    {patient_name}.mp3
    transcript.md
  Templates/
  app.log
```

---

## Build Order

### 1. Scaffold
- `package.json` — name `ai-medical-scribe`, version `0.1.0`, main `main.js`, `"start": "electron ."`, devDep: `electron` latest
- `.gitignore` — `.env`, `node_modules/`, `*.log`, `.DS_Store`, `Thumbs.db`
- `.env.example` — `ELEVENLABS_API_KEY=your_key_here`
- `requirements.txt`:
  ```
  pyaudiowpatch ; sys_platform == "win32"
  sounddevice ; sys_platform == "darwin"
  soundfile
  pydub
  elevenlabs
  python-dotenv
  numpy
  ```
  Note: `pyaudiowpatch` and `pyaudio` conflict — use conditional platform installs.
- `assets/tray-icon.png` — minimal 16x16 black PNG

### 2. python/record.py
This is the most platform-sensitive file. Build and test standalone before wiring into Electron.

**CLI args:** `--output <mp3_path>` (required), `--device <index>` (optional override)

**Windows logic:**
```python
import pyaudiowpatch as pyaudio

def get_loopback_device(p):
    # Find the WASAPI loopback device for the default output
    wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    default_speakers = p.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
    # Find the loopback counterpart
    for i in range(p.get_device_count()):
        dev = p.get_device_info_by_index(i)
        if dev.get("isLoopbackDevice") and dev["name"] == default_speakers["name"]:
            return i, dev
    return None, None
```
Record via `pyaudio.PyAudio` stream in callback mode, writing chunks to a WAV via `soundfile` or direct wave module. On `stop_event`: finalise WAV, convert to MP3 via pydub, delete WAV.

**macOS logic:**
```python
import sounddevice as sd

def get_blackhole_device():
    for i, dev in enumerate(sd.query_devices()):
        if 'BlackHole' in dev['name'] and dev['max_input_channels'] > 0:
            return i, dev
    return None, None
```
If BlackHole not found: print clear error to stderr and exit non-zero. Record using `sd.InputStream` callback writing to `soundfile.SoundFile`.

**Both platforms:**
- Record until `threading.Event` set by `SIGTERM`/`SIGINT` handler (Windows: also handle `CTRL_BREAK_EVENT`)
- 16kHz mono is fine for speech — but WASAPI loopback on Windows may require recording at the device's native rate (44100 or 48000) then resampling. Detect the device's sample rate and use it; downsample to 16kHz before MP3 export using pydub.
- WAV → MP3: `AudioSegment.from_wav(wav).set_frame_rate(16000).set_channels(1).export(mp3_path, format='mp3')`
- Delete WAV after successful conversion
- Exit 0 on success, non-zero on error

**Windows SIGTERM note:** Node's `process.kill()` on Windows sends `CTRL_BREAK_EVENT` to the process group or uses `TerminateProcess`. Register both `signal.SIGTERM` and `signal.SIGBREAK` (Windows-only) handlers. Wrap signal registration in try/except since `SIGBREAK` doesn't exist on macOS.

### 3. package.json + npm install
Run `npm install` to pull down Electron before building further.

### 4. main.js skeleton
- `app.dock?.hide()`
- Create tray, load popup window (`show: false`)
- Startup checks: `python3 --version`, `ffmpeg -version` (log warnings, don't crash)
- Create `AI Medical Notes/Cases/` and `AI Medical Notes/Templates/` via `fs.mkdirSync(..., { recursive: true })`
- Simple `log(msg)` helper → `fs.appendFileSync` to `AI Medical Notes/app.log`

**Tray positioning:**
```javascript
function getPopupPosition(tray, win) {
  const trayBounds = tray.getBounds()
  const winBounds = win.getBounds()
  const { workArea } = require('electron').screen.getPrimaryDisplay()
  
  // Guard against Linux returning {x:0, y:0}
  const validTray = trayBounds.x > 0 || trayBounds.y > 0
  if (!validTray) {
    return {
      x: Math.round(workArea.x + workArea.width / 2 - winBounds.width / 2),
      y: Math.round(workArea.y + workArea.height / 2 - winBounds.height / 2)
    }
  }
  
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
  const y = process.platform === 'darwin'
    ? trayBounds.y + trayBounds.height   // Mac: menubar at top
    : trayBounds.y - winBounds.height    // Windows: taskbar at bottom
  
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - winBounds.width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - winBounds.height))
  }
}
```

**Window config:**
```javascript
{
  width: 280, height: 340,
  show: false, frame: false, resizable: false,
  alwaysOnTop: true, skipTaskbar: true,
  webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
}
```

- Left-click → `togglePopup()` (show/hide + reposition)
- Right-click → context menu: `Quit`
- `win.on('blur', () => win.hide())`
- `app.on('before-quit', () => { if (recordingProcess) recordingProcess.kill() })`

**Platform Python command:**
```javascript
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
```

### 5. preload.js
Expose via `contextBridge.exposeInMainWorld('api', {...})`:
- `getState()` → `invoke('get-state')`
- `startSession()` → `invoke('start-session')`
- `stopSession()` → `invoke('stop-session')`
- `startRecording()` → `invoke('start-recording')`
- `stopRecording()` → `invoke('stop-recording')`
- `submitPatientName(name)` → `invoke('submit-patient-name', name)`
- `onStateChange(cb)` → `on('state-change', (_, s) => cb(s))`
- `onShowPatientForm(cb)` → `on('show-patient-form', () => cb())`
- `onSetupWarning(cb)` → `on('setup-warning', (_, msg) => cb(msg))` ← for BlackHole/ffmpeg warnings

### 6. renderer/index.html + styles.css
Layout (flexbox column, 280px wide):
```
[indicator-dot] [status-label]
[timer]                          ← hidden unless RECORDING
[action-buttons]
[patient-form]                   ← hidden unless shown
[setup-warning]                  ← hidden unless setup issue
```

CSS tokens: `background: #1a1a1a`, `color: #e0e0e0`, accent `#1D9E75`, monospace timer, no gradients.

State → dot color: grey (IDLE, SESSION_ACTIVE), teal #1D9E75 (RECORDING, PROCESSING)

### 7. renderer/renderer.js
State constants: `IDLE`, `SESSION_ACTIVE`, `RECORDING`, `PROCESSING`

On load: `api.getState()` → render matching UI state

State → UI:
| State | Label | Buttons |
|---|---|---|
| IDLE | "No active session" | Start Session |
| SESSION_ACTIVE | "Session active" | Start Recording · Stop Session |
| RECORDING | "Recording... MM:SS" | Save Case |
| PROCESSING | "Processing..." | (disabled, ~2-3s max) |

Note: "Save Case" is the button label (not "Stop") — it matches what the scribe is doing: saving the current patient's audio and triggering transcription. After PROCESSING completes (transcription spawned), state immediately returns to SESSION_ACTIVE so the scribe can start the next recording without waiting.

Timer: `setInterval` 1s, format `MM:SS`, cleared on state exit. Prevent double-clear.

Patient name form (triggered by `api.onShowPatientForm`):
- Text input: "Patient name (optional)"
- Save + Skip buttons
- Countdown: "Auto-saving in Ns..."
- 30s `setInterval`, decrement display
- `submitted` flag guards against race (timeout fires after Save)
- On Save: `.trim().toLowerCase().replace(/\s+/g, '_')` → `api.submitPatientName(name)`
- On Skip/timeout: `api.submitPatientName(null)`

Setup warning: `api.onSetupWarning(msg)` → show `#setup-warning` div with message text

### 8. main.js — IPC handlers + state machine

**Module-level state:**
```javascript
const STATE = { IDLE: 'IDLE', SESSION_ACTIVE: 'SESSION_ACTIVE', RECORDING: 'RECORDING', PROCESSING: 'PROCESSING' }
let currentState = STATE.IDLE
let recordingProcess = null
let tempMp3Path = null
let patientNameResolver = null
```

**`get-state`:** return `currentState`

**`start-session`:** set SESSION_ACTIVE, broadcast

**`stop-session`:** kill any active `recordingProcess` if running, set IDLE, broadcast. (No transcription triggered — if the scribe ends the session mid-recording, the audio is discarded. Phase 2 can add a warning prompt for this.)

**`start-recording`:**
1. `tempMp3Path = path.join(os.tmpdir(), `rec_${Date.now()}.mp3`)`
2. Spawn `record.py --output <tempMp3Path>`
3. Capture stderr and log it
4. Set RECORDING, broadcast

**`stop-recording`** (async):
1. Guard: if no `recordingProcess`, log and return
2. `recordingProcess.kill()` (platform-safe, no signal string)
3. `await new Promise(resolve => recordingProcess.once('exit', resolve))`
4. `recordingProcess = null`
5. `win.webContents.send('show-patient-form')`
6. Set PROCESSING, broadcast
7. `const name = await new Promise(r => { patientNameResolver = r })`
8. Build case folder name: `name ? ${name}_${YYYY-MM-DD} : recording_${YYYY-MM-DD_HH-MM-SS}`
9. Create case folder (`fs.mkdirSync(..., { recursive: true })`)
10. Guard: `if (fs.existsSync(tempMp3Path))` then `fs.renameSync(tempMp3Path, mp3Dest)` else log warning
11. Spawn `transcribe.py --input <mp3Dest> --output <transcriptDest>` (non-blocking, `cwd: __dirname`)
12. `// TODO: Phase 1 — invoke Claude once skill details are confirmed`
13. Log each step with ISO timestamp
14. **Set state back to SESSION_ACTIVE, broadcast** ← scribe can now start the next patient's recording immediately

**`submit-patient-name`** (registered once at startup):
```javascript
ipcMain.handle('submit-patient-name', (_, name) => {
  if (patientNameResolver) {
    patientNameResolver(name || null)
    patientNameResolver = null
  }
  return true
})
```

**Transcribe spawn:**
```javascript
spawn(PYTHON, [
  path.join(__dirname, 'python', 'transcribe.py'),
  '--input', mp3Dest,
  '--output', transcriptDest
], { cwd: __dirname, stdio: 'pipe' })
  .on('exit', code => log(`transcribe.py exited ${code}`))
```

**Setup warning on startup (macOS):**
```javascript
if (process.platform === 'darwin') {
  const { execSync } = require('child_process')
  try {
    execSync('python3 -c "import sounddevice as sd; assert any(\'BlackHole\' in d[\'name\'] for d in sd.query_devices())"')
  } catch {
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('setup-warning', 'BlackHole not found. Install: brew install blackhole-2ch')
    })
  }
}
```

### 9. python/transcribe.py
- `argparse`: `--input`, `--output`
- `load_dotenv()` — cwd set to `__dirname` by Electron spawn
- `logging.FileHandler` → `~/Documents/AI Medical Notes/app.log`
- `ElevenLabs(api_key=os.getenv('ELEVENLABS_API_KEY'))`
- Call speech-to-text with diarization:
  ```python
  with open(input_path, 'rb') as f:
      result = client.speech_to_text.convert(file=f, diarize=True)
  ```
- Group consecutive utterances by speaker, write markdown:
  ```markdown
  ## Transcript

  **Speaker 1:** text

  **Speaker 2:** text
  ```
- try/except around API call — on failure write error note to output file

---

## Critical Gotchas

1. **PyAudioWPatch vs sounddevice platform split:** `pyaudiowpatch` conflicts with `pyaudio`. Use platform-conditional install in requirements.txt. In `record.py`, use `sys.platform` to branch between the two code paths.

2. **WASAPI sample rate:** Windows loopback records at the device's native rate (often 44100 or 48000 Hz). Don't force 16kHz at capture time — capture at native rate, downsample during MP3 export with pydub.

3. **SIGTERM on Windows:** `signal.SIGTERM` handlers are unreliable in Python when killed by Node. Register both `SIGTERM` and `SIGBREAK` (wrap `SIGBREAK` registration in try/except since it's Windows-only). Node should use `recordingProcess.kill()` with no argument.

4. **BlackHole not installed on macOS:** `record.py` should print a clear error to stderr and exit with code 1. Main.js catches this via stderr and surfaces it in the renderer as a setup warning.

5. **dotenv + cwd:** `transcribe.py` must be spawned with `cwd: __dirname` — `load_dotenv()` searches the cwd for `.env`.

6. **patientNameResolver race:** `submit-patient-name` handler is registered once at startup, not inside `stop-recording`. Use the module-scoped resolver pattern. Guard against double-call with null-check.

7. **MP3 might not exist:** After awaiting `recordingProcess` exit, always `fs.existsSync(tempMp3Path)` before trying to move it. If WAV was interrupted mid-conversion, the MP3 won't be there — log and continue.

8. **Tray bounds on Linux:** `tray.getBounds()` may return `{x:0, y:0}`. Fall back to centering on `workArea`.

9. **macOS Multi-Output Device volume:** macOS doesn't allow adjusting system volume on Multi-Output devices via keyboard. Instruct users to set BlackHole as system output in Audio MIDI Setup (not System Settings) to retain individual device volume control.

---

## One-Time Setup Required

### Windows
Nothing extra — WASAPI loopback works natively.

### macOS
```bash
# 1. Install BlackHole
brew install blackhole-2ch

# 2. Open Audio MIDI Setup → + → Create Multi-Output Device
#    Check: Built-in Output (first), BlackHole 2ch
#    Set as system output in System Settings → Sound → Output
```

---

## Verification Steps

1. `npm install` — no errors
2. `pip install -r requirements.txt` — all packages install
3. `npm start` — tray icon appears, no dock icon (Mac), no terminal window visible
4. Click tray → popup 280x340, positioned above tray, closes on blur
5. Right-click → Quit works
6. Start Session → "Session active"
7. **Windows:** Play audio (e.g. YouTube) → Start Recording → check `os.tmpdir()` for growing `.mp3`
8. **macOS (BlackHole installed):** Same test
9. Stop → patient name form appears, countdown runs
10. Save "john_doe" → `AI Medical Notes/Cases/john_doe_YYYY-MM-DD/` created with `john_doe.mp3`
11. `transcript.md` appears in case folder within ~30s
12. `AI Medical Notes/app.log` has timestamps for all steps
13. Start new recording immediately after Stop — non-blocking confirmed
14. **macOS (BlackHole NOT installed):** Setup warning visible in popup
15. `.env` is in `.gitignore`

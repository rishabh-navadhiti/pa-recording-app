# Windows Compatibility & Production Readiness Analysis

**Date:** 2026-04-13
**Last updated:** 2026-04-16
**Scope:** Full codebase review of AI Medical Scribe for Windows deployment
**Method:** Code review + web research against industry best practices + real-world failure analysis from two user deployments

---

## Table of Contents

1. [Windows Compatibility](#1-windows-compatibility)
2. [Best Practices Comparison](#2-best-practices-comparison)
3. [Feature & Robustness Gaps](#3-feature--robustness-gaps)
4. [Installer & Setup Review](#4-installer--setup-review)
5. [Logging & Diagnostics](#5-logging--diagnostics)
6. [Summary by Severity](#6-summary-by-severity)

---

## 1. Windows Compatibility

### 1.1 Dependencies Audit
> **Issue:** No issue flagged — all dependencies verified compatible.

| Dependency | Version | Windows Status | Notes |
|---|---|---|---|
| `pyaudiowpatch` | latest (v0.2.12.8, Jan 2026) | **Actively maintained** | Pre-built wheels for Python 3.7-3.13 on Windows x86/x64. Only Python library that exposes WASAPI loopback. Requires Visual C++ Build Tools to compile from source. |
| `pydub` | latest | Stable | Depends on ffmpeg being on PATH. |
| `ffmpeg` (via winget) | Gyan build | Stable | Standard Windows distribution. |
| `electron` | ^34.0.0 | Stable | Mainstream support. |
| `python-docx` | latest | Stable | Pure Python, no platform issues. |
| `elevenlabs` | latest | Stable | HTTP-based API client. |
| `requests` | latest | Stable | No platform issues. |
| `python-dotenv` | latest | Stable | No platform issues. |
| `sounddevice` | latest | **macOS only** | Correctly excluded on Windows via `requirements.txt` platform markers. |
| `numpy` | latest | Stable | Pre-built wheels available. |

**Verdict:** All dependencies are actively maintained and have proper Windows support. `pyaudiowpatch` is the de facto standard for WASAPI loopback in Python — no better alternative exists.

### 1.2 Windows-Specific Code Paths

#### 1.2.1 Audio Recording (`record.py`)
> **Issue:** No issue flagged — correctly implemented.

- **WASAPI loopback via PyAudioWPatch**: Correct approach for capturing system audio on Windows.
- **stdin stop signal** (`main.js:400`): Correctly chosen — `TerminateProcess()` on Windows gives Python no chance to flush WAV/convert to MP3. Writing `"stop\n"` to stdin allows clean shutdown.
- **`SIGBREAK` handler** (`record.py:229`): Correctly registered as Windows-only fallback.
- **Python executable** (`main.js:13`): Uses `python` on Windows, `python3` on macOS — correct.

#### 1.2.2 Path Handling
> **Issue:** No issue flagged — correctly implemented.

- **`os.tmpdir()`** (`main.js:353`): Returns Windows temp dir correctly.
- **Forward-slash conversion** (`main.js:148`): `path.relative().replace(/\\/g, '/')` for Claude prompts — correct.
- **Backslash in spawn args**: All `path.join()` usages produce Windows backslashes, which Node's `spawn()` handles correctly.

#### 1.2.3 Potential Compatibility Issues
> **Issues:** m1 (patient name sanitization — ✅ FIXED), m6 (shell injection — Open)

| Issue | File:Line | Severity | Description |
|---|---|---|---|
| Long path names | `main.js:38-41` | **Minor** | `~/Documents/AI Medical Notes/Cases/patient_name_YYYY-MM-DD/` can reach 260+ chars on Windows with long usernames (see User 2's `NiyasAsharafArafath` → `NIYASA~1` shortname in logs). Windows 10+ supports long paths if enabled in Group Policy, but Python's `os.path` may still truncate. |
| Special chars in patient names | `main.js:471` | **Minor** | Sanitization only replaces whitespace with `_`. Does not strip commas, periods, or other characters that are legal but can cause issues with some tools. Log evidence: `test,_patient`, `guajardo,_toni`, `berbernian,_rafi`. |
| `shell: true` in spawn | `main.js:164` | **Minor** | Required for PATH resolution but passes command as a string. The `safePrompt` escaping at line 157 only escapes double quotes. If a doctor name or transcript path contains `$`, backticks, or `&`, the shell may misinterpret them. |

---

## 2. Best Practices Comparison

### 2.1 Audio Capture Reliability

#### 2.1.1 Loopback Device Selection — CRITICAL BUG
> **Issue:** C1 — ✅ FIXED

**Current code** (`record.py:116-128`):
```python
# Step 1: Exact name match
for i in range(p.get_device_count()):
    dev = p.get_device_info_by_index(i)
    if dev.get('isLoopbackDevice') and dev['name'] == default_speakers['name']:
        return i, dev

# Step 2: Fallback — first loopback device found
for i in range(p.get_device_count()):
    dev = p.get_device_info_by_index(i)
    if dev.get('isLoopbackDevice') and dev.get('maxInputChannels', 0) > 0:
        return i, dev
```

**Problem:** Step 1 (exact match) **never succeeds** because WASAPI loopback device names always have a `[Loopback]` suffix. Example:
- Default output: `Speakers (High Definition Audio Device)`
- Loopback name: `Speakers (High Definition Audio Device) [Loopback]`

These don't match via `==`, so **every user falls through to the fallback** which blindly picks the first loopback device in PyAudio's enumeration order.

**PyAudioWPatch's own official example** uses substring matching:
```python
if default_speakers["name"] in loopback["name"]:
```
Source: [PyAudioWPatch loopback example](https://github.com/s0d3s/PyAudioWPatch/blob/master/examples/pawp_record_wasapi_loopback.py)

**Real-world impact from logs:**

| User | Default Output Device | Fallback Loopback Selected | Result |
|---|---|---|---|
| User 1 (risha) | `Speakers (High Definition Audio Device)` | `Speakers (High Definition Audio Device) [Loopback]` [idx 16] | Worked — got lucky: correct device was first in enumeration |
| User 2 (NiyasAsharafArafath) | `Speakers (2- High Definition Audio Device)` | `Digital Audio (S/PDIF) (2- High Definition Audio Device) [Loopback]` [idx 19] | **Failed**: S/PDIF has no signal → 0 frames every time |

User 1 succeeded only because their machine happened to enumerate the correct loopback device first. User 2's S/PDIF loopback appeared first and captured nothing.

**How Audacity and OBS handle this:** Both require the user to manually select the loopback device from a dropdown. They do not auto-match. For an unattended app like this, substring matching (per PyAudioWPatch's example) is the correct automated approach.

#### 2.1.2 Zero-Frame Recording — No Guard
> **Issue:** C2 — ✅ FIXED

**Current code** (`record.py:94-96`):
```python
log.info(f'Recorded {frames_written[0]} frames. Converting to MP3...')
wav_to_mp3(wav_path, output_mp3, sample_rate)
```

When 0 frames are captured:
1. `wave.open()` writes a valid WAV header with 0 data bytes
2. `pydub.AudioSegment.from_wav()` loads it as a 0-duration segment
3. `audio.export(mp3_path, format='mp3')` writes a near-empty MP3 (~1 KB)
4. `record.py` exits with code 0 (success)
5. `main.js` treats exit code 0 as successful recording
6. Near-empty MP3 is sent to ElevenLabs → rejected as `invalid_audio / corrupted`

**Best practice:** Audacity and OBS both validate that audio data was actually captured before finalizing the file. The recording should fail explicitly if 0 frames were written.

#### 2.1.3 WASAPI Loopback Silence Behavior
> **Issue:** No issue flagged — documented platform limitation, minor for this use case.

WASAPI loopback produces **no data** when the output device is completely silent (no audio playing). This is a documented Windows Core Audio API limitation.

**Impact:** If the doctor pauses their dictation or no audio is playing through the captured device, the callback simply isn't called. The recording will have time gaps (not silence, actual missing data).

**How Audacity handles it:** Audacity inserts silence to fill gaps, keeping the timeline continuous. The current implementation writes frames only when the callback fires, so the resulting file may have timing jumps.

**Severity:** Minor for this use case — the scribe records during active calls where continuous audio is expected.

### 2.2 Permissions and Device Handling
> **Issue:** No issue flagged — implementation is correct. Device change detection referenced in Section 3.2.

| Practice | Current Implementation | Best Practice | Gap |
|---|---|---|---|
| Admin rights for recording | Not required (WASAPI loopback in shared mode works without elevation) | Correct | None |
| Device enumeration | Once at recording start | Should detect device changes | See Section 3.1 |
| Exclusive vs Shared mode | Shared mode (default) | Shared mode for loopback — correct | None |
| Virtual audio device compatibility | No special handling | Should detect and warn | FxSound caused incorrect device selection for User 2 |

### 2.3 Error Handling and Recovery
> **Issues:** C2 (0 frames — ✅ FIXED), C3 (SOAP file check — ✅ FIXED), M6 (no user feedback — ✅ FIXED), M7 (MP3 size — Open)

| Scenario | Current Behavior | Expected Behavior | Severity |
|---|---|---|---|
| 0 frames recorded | Exits 0, produces empty MP3 | Exit 1 with descriptive error | **Critical** |
| Wrong loopback device | No detection | Validate frames > 0 within first few seconds | **Critical** |
| `record.py` crashes mid-recording | `main.js:374` recovers to SESSION_ACTIVE | Correct | None |
| Transcription API fails | `transcribe.py` writes failure note to transcript file, exits 1 | Reasonable, but no retry | **Major** |
| Claude skill not invoked (SOAP output dumped to terminal, no file saved) | No detection or retry | Detect missing output file, retry once | **Major** |
| ffmpeg missing | Startup warning only, recording still attempted | Should prevent recording | **Minor** |

### 2.4 Performance Optimization
> **Issue:** No issue flagged — all areas meet or exceed best practices.

| Area | Current | Best Practice | Notes |
|---|---|---|---|
| Recording sample rate | Device native (48kHz) → downsampled to 16kHz mono MP3 | Correct for speech transcription | Saves bandwidth on ElevenLabs upload |
| WAV buffer size | 1024 frames per callback | Standard for WASAPI | No issue |
| MP3 encoding | pydub (wraps ffmpeg) | Adequate | LAME via ffmpeg is standard |
| Non-blocking pipeline | Transcription fire-and-forget after recording | Correct design — scribe can start next recording immediately | Good |

---

## 3. Feature & Robustness Gaps

### 3.1 Multiple Audio Output Devices
> **Issues:** C1 (loopback matching — ✅ FIXED), M5 (fallback preference — ✅ FIXED). Manual device selector added to Settings page.

**Current state:** The app captures audio from one loopback device selected at recording start. If the user has multiple output devices (headphones, speakers, USB audio, S/PDIF, virtual devices like FxSound), the wrong one may be selected.

**Observed failure:** User 2 had:
- `FxSound Speakers (FxSound Audio Enhancer)` — virtual audio enhancer
- `Speakers (2- High Definition Audio Device)` — physical speakers
- `Digital Audio (S/PDIF) (2- High Definition Audio Device)` — unused digital output

The app selected the S/PDIF loopback (first enumerated) instead of the Speakers loopback.

**Gaps:**
1. No UI to select the audio device
2. No validation that the selected device is actually producing audio
3. No warning when the default device doesn't match any loopback device by name

**Recommendation:** After fixing the substring matching bug, add an early validation step: start recording, wait 2-3 seconds, check if any frames were captured. If 0 frames, try the next loopback device. If all fail, error with actionable message.

### 3.2 Device Switching During Recording
> **Issue:** No issue flagged — documented limitation, low priority for this use case.

**Current state:** If the user switches their default audio output mid-recording (e.g., plugging in headphones), the recording continues capturing from the original device. The new audio goes to the new device and is not captured.

**How Windows Core Audio handles this:** `IMMNotificationClient::OnDefaultDeviceChanged` callback fires when the default device changes. PyAudioWPatch does not expose this.

**Impact:** Medical scribes typically use a fixed audio setup during a session. This is unlikely to cause issues in practice.

**Recommendation (low priority):** Document this limitation. If needed later, detect the change via `comtypes` or `pywin32` and warn the user.

### 3.3 System Audio from Other Applications
> **Issue:** No issue flagged — inherent WASAPI limitation, no software fix possible.

**Current state:** WASAPI loopback captures ALL system audio from the selected output device, not just the target application (e.g., Microsoft Teams). If other apps play sounds (notifications, music), those are mixed into the recording.

**This is inherent to WASAPI loopback** — it captures at the audio endpoint level, not per-application. Windows does not provide per-application capture without a kernel-mode audio driver.

**Recommendation:** Document this as a known limitation. Advise users to mute notifications during recording.

### 3.4 Recording Interrupted by Other Applications
> **Issue:** m2 (callback status ignored — ✅ FIXED)

**Current state:** WASAPI shared mode allows multiple applications to use the same device simultaneously. Recording should not be interrupted by other apps.

**Exception:** If another application opens the device in **exclusive mode** (rare — some games and DAWs do this), the loopback capture will fail. The PyAudio callback will receive a status error.

**Current handling:** No error checking on callback `status` parameter (`record.py:68`). The `status` parameter is ignored.

**Recommendation:** Log the status parameter in the callback and handle `paInputOverflow` or `paInputUnderflow`.

### 3.5 Patient Name Sanitization
> **Issue:** m1 — ✅ FIXED

**Current code** (`main.js:471`):
```javascript
name.trim().toLowerCase().replace(/\s+/g, '_')
```

**Characters not handled:** commas, periods, slashes, quotes, special Unicode characters. Evidence from logs: `test,_patient`, `guajardo,_toni`, `berbernian,_rafi`.

**Impact:** These become folder/file names. While technically valid on NTFS, commas in filenames cause issues with:
- Some shell commands
- The ElevenLabs API (the file name is sent as part of the multipart upload)
- Some backup and sync tools (OneDrive)

**Recommendation:** Strip or replace all non-alphanumeric characters except underscores and hyphens.

---

## 4. Installer & Setup Review

### 4.1 Current Installer Analysis (`install.ps1`)
> **Issue:** No issue flagged — overview table; specific issues listed in subsections below.

| Step | What It Does | Status | Notes |
|---|---|---|---|
| 1 | Install Git | OK | via winget |
| 2 | Install Python 3.12 | OK | `PrependPath=1` is correct |
| 3 | Install Node.js LTS | OK | via winget |
| 4 | Install ffmpeg | OK | via winget (Gyan build) |
| 5 | Install VS C++ Build Tools | OK | ~4 GB, required for pyaudiowpatch |
| 6 | Install Claude CLI | OK | Fallback with manual instructions |
| 7 | Clone repo | OK | Uses `--ff-only` for updates |
| 8 | Python packages | OK | `pip install -r requirements.txt` |
| 9 | Node packages | OK | `npm install --silent` |
| 10 | Create `.env` | OK | Empty key placeholder |
| 11 | Task Scheduler autostart | **Issues** | See below |

### 4.2 Missing: Start Menu Shortcut — MAJOR
> **Issue:** M1 — ✅ FIXED

The installer registers the app in **Settings > Apps** (via Uninstall registry key) and sets up **Task Scheduler autostart**, but does **NOT create a Start Menu shortcut**.

**Impact:** After the user closes the app (or reboots and the Task Scheduler triggers before they open it), there is no discoverable way to relaunch it. The user must:
1. Navigate to `%LOCALAPPDATA%\Programs\AI Medical Scribe\`
2. Run `npm start` or double-click `launch.vbs`

This is not standard Windows behavior. Users expect to find installed apps in the Start Menu.

**Fix:** Add a Start Menu shortcut creation step:
```powershell
$WshShell = New-Object -ComObject WScript.Shell
$startMenuPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$shortcut = $WshShell.CreateShortcut("$startMenuPath\AI Medical Scribe.lnk")
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$installDir\launch.vbs`""
$shortcut.WorkingDirectory = $installDir
$shortcut.Description = "AI Medical Scribe"
$shortcut.Save()
```

### 4.3 Autostart Mechanism: VBS Wrapper Risks
> **Issue:** M4 — ✅ FIXED (replaced VBS with direct `electron.exe` launch)

**Current approach:** Task Scheduler → `wscript.exe launch.vbs` → `cmd /c npm start`

**Issues:**

1. **Antivirus false positives** — `wscript.exe` running `.vbs` files is a well-known malware vector. Bitdefender, ESET, PC Matic, and others have been documented flagging legitimate `wscript.exe` invocations. A March 2026 malware campaign using VBS files delivered via WhatsApp has increased aggressive AV flagging.

2. **SmartScreen warnings** — Windows may block or warn on first run of an unrecognized VBS script.

3. **PATH dependency** — `cmd /c npm start` requires `npm` to be on PATH in the `wscript.exe` process context. If PATH was updated during the install session, the Task Scheduler-launched process may not have the updated PATH until the next login.

4. **Silent failure** — Window style 0 (hidden) means if `npm start` fails, the user sees nothing. No logs, no error message.

**Better alternative:** Electron's `app.setLoginItemSettings({ openAtLogin: true })` creates a Registry Run key and is the idiomatic approach. If the Task Scheduler's crash-restart feature (`RestartCount: 3`) is needed, point the Task Scheduler action directly at `node.exe %installDir%\node_modules\electron\dist\electron.exe .` instead of going through VBS.

### 4.4 PATH Updates Not Broadcast
> **Issue:** m4 — Open

**Current code** (`install.ps1:21-26`):
```powershell
function Add-ToUserPath($dir) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$current;$dir", "User")
        $env:Path = "$env:Path;$dir"
    }
}
```

This updates the registry and the current process, but does **not broadcast `WM_SETTINGCHANGE`** to notify other running processes (including Explorer). Other apps won't see the PATH change until they restart.

**Impact:** If the user opens a new terminal after installation, the `claude` CLI may not be found until they log out and back in.

### 4.5 Missing Registry Metadata
> **Issue:** m5 — Open

The Uninstall registry key is missing:
- `DisplayIcon` — no app icon shown in Settings > Apps
- `EstimatedSize` — no install size shown

### 4.6 Uninstaller Issues (`uninstall.ps1`)
> **Issue:** M8 — ✅ FIXED (now filters by install path, only kills this app's processes)

1. **Kills all Electron processes** (`uninstall.ps1:20`): `Get-Process -Name "electron"` kills ALL Electron apps, not just this one. If the user runs VS Code (which is Electron-based), it will be killed.

2. **Start Menu shortcut not removed** (because it was never created, but if added, the uninstaller should clean it up).

---

## 5. Logging & Diagnostics

### 5.1 Current Logging Architecture
> **Issue:** m7 (record.py stderr for INFO logs — ✅ FIXED, now routes to stdout)

| Component | Log Target | Format |
|---|---|---|
| `main.js` | `app.log` + stdout | `[ISO timestamp] message` |
| `record.py` | stderr (captured by main.js) | `YYYY-MM-DD HH:MM:SS LEVEL message` |
| `transcribe.py` | `app.log` + stdout (captured by main.js) | `YYYY-MM-DD HH:MM:SS LEVEL message` |
| `md_to_docx.py` | stdout/stderr (captured by main.js) | Plain text |
| Claude SOAP | stdout/stderr (captured by main.js) | `[soap] ...` prefix added by main.js |

### 5.2 Case Folder Name Missing from Logs — MAJOR
> **Issue:** M2 — ✅ FIXED (all pipeline log lines now prefixed with `[folderName]`)

**Problem:** Log entries do not include the case folder name, making it difficult to correlate log entries with specific patient cases when debugging.

**Current log flow for a recording:**
```
[timestamp] stop-recording
[timestamp] State → PROCESSING
[timestamp] Patient name: test
[timestamp] MP3 moved to: C:\...\Cases\test_2026-04-11\test.mp3
[timestamp] Transcription started for: C:\...\Cases\test_2026-04-11\test.mp3
[timestamp] State → SESSION_ACTIVE
[timestamp] [transcribe.py] ... Transcribing: C:\...\test.mp3
[timestamp] [transcribe.py] ... Transcript saved: C:\...\transcript.md
[timestamp] transcribe.py exited 0
[timestamp] [soap] Spawning: claude -p "..."
[timestamp] [soap] **Done.** SOAP note generated...
[timestamp] [soap] claude exited 0
[timestamp] [docx] Converting: C:\...\soap_note.md
[timestamp] [docx] Saved: C:\...\soap_note.docx
[timestamp] [docx] exited 0
```

**Recommendation:** Add a case identifier prefix to all log lines within a case pipeline. Example:
```
[timestamp] [test_2026-04-11] stop-recording
[timestamp] [test_2026-04-11] Patient name: test
[timestamp] [test_2026-04-11] MP3 moved to: ...
[timestamp] [test_2026-04-11] Transcription started
[timestamp] [test_2026-04-11] [transcribe.py] Transcribing: ...
[timestamp] [test_2026-04-11] [transcribe.py] Transcript saved
[timestamp] [test_2026-04-11] [soap] Spawning claude...
[timestamp] [test_2026-04-11] [soap] claude exited 0
[timestamp] [test_2026-04-11] [docx] Saved: ...
```

### 5.3 Claude Skill Invocation Detection — MAJOR
> **Issues:** C3 (SOAP file check + retry — ✅ FIXED), M3 (skill detection — ✅ FIXED)

**Problem:** There is no way to detect from logs whether the Claude skill was properly invoked vs. Claude running without the skill (which produces different output).

**When the skill IS invoked:**
- Claude reads the template, generates a SOAP note, saves it as `{case}_soap_note.md`
- Only a summary is printed to stdout
- The case folder contains **4 files**: audio.mp3, transcript.md, soap_note.md, soap_note.docx

**When the skill is NOT invoked:**
- Claude generates a generic SOAP note and prints the entire content to stdout
- No file is saved by Claude
- The case folder contains only **2 files**: audio.mp3, transcript.md
- The DOCX conversion never runs (because `soapNotePath` doesn't exist, so `spawnDocxConversion` is never called)

**Current detection capability:** The log shows `claude exited 0` in both cases. The only way to distinguish is:
1. Check if `[soap]` output is short (summary) vs. long (full note) — fragile
2. Check if `[docx]` lines follow — but this only appears if the `.md` file was created

**Recommendation:**
1. After Claude exits with code 0, check if the expected SOAP note file exists:
   ```javascript
   claudeProc.on('close', code => {
     log(`[soap] claude exited ${code}`)
     if (code === 0 && soapNoteMdPath) {
       if (fs.existsSync(soapNoteMdPath)) {
         log(`[soap] SOAP note file confirmed: ${soapNoteMdPath}`)
         spawnDocxConversion(soapNoteMdPath)
       } else {
         log(`[soap] WARNING: claude exited 0 but SOAP note file not found — skill may not have been invoked`)
         // RETRY ONCE
         log(`[soap] Retrying SOAP generation...`)
         spawnSoapGeneration(transcriptAbsPath, soapNoteMdPath)  // needs access to transcriptAbsPath
       }
     }
   })
   ```
2. Log the byte count of Claude's stdout output — a summary is typically < 500 chars, a full note dump is > 2000 chars.
3. Log the final file count in the case folder after the pipeline completes.

### 5.4 Missing Diagnostic Information
> **Issues:** m3 (startup diagnostics — ✅ FIXED), m8 (MP3 file size — Open)

| Missing Info | Where | Impact |
|---|---|---|
| Audio device list at startup | `record.py` | Cannot debug device selection without reproducing | 
| Selected device details (index, channels, sample rate) | `record.py` | Logged, but not the full device list |
| MP3 file size after conversion | `record.py` / `main.js` | Cannot detect near-empty files |
| Transcript file size | `main.js` | Cannot detect empty transcripts |
| SOAP note file size | `main.js` | Cannot detect empty/missing notes |
| Case folder final contents | `main.js` | Cannot verify pipeline completion |
| Python package versions | Startup | Cannot debug version-specific issues |
| OS version | Startup | Cannot correlate with OS-specific bugs |

**Recommendation:** Add a startup diagnostics block:
```
[timestamp] === Diagnostics ===
[timestamp] OS: Windows 10 22H2 (build 19045)
[timestamp] Python: 3.12.10
[timestamp] ffmpeg: 6.1.1
[timestamp] pyaudiowpatch: 0.2.12.8
[timestamp] pydub: 0.25.1
[timestamp] Audio devices:
[timestamp]   [0] Speakers (HD Audio) — output
[timestamp]   [1] Speakers (HD Audio) [Loopback] — loopback
[timestamp]   [16] Digital Audio (S/PDIF) [Loopback] — loopback
[timestamp] Default output: [0] Speakers (HD Audio)
[timestamp] Selected loopback: [1] Speakers (HD Audio) [Loopback]
[timestamp] === End Diagnostics ===
```

### 5.5 Recommended Log Format
> **Issue:** M2 (case context in logs — ✅ FIXED). Severity-level prefixes not yet implemented.

**Current format:**
```
[2026-04-11T12:18:35.504Z] record.py exited 0
```

**Recommended format (adds severity and case context):**
```
[2026-04-11T12:18:35.504Z] [INFO] [test_2026-04-11] record.py exited 0
[2026-04-11T12:18:41.484Z] [WARN] [test_2026-04-11] temp MP3 not found — recording may have failed
[2026-04-11T12:28:48.588Z] [ERROR] [guajardo_2026-04-11] Transcription failed: 400 invalid_audio
```

Benefits:
- Severity level enables log filtering (`grep ERROR app.log`)
- Case folder tag enables per-case filtering (`grep guajardo app.log`)
- ISO timestamp already present — no change needed

---

## 6. Summary by Severity

### CRITICAL (Must fix before production use)

| # | Status | Issue | File | Description |
|---|---|---|---|---|
| C1 | ✅ **FIXED** | Loopback device matching uses exact equality instead of substring | `record.py:118` | Replaced single exact-match pass with a 5-pass strategy: startswith → substring → reverse substring → speaker-type preference → first available. All loopback devices are now enumerated and logged upfront to aid debugging. |
| C2 | ✅ **FIXED** | No guard against 0-frame recordings | `record.py:94-96` | Added explicit check: if `frames_written[0] == 0`, removes the empty WAV and exits with code 1. `main.js` already treats non-zero exit as a recording failure. |
| C3 | ✅ **FIXED** | No SOAP note file existence check or retry | `main.js:170-175` | After Claude exits 0, code now checks if the SOAP note file exists. If missing, logs a warning and retries once. If still missing after retry, logs an actionable error. |

### MAJOR (Should fix for reliable operation)

| # | Status | Issue | File | Description |
|---|---|---|---|---|
| M1 | ✅ **FIXED** | No Start Menu shortcut | `install.ps1` | Added Start Menu shortcut creation using `WScript.Shell` COM object. Shortcut also removed by `uninstall.ps1`. |
| M2 | ✅ **FIXED** | Case folder name missing from logs | `main.js` | All pipeline log lines (`[transcribe]`, `[soap]`, `[docx]`) now prefixed with `[folderName]` tag for per-case filtering. |
| M3 | ✅ **FIXED** | No Claude skill invocation detection | `main.js:170-175` | Addressed as part of C3 fix — file existence check + retry covers this entirely. Log messages clearly distinguish "SOAP note confirmed", "skill may not have been invoked — retrying", and "still missing after retry". |
| M4 | ✅ **FIXED** | VBS wrapper antivirus risk | `install.ps1` | Replaced `wscript.exe launch.vbs` with direct `electron.exe .` in Task Scheduler and Start Menu shortcut. Eliminates antivirus false positive risk entirely. |
| M5 | ✅ **FIXED** | Fallback loopback selection picks first device without preference | `record.py:122-126` | Addressed as part of C1 fix — new 5-pass matching algorithm prefers speaker/headphone devices over digital/S/PDIF before falling back to first available. |
| M6 | ✅ **FIXED** | Transcription failure produces no user-visible feedback | `main.js` | OS notifications via Electron `Notification` API: "Transcription failed" on error, "SOAP generation failed" on skill failure, "SOAP note ready" on success. |
| M7 | Open | MP3 file size not validated before transcription | `main.js:436-441` | The code checks if the temp MP3 file exists, but doesn't check its size. A 1 KB empty MP3 passes the existence check. |
| M8 | ✅ **FIXED** | Uninstaller kills all Electron processes | `uninstall.ps1:20` | Now filters by `MainModule.FileName` containing the install directory path. Only kills the AI Medical Scribe electron/node process, not VS Code or other Electron apps. |

### MINOR (Nice to have / hardening)

| # | Status | Issue | File | Description |
|---|---|---|---|---|
| m1 | ✅ **FIXED** | Patient name sanitization incomplete | `main.js:471` | Now strips all characters except `a-z`, `0-9`, `_`, and `-` after lowercasing. Collapses consecutive underscores and trims leading/trailing underscores. Empty result treated as no name. Evidence addressed: `test,_patient` → `test_patient`. |
| m2 | ✅ **FIXED** | Audio callback status parameter ignored | `record.py:68` | Status parameter is now checked and logged as a WARNING on every callback invocation where it is set. |
| m3 | ✅ **FIXED** | No startup diagnostics (OS version, package versions, audio device list) | `main.js` | Startup now logs OS, Electron, Node, Python, ffmpeg versions and full audio device list (Windows). |
| m4 | Open | PATH updates not broadcast via `WM_SETTINGCHANGE` | `install.ps1:22-26` | Other running processes don't see PATH updates until they restart. |
| m5 | Open | Missing `DisplayIcon` and `EstimatedSize` in Uninstall registry | `install.ps1:174-181` | No app icon or size shown in Settings > Apps. |
| m6 | Open | `shell: true` with user-supplied prompt string | `main.js:157-165` | Doctor names or transcript paths with shell metacharacters (`$`, `` ` ``, `&`) could cause command injection. |
| m7 | ✅ **FIXED** | `record.py` stderr used for INFO logs | `record.py` | Logging now routes to stdout via explicit `StreamHandler(sys.stdout)`. stderr reserved for actual errors. `main.js` labels stderr as `[record.py ERR]` which is now accurate. |
| m8 | Open | No MP3 file size logged | `main.js` | After moving the MP3, the file size should be logged to help detect empty recordings from logs alone. |
| m9 | Open | No timeout on Claude SOAP generation | `main.js:158-176` | If Claude hangs, the SOAP generation blocks indefinitely. No timeout or watchdog. |
| m10 | ✅ **FIXED** | `transcribe.py` writes failure note as transcript | `transcribe.py` | On failure, now only logs the error and exits 1 — no longer writes a fake transcript file. File absence is the signal. |

---

## Appendix A: Evidence from User Logs

### User 1 (risha) — Successful path

```
Session 1 (13:19): pyaudiowpatch not installed → ModuleNotFoundError
Session 2 (13:28): Recording worked, but dotenv missing → transcription failed
Session 3 (13:47): Recording worked (721,920 frames), but IBM Watson model_id error
Session 4 (14:04): Full pipeline success — 972,800 frames → transcript → done
April 11: Three full pipeline successes (test, guajardo, deborah) with SOAP + DOCX
```

### User 2 (NiyasAsharafArafath) — Failed path

```
Session 1 (08:21): 0 frames → corrupted MP3 → ElevenLabs 400
Session 2 (12:08): 0 frames → corrupted MP3 → ElevenLabs 400
Session 3 (12:24): 0 frames → corrupted MP3 → ElevenLabs 400
Session 4 (12:25): 0 frames → corrupted MP3 → ElevenLabs 400 (auto-submitted, no name)
Session 5 (12:28): 0 frames → corrupted MP3 → ElevenLabs 400 (1 second recording)
Session 6 (12:28): 0 frames → corrupted MP3 → ElevenLabs 400
Session 7 (12:36): 0 frames → corrupted MP3 → ElevenLabs 400

Every attempt: S/PDIF loopback selected → 0 frames → empty MP3 → API rejection
```

### Appendix B: Device Comparison

| Property | User 1 (risha) | User 2 (NiyasAsharafArafath) |
|---|---|---|
| Default output device | `Speakers (High Definition Audio Device)` | `Speakers (2- High Definition Audio Device)` or `FxSound Speakers (FxSound Audio Enhancer)` |
| Loopback selected | `Speakers (High Definition Audio Device) [Loopback]` [idx 16] | `Digital Audio (S/PDIF) (2- High Definition Audio Device) [Loopback]` [idx 19] |
| Virtual audio software | None | FxSound Audio Enhancer |
| Audio hardware | Single HD Audio device | Dual: HD Audio + S/PDIF digital out |
| Frames per recording | 721K – 23.6M | 0 (every attempt) |
| Exact match succeeded? | No (fell to fallback) | No (fell to fallback) |
| Fallback got correct device? | Yes (by luck) | No (S/PDIF first in enumeration) |

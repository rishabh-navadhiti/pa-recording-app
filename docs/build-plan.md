# Build Plan: Windows Distribution

## Overview

Two options depending on urgency and polish requirements.

| | Option A — PowerShell Installer | Option B — NSIS .exe Installer |
|---|---|---|
| **Effort** | 2–3 days | 5–7 days |
| **User experience** | One PowerShell command | Double-click .exe |
| **Python on user machine** | Yes (installed by script) | No (PyInstaller bundles it) |
| **Uninstall** | `Settings > Apps` → Remove | `Settings > Apps` → Remove |
| **Autostart** | Task Scheduler (no terminal) | Electron `setLoginItemSettings` |
| **Updates** | `git pull` or re-run installer | Re-run .exe installer |
| **Code signing** | Not required | Recommended (avoids SmartScreen) |
| **Target timeline** | Production beta | Public release |

> **Recommendation:** Build Option A now to unblock production beta. Build Option B when ready to ship publicly.

---

## What both options must do

- Install all Python dependencies (`pyaudiowpatch`, `pydub`, `soundfile`, `numpy`, `requests`, `python-dotenv`, `elevenlabs`, `pypandoc-binary`)
- Install Node dependencies (`npm install`)
- Install ffmpeg
- Register autostart — app must launch at Windows login, silently, no terminal window
- Copy `notes-claude/` → `~/Documents/AI Medical Notes/.claude/` (already handled by the app on first run)
- Provide a complete uninstall path (appears in Settings > Apps)
- **ElevenLabs API key** entered in the app UI (not part of install) — a first-run prompt in the popup will be added later

---

## Option A — PowerShell One-Liner Installer

### How it works

User runs one command in an elevated PowerShell terminal:

```powershell
irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/install.ps1 | iex
```

Script does everything. App launches automatically and stays in tray.

### What the script does (step by step)

1. **Install prerequisites via winget** (Git, Python 3.12, Node.js LTS, ffmpeg, Visual C++ Build Tools)
2. **Install Claude CLI**: `irm https://claude.ai/install.ps1 | iex` (user still needs to `claude login` manually — acceptable)
3. **Clone the repo** to `%LOCALAPPDATA%\Programs\AI Medical Scribe\`
4. **Install Python packages**: `python -m pip install -r requirements.txt`
5. **Install Node packages**: `npm install`
6. **Register autostart** via Task Scheduler (no terminal window — see below)
7. **Register uninstall key** in `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\` so it appears in Settings > Apps
8. **Write `uninstall.ps1`** into the install directory
9. **Launch the app** immediately

### Autostart: Task Scheduler (no terminal window)

**Why not `npm start`:** Spawning via Node leaves a console window visible.

**Why not registry Run key directly:** Calling node/electron via Run key flashes a console window.

**Solution: Task Scheduler with a `.vbs` launcher**

The install script creates a tiny VBScript launcher (`launch.vbs`) in the install directory:

```vbscript
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & WshShell.CurrentDirectory & "\launch.vbs" & Chr(34), 0, False
```

Actually — simpler and cleaner: point Task Scheduler directly at `electron.cmd` with `wscript.exe` as the wrapper, OR use Electron's own executable directly. Since we're not doing a packaged `.exe` in Option A, the cleanest approach is:

**Task Scheduler → `wscript.exe` → `launch.vbs` → `electron .`**

```vbscript
' launch.vbs — runs electron app with no console window
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\...\AppData\Local\Programs\AI Medical Scribe"
shell.Run "cmd /c npm start", 0, False
Set shell = Nothing
```

Task Scheduler registration (in install.ps1):
```powershell
$installDir = "$env:LOCALAPPDATA\Programs\AI Medical Scribe"
$vbsPath    = "$installDir\launch.vbs"

$action  = New-ScheduledTaskAction `
    -Execute "wscript.exe" `
    -Argument "`"$vbsPath`"" `
    -WorkingDirectory $installDir

$trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit 0 `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName "AI Medical Scribe" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Force
```

`RunLevel Limited` (not Highest) is mandatory — elevated tasks cannot render GUI windows in the user's desktop session.

### Uninstall

Install script writes `uninstall.ps1` and registers it in `HKCU\...\Uninstall\` so it appears in Settings > Apps > AI Medical Scribe > Uninstall.

`uninstall.ps1` does:
1. Kill running app process
2. Remove Task Scheduler task
3. `Remove-Item -Recurse` the install directory
4. Remove Start Menu shortcut
5. Remove `HKCU\...\Uninstall\AI Medical Scribe` key
6. Optionally prompt: "Remove AI Medical Notes documents? (Y/N)" — default No

### Files to create for Option A

```
install.ps1          ← hosted on GitHub main branch, run via irm | iex
uninstall.ps1        ← shipped in repo, copied to install dir by install.ps1
launch.vbs           ← shipped in repo, copied to install dir by install.ps1
```

### Limitations

- Node.js, Python, Git remain installed on the user's machine (they are system-wide installs via winget — acceptable)
- If winget is not available (very old Windows 10 builds), fallback to direct download URLs
- Claude login must be done manually in a terminal by the user once after install
- ElevenLabs API key entered via app UI (to be built — see "Later" section)

---

## Option B — NSIS `.exe` Installer (Packaged)

### How it works

User downloads `AI-Medical-Scribe-Setup-x.x.x.exe` and double-clicks it. Standard Windows installer wizard. App is fully self-contained — no Python, Node, or Git required on the machine.

### Stack

| Tool | Version | Role |
|---|---|---|
| electron-builder | 26.8.2 | Bundles Electron app + NSIS installer |
| PyInstaller | 6.19.0 | Compiles Python scripts to standalone .exe |
| ffmpeg | latest static build | Bundled inside installer |
| NSIS | via electron-builder | Installer/uninstaller UI |

### Build pipeline (developer runs this to produce the .exe)

```
1. PyInstaller: record.py   → dist/recorder/recorder.exe   (--onedir)
2. PyInstaller: transcribe.py → dist/transcriber/transcriber.exe (--onedir)
3. electron-builder: bundles everything → dist/AI-Medical-Scribe-Setup-x.x.x.exe
```

The two PyInstaller output directories are bundled into the Electron package via `extraResources`:

```json
"extraResources": [
  { "from": "dist/recorder",     "to": "recorder"     },
  { "from": "dist/transcriber",  "to": "transcriber"  },
  { "from": "assets/ffmpeg.exe", "to": "ffmpeg.exe"   }
]
```

In `main.js`, replace Python spawn paths:
```js
const IS_PACKAGED = app.isPackaged
const RECORDER   = IS_PACKAGED
    ? path.join(process.resourcesPath, 'recorder', 'recorder.exe')
    : path.join(__dirname, 'python', 'record.py')
const TRANSCRIBER = IS_PACKAGED
    ? path.join(process.resourcesPath, 'transcriber', 'transcriber.exe')
    : path.join(__dirname, 'python', 'transcribe.py')

// Spawn accordingly
const recArgs = IS_PACKAGED
    ? ['--output', tempMp3Path]
    : [RECORDER, '--output', tempMp3Path]

spawn(IS_PACKAGED ? RECORDER : PYTHON, recArgs, { ... })
```

### PyInstaller spec — key gotchas

**pyaudiowpatch**: `_portaudio.pyd` (C extension DLL) must be collected explicitly:
```python
from PyInstaller.utils.hooks import collect_all
pawp_datas, pawp_binaries, pawp_hiddenimports = collect_all('pyaudiowpatch')
```

**pydub + ffmpeg**: pydub calls ffmpeg as a subprocess. Bundle `ffmpeg.exe` via `extraResources` and set PATH at runtime:
```python
if getattr(sys, 'frozen', False):
    os.environ['PATH'] = sys._MEIPASS + os.pathsep + os.environ.get('PATH', '')
```

**certifi** (for requests TLS): must bundle CA bundle:
```python
import certifi
datas=[(certifi.where(), 'certifi')]
```

**md_to_docx.py** (the script in `notes-claude/scripts/`): uses `pypandoc-binary` which bundles `pandoc.exe` inside the wheel. Must be collected:
```python
import pypandoc
datas=[(pypandoc.get_pandoc_path(), '.')]
```
And at runtime:
```python
if getattr(sys, 'frozen', False):
    os.environ['PYPANDOC_PANDOC'] = os.path.join(sys._MEIPASS, 'pandoc.exe')
```

**Antivirus false positives**: Always use `--onedir` (not `--onefile`), never UPX. For public release, code-sign the compiled `.exe` with an EV certificate.

### Autostart — Electron native

In Option B, the app is a proper `.exe`. Electron handles autostart natively:

```js
// On first launch (or when user enables it)
app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: ['--hidden']
})

// On startup, if --hidden flag present: skip showing window, just show tray
```

NSIS custom script removes the autostart entry on uninstall:
```nsis
; build/uninstaller.nsh
!macro customUnInstall
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Medical Scribe"
    RMDir /r "$APPDATA\AI Medical Scribe"
    nsExec::Exec 'schtasks /Delete /TN "AI Medical Scribe" /F'
!macroend
```

### electron-builder config additions to `package.json`

```json
"build": {
    "appId": "com.aimedicalscribe.app",
    "productName": "AI Medical Scribe",
    "directories": { "output": "dist-installer" },
    "win": {
        "target": "nsis",
        "icon": "assets/icon.ico"
    },
    "nsis": {
        "oneClick": false,
        "perMachine": false,
        "allowElevation": false,
        "allowToChangeInstallationDirectory": false,
        "createDesktopShortcut": false,
        "createStartMenuShortcut": true,
        "shortcutName": "AI Medical Scribe",
        "include": "build/installer.nsh",
        "deleteAppDataOnUninstall": false
    },
    "extraResources": [
        { "from": "dist/recorder",    "to": "recorder"    },
        { "from": "dist/transcriber", "to": "transcriber" },
        { "from": "ffmpeg.exe",       "to": "ffmpeg.exe"  }
    ],
    "files": [
        "main.js", "preload.js", "renderer/**", "assets/**",
        "notes-claude/**", "!python/**", "!*.py"
    ]
}
```

Note: Python source files (`python/`) excluded from packaged build — replaced by PyInstaller-compiled executables in `extraResources`.

### Uninstall

electron-builder's NSIS uninstaller handles everything automatically:
- Removes install directory
- Removes Start Menu shortcut
- App appears in Settings > Apps with a working Remove button
- Custom `uninstaller.nsh` cleans up: autostart registry key, `%APPDATA%\AI Medical Scribe`, scheduled tasks

### Limitations

- Claude CLI still needs to be installed by the user (but installer can prompt and open the install page, or run the PowerShell command silently as a post-install step)
- ElevenLabs API key entered via app UI (to be built — see below)
- Code signing needed to avoid Windows SmartScreen warning on first install ($200–400/year EV certificate)
- Developer build pipeline requires running PyInstaller on Windows (not cross-compilable)

---

## macOS (future)

Leave room for a macOS build later. electron-builder supports `.dmg` target with the same config structure. PyInstaller works on macOS with `sounddevice` and BlackHole. The primary difference is:
- `--target` changes to `dmg` in build config
- PyInstaller produces a `.app` bundle instead of `.exe`
- Autostart uses `app.setLoginItemSettings()` same as Windows (no Task Scheduler)
- Code signing requires Apple Developer account ($99/year) + notarization

When the time comes, the build pipeline changes are minimal — most of the Python and Electron code is identical.

---

## Later: ElevenLabs API key in UI

When building this:
- Add a settings icon or gear button to the popup
- On click: show an input field for the API key
- Save to `.env` in the app directory (or use `electron-store` for encrypted storage)
- On startup: check if `ELEVENLABS_API_KEY` is set — if not, show an amber warning indicator in the status row
- In packaged build (`app.isPackaged`), `.env` lives in `app.getPath('userData')` not `__dirname`

---

## Dependency reference

### Python packages (all platforms)
```
pyaudiowpatch     ; sys_platform == "win32"   # WASAPI loopback
sounddevice       ; sys_platform == "darwin"   # BlackHole capture
soundfile                                       # WAV writing
pydub                                           # WAV→MP3 conversion
numpy                                           # Audio buffer ops
requests                                        # ElevenLabs HTTP
python-dotenv                                   # .env loading
elevenlabs                                      # (SDK, may deprecate in favour of direct requests)
pypandoc-binary                                 # MD→DOCX (bundles pandoc.exe)
python-docx                                     # DOCX manipulation
certifi                                         # TLS CA bundle (needed by PyInstaller builds)
```

### Node packages
```
electron          # app shell
electron-builder  # packaging (devDependency, Option B only)
```

### System tools
```
ffmpeg            # MP3/audio conversion (bundled in Option B, system install in Option A)
claude            # Claude Code CLI (manual install by user — required for SOAP generation)
git               # required by Claude Code CLI (winget install Git.Git)
```

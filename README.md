# AI Medical Scribe

A desktop app for medical scribes that captures system audio from Teams consultations, transcribes it with ElevenLabs, generates per-doctor SOAP notes via the local `claude` CLI, appends ICD-10-CM codes, and exports `.docx` — all running in the background while the scribe moves on to the next case.

Three tabs in the popup: **Record** (the main flow), **Pre-chart** (edit an existing note with new attachments/instructions), **Templates** (manage doctors and per-doctor templates, including AI-built ones).

For a deeper explanation see [docs/OVERVIEW.md](docs/OVERVIEW.md). For architecture see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Windows install (one-liner)

The installer handles everything — Git, Python, Node, ffmpeg, VC++ Build Tools, Claude CLI, the repo itself, autostart, and a Start Menu shortcut. Pick the channel you want:

### Production (what end-users run)

Open **PowerShell as Administrator** and paste:

```powershell
irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/install.ps1 | iex
```

Installs to `%LOCALAPPDATA%\Programs\AI Medical Scribe`, tracking the `main` branch. Auto-updates pull from `main` on every launch.

### Staging (devs only — internal test build)

Use this to dogfood the auto-update pipeline before changes land on `main`. It installs **side-by-side** with the production app — separate folder, separate scheduled task, separate Start Menu entry, plus a yellow `STAGING` badge in the header.

```powershell
irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/install-staging.ps1 | iex
```

Installs to `%LOCALAPPDATA%\Programs\AI Medical Scribe (Staging)`, tracking the `staging` branch. See [CLAUDE.md → Branching + release flow](CLAUDE.md) for the `develop → staging → main` promotion rule.

> **Note:** the production and staging apps share an Electron single-instance lock, so you can't run both at once. Quit one before launching the other.

After install, run `claude login` once in a terminal to authenticate the Claude CLI.

---

## Uninstalling (Windows)

### Option 1 — Settings > Apps (recommended for end users)

1. Open **Settings → Apps → Installed apps**
2. Find **AI Medical Scribe** (or **AI Medical Scribe (Staging)** for the staging install)
3. Click **⋯ → Uninstall**

This runs the bundled `uninstall.ps1` script and removes the app, its scheduled task, Start Menu shortcut, and the registry entry. **It leaves your notes folder (`Documents\AI Medical Notes`) alone** — the script will ask whether to delete notes before removing them.

### Option 2 — Full uninstall (also removes Python, Node, ffmpeg, Build Tools)

Useful when troubleshooting a broken install or wiping a dev box. Open **PowerShell as Administrator** and paste:

```powershell
irm https://raw.githubusercontent.com/rishabh-navadhiti/pa-recording-app/main/uninstall-full.ps1 | iex
```

This removes the app **and** the shared dependencies it installed (Python 3.12, Node.js LTS, ffmpeg, VC++ Build Tools, the Python packages, the Claude CLI). It prompts before deleting your notes folder.

> Both uninstall paths only know about the production install dir by default. To uninstall the staging build, use Settings > Apps and select the "(Staging)" entry — that runs its own bundled `uninstall.ps1` against the staging folder.

---

## Developer setup (running from source)

Use this only if you're contributing to the app. End users should run the installer above.

### Prerequisites

Install these before anything else:

- [Node.js](https://nodejs.org/) (LTS)
- [Python 3](https://www.python.org/downloads/) — check "Add Python to PATH" during install
- [ffmpeg](https://ffmpeg.org/download.html) — must be on PATH
- [Claude CLI](https://claude.ai/code) — required for SOAP note generation and template creation

### 1. Clone the repo

```cmd
git clone <repo-url>
cd recording-app
```

### 2. Install Node dependencies

```cmd
npm install
```

> If the app later crashes on launch with a `better-sqlite3` `NODE_MODULE_VERSION` mismatch, rebuild the native addon for Electron's ABI: `npx electron-rebuild -f -w better-sqlite3`. (The installer scripts do this automatically; a from-source dev clone may need it once.)

### 3. Install Python dependencies

```cmd
pip install -r requirements.txt
```

### 4. Add your ElevenLabs API key

```cmd
copy .env.example .env
```

Open `.env` and fill in your key:

```
ELEVENLABS_API_KEY=your_key_here
```

### 5. Run

```cmd
npm start
```

> **PowerShell users:** If you see a script execution error, either run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` first, or use Command Prompt (cmd) instead — execution policies don't apply there.

On first launch the app asks you to pick a folder for your notes (creates an `AI Medical Notes` subfolder inside). After that the main window opens; closing it minimizes to taskbar. A tray icon also lives in the system tray (bottom-right) — left-click toggles the window, right-click → Quit actually exits the app.

### 6. Run tests

```cmd
npm test            :: Node unit + integration (node:test)
npm run test:unit   :: just the unit suite
npm run test:py     :: Python unittest (tests/python/)
```

Tests live in `tests/unit/`, `tests/integration/`, and `tests/python/`; CI runs them on every push (`.github/workflows/ci.yml`).

---

## macOS

Same steps, but you also need BlackHole for audio capture:

```bash
brew install blackhole-2ch
```

Then open **Audio MIDI Setup**, create a Multi-Output Device with Built-in Output + BlackHole 2ch, and set it as your system output.

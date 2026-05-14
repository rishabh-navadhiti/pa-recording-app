# AI Medical Scribe

A desktop app for medical scribes that captures system audio from Teams consultations, transcribes it with ElevenLabs, generates per-doctor SOAP notes via the local `claude` CLI, appends ICD-10-CM codes, and exports `.docx` — all running in the background while the scribe moves on to the next case.

Three tabs in the popup: **Record** (the main flow), **Pre-chart** (edit an existing note with new attachments/instructions), **Templates** (manage doctors and per-doctor templates, including AI-built ones).

For a deeper explanation see [docs/OVERVIEW.md](docs/OVERVIEW.md). For architecture see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Prerequisites

Install these before anything else:

- [Node.js](https://nodejs.org/) (LTS)
- [Python 3](https://www.python.org/downloads/) — check "Add Python to PATH" during install
- [ffmpeg](https://ffmpeg.org/download.html) — must be on PATH
- [Claude CLI](https://claude.ai/code) — required for SOAP note generation and template creation

---

## Setup

### 1. Clone the repo

```cmd
git clone <repo-url>
cd recording-app
```

### 2. Install Node dependencies

```cmd
npm install
```

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

---

## macOS

Same steps, but you also need BlackHole for audio capture:

```bash
brew install blackhole-2ch
```

Then open **Audio MIDI Setup**, create a Multi-Output Device with Built-in Output + BlackHole 2ch, and set it as your system output.

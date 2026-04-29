# AI Medical Scribe

A system tray app for medical scribes to capture and transcribe Teams call audio, generate SOAP notes, and manage doctor templates.

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
cd pa-recording-app
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

On first launch the app will ask you to pick a folder for your notes. After that a tray icon appears in the system tray (bottom-right). Click it to open the popup.

---

## macOS

Same steps, but you also need BlackHole for audio capture:

```bash
brew install blackhole-2ch
```

Then open **Audio MIDI Setup**, create a Multi-Output Device with Built-in Output + BlackHole 2ch, and set it as your system output.

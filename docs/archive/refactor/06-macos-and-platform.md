# 06 — macOS & the Platform Seam

> macOS was an original requirement, deprioritized for the Windows-first launch. You asked to "keep it in mind for the new design, not focus on it." This doc does exactly that: it defines the **platform seam** so mac is a clean fill-in later rather than a rewrite, and inventories what mac actually needs. Most of the work is making today's Windows-only behavior route through one interface; the analysis found the *logic* is largely platform-neutral already.

---

## Where platform-specific code lives today (the full inventory)

The agents found platform divergence is **concentrated**, not smeared everywhere — which is good news for the seam.

| Concern | Windows today | macOS today | Gap |
|---|---|---|---|
| **Audio capture** (`record.py`) | PyAudioWPatch / WASAPI loopback; 5-pass device heuristic; 0-frames guard; stop-in-callback | sounddevice / BlackHole (needs a manual Multi-Output device); fixed 48 kHz | **mac second-class**: no 0-frames guard (silent empty MP3), no stop-in-callback, no device-name fallback |
| **File hiding** | `attrib +h` on `.md`/internals (`hideFileFromUser`/`hideNotesDirInternals`/`hideExistingCaseMdFiles`) | **no-ops** | mac users see all `.md`/internal files — UX gap, not a crash; needs a mac convention |
| **Python resolution** | `py`→`python`→`python3` | `python3`→`python` | already branched (good); becomes the bundled interpreter in Phase 6 |
| **Secrets** | plaintext `.env` | plaintext `.env` | should be DPAPI (Win) / Keychain (mac) behind a `secretStore` |
| **Notifications** | Electron `Notification` | Electron `Notification` | cross-platform already (good) |
| **Dock / window** | taskbar entry, close-to-minimize | `app.dock?.hide()`, tray-only | **no `app.on('activate')`**; close-to-minimize is a Windows mental model (mac minimizes to a hidden dock) |
| **Install / update** | PowerShell + winget + Task Scheduler + `git pull` | none | **no mac installer, no packaging, no auto-update** |
| **BlackHole probe** | n/a | startup check + setup-warning | correctly mac-branched (good) |
| **`before-quit` kill** | `recordingProcess.kill()` | same | `kill()` semantics differ; bypasses the WAV-flush on both (documented exception) |

Everything else — `db/`, `parseSkillManifest`, the skills (POSIX bash/python), the renderer, the IPC layer, `md_to_docx`/`extract_attachments`/`transcribe` — is **already platform-neutral**. The renderer has no `process.platform` and handles both path separators.

---

## The platform seam (`src/platform/`)

One interface, two implementations. All the Windows-only behavior above routes through it; mac becomes "implement the other side," not "find and fork every site."

```js
// src/platform/index.js — the interface
/**
 * @typedef {Object} Platform
 * @property {() => boolean} isStaging
 * @property {() => string}  resolvePython          // bundled interpreter path (Phase 6) or system fallback
 * @property {(absPath:string) => void} hideInternal // attrib +h (win) / dotfile-or-hidden-subfolder (mac) / no-op
 * @property {(title:string, body:string) => void} notify
 * @property {SecretStore} secretStore               // DPAPI (win) / Keychain (mac) / file (fallback)
 * @property {() => WindowBehavior} windowBehavior   // close-to-minimize vs dock/activate semantics
 */
```

`windows.js` and `macos.js` implement it; `appContext` injects the right one. Today's scattered `if (process.platform === 'win32')` checks and the no-op helpers collapse into `ctx.platform.*`. **Fix the `hideExistingCaseMdFiles` folder-depth bug while extracting it** (it's a Windows-impl detail that belongs here).

This is built in **Phase 1** (it's part of killing the globals) with mac branches initially as honest no-ops/stubs, then filled in during **Phase 7**.

---

## What macOS actually needs (Phase 7 checklist)

Most of it is already cross-platform because the seam + bundling were built with mac in mind. The genuinely mac-specific work:

1. **Packaging:** electron-builder **DMG + ZIP** target. The bundled-Python (python-build-standalone has mac builds) and provider-seam paths are already cross-platform, so a Mac build is mostly CI config. **Code-signing/notarization is deliberately skipped for production (decision A6):** production scribes are Windows; Mac = dev machines (run from source — no signing) + a few internal demo machines (open an unsigned `.app` via right-click → Open, a one-time Gatekeeper bypass, free). The **only** reason to pay Apple's $99/yr Developer Program + `@electron/notarize` is distributing a Mac build to *external non-technical Mac users who can't be told to right-click→Open* — currently nobody, so don't. Revisit only if that user base appears.
2. **`record.py` mac hardening** (mostly done in Phase 5): add the 0-frames guard (today mac silently emits an empty MP3), honor `stop_event` in the callback, a device-name fallback ladder, and revisit the fixed 48 kHz. The BlackHole + Multi-Output-Device setup remains a documented user prerequisite (or a guided first-run helper).
3. **"Hide internals" mac convention:** decide dot-prefix vs a hidden subfolder vs nothing (Finder has no `attrib +h`). This is an open design question — see [07](07-open-questions-and-decisions.md).
4. **Secrets → Keychain** behind the `secretStore` interface (the mac port is the natural moment to also add Windows DPAPI).
5. **Window/dock model:** add `app.on('activate')` if mac gets a dock presence; decide whether close-to-minimize (a Windows idiom) maps to mac's minimize-to-dock or whether mac stays tray-only. Decide before shipping mac.
6. **`before-quit`:** confirm `kill()` semantics on mac (it bypasses the stdin-stop WAV-flush on both platforms — acceptable at quit, but verify no truncated-WAV artifact on mac).

---

## Why the seam now (even though mac is later)

If platform behavior stays as scattered `process.platform` checks and silent no-ops, mac support means hunting every site and risking the Windows path each time. Routing it through one injected interface in Phase 1 means:

- The Windows behavior is **unchanged** (the implementation just moves behind `ctx.platform`).
- mac becomes a **second implementation file**, testable in isolation (e.g. `computeStatusWindowBounds`, `resolvePython` with an injected exec, the hide-convention logic) without a Mac in the loop for the pure parts.
- The "keep mac in mind" instruction is satisfied structurally — the design doesn't *do* mac now, but it can't *block* mac later.

No mac-specific code is written before Phase 7 beyond the interface + honest stubs; the cost now is just "put the Windows code behind an interface instead of inline," which the refactor is doing anyway.

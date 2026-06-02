# 04 — Distribution, Build & Updates

> How the app is installed and updated today, why that can't scale to "a normal app," and the recommended target. Per [decisions](07-open-questions-and-decisions.md): **package + auto-update as a dedicated phase, Windows-first, macOS via the platform seam later; a thin backend is acceptable; the LLM provider is being migrated soon but the vendor is undecided** (so we build a provider seam, not a provider commitment).
>
> Sourced from the distribution analysis + the dependency chain in [00 §2](00-current-state.md). External claims are cited; versions are mid-2026-current. Treat tool/version specifics as "verify at implementation time."

---

## Current model (and why it's the opposite of "a normal app")

There is **no build artifact.** The "app" is a **git working tree** run via the bundled `electron.exe .`. Installation is an elevated PowerShell script (`install.ps1`, `irm <url> | iex`) that bootstraps a full developer toolchain onto the scribe's machine:

**`install.ps1` (11 steps):** winget-install Git → Python 3.12 (+ PATH/WindowsApps-alias workaround) → Node LTS → ffmpeg → **Visual C++ Build Tools (~4 GB)** → Claude CLI (`irm https://claude.ai/install.ps1 | iex`) → `git clone` into `%LOCALAPPDATA%\Programs\AI Medical Scribe` → `pip install -r requirements.txt` → `npm install` + **`npx electron-rebuild -f -w better-sqlite3`** → write empty `.env` → register a Task Scheduler `-AtLogon` task running `electron.exe .` + Start-Menu `.lnk` + uninstall registry key. Then it prints "Run `claude login` once."

**Everything a user machine needs (each a separate moving part):** Git (at install *and every launch* for `git pull`), Python 3.12 on PATH, 9 pip packages (incl. native `pyaudiowpatch`), ffmpeg, the ~4 GB VC++ toolchain, Node+npm (at install *and every update*), Electron, the native `better-sqlite3` (ABI-matched via `electron-rebuild`), the **`claude` CLI installed *and* `claude login`-authenticated**, the claude.ai ICD-10 MCP connector (authed in the user's Claude account), and an ElevenLabs API key.

**Auto-update:** on every launch, `git pull --ff-only` in the install dir; if HEAD moved, re-sync skills + rewrite `.mcp.json` + `npm install` + `electron-rebuild`, then notify "restart to apply." **Version** is whatever git HEAD is (`package.json` is a static `0.1.0`). **Staging** is a gitignored `.staging-marker` file.

### Why it can't scale

- **HIGH — it's a dev environment on every user's machine.** ~4 GB of build tools + a compiler + git + Node + Python + a live git checkout. 10–30 min install, huge break surface. (The VBS launcher was already abandoned because antivirus flagged it.)
- **HIGH — `git pull` auto-update is silently breakable for *all* users at once.** A force-push/rebase on `main` → every install stops updating (non-ff). A user editing a tracked file → merge conflict. A partial `npm install`/`electron-rebuild` → broken `better-sqlite3` ABI, recoverable only via the reinstall dialog. A repo rename → all `irm | iex` + `git pull` break (URL hardcoded in 5 scripts). **No atomicity, no rollback** — an update is "mutate the tree in place and hope."
- **HIGH — `electron-rebuild` needs the VC++ toolchain present *forever*** (every dep change), not just at install.
- **HIGH — `claude login` is invisible and unmanaged.** A one-line console reminder; no in-app check, no re-auth prompt. If the login expires, SOAP generation fails and the only signal is a generic rate-limit regex on stdout — a silent-death failure for non-technical scribes.
- **MED — no code signing** anywhere (unsigned `electron.exe`, unsigned scripts, `irm | iex` of a remote script — all SmartScreen/AV friction).
- **MED — 5 PowerShell scripts duplicate ~150 lines** with hardcoded URL/dir/version/task-name. `launch.vbs` is dead. Two launch paths (`electron.exe .` vs `npm start`).

---

## Recommended target

| Concern | Today | Target | Why |
|---|---|---|---|
| **Packaging** | none (git tree) | **electron-builder** | most mature `electron-updater` integration; `extraResources` for bundled Python; native rebuild on the *build* machine; first-class GitHub Releases publish ([electron.build](https://www.electron.build/docs/features/auto-update/)) |
| **Installer** | elevated PowerShell + winget | **NSIS (Win)**, DMG+ZIP (mac) | electron-updater's simplified auto-update requires NSIS (not Squirrel); per-user NSIS install needs no admin |
| **Updater** | `git pull --ff-only` | **electron-updater** → GitHub Releases (or S3/R2 if private) | atomic, rollback-able, delta downloads; no git, no compiler on the client |
| **Native modules** | user-side `electron-rebuild` + 4 GB VC++ | **compiled once in CI**, shipped in the asar/resources | the entire toolchain step disappears from user machines |
| **Python** | system Python + pip + native compiles | **bundled** (python-build-standalone + pinned wheels) under `resources/` | no system Python, no PATH ambiguity, no compiler |
| **ffmpeg** | winget on PATH | bundled (`ffmpeg-static`) or one documented dep | removes a PATH dependency |
| **Versioning** | git HEAD, static `0.1.0` | real semver + tagged releases; log the git SHA | telemetry, update decisions, "what are they running" |
| **Channels** | `.staging-marker` file | electron-updater `channel` (`latest`/`beta`) + distinct beta `appId` | real beta soak; prod+beta install side-by-side (fixes the shared single-instance lock) |
| **Signing** | none | Azure Trusted Signing (Win ~$10/mo); Apple Developer (mac $99/yr, required) | clean install/update UX; Gatekeeper |

**Net:** install shrinks from a ~4 GB / 30-min toolchain to a signed `Setup.exe` double-click; updates become atomic and need neither git nor a compiler.

---

## The load-bearing decision: the `claude` CLI + Python dependencies

This is the hardest part, and it's a **billing/TOS** decision, not just packaging. Your direction: **migrate soon, but the target (Anthropic org API key vs a different provider) is undecided pending testing + token data** (the DB only reached `main` users yesterday, so there isn't enough usage data yet). The architecture's answer is therefore **the provider seam from [02 §LLM](02-target-architecture.md), not a provider commitment.**

### Python — recommendation: bundle it (low controversy)

Ship a relocatable Python 3.12 + pinned wheels (incl. `pyaudiowpatch`/`numpy`) via electron-builder `extraResources`, using [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (the modern relocatable distro `uv` uses). Repoint `PYTHON` (today's mutable global / `resolvePythonCommand`) to the bundled interpreter. This alone removes the 4 GB VC++ step, the PATH ambiguity, and the runtime `pip install --break-system-packages`. (PyInstaller-per-script is the alternative but clunkier for multiple entry points.) *Optional:* port the 3 non-audio workers (transcribe/extract/docx) to Node, shrinking the bundled Python to just `record.py` — lower long-term maintenance, but gate on golden-file tests because it moves the docx-formatting renderer (regression risk for existing notes). Decide in Phase 5.

### The `claude` CLI — the provider seam absorbs the uncertainty

The app shells `claude -p`, which runs against whatever the local CLI is logged into — today typically a **Claude Pro/Max subscription via OAuth**. The honest landscape (from the agents' research):

- **The Claude Agent SDK still wraps the Claude Code CLI** under the hood and *can* run filesystem skills (`settingSources: ['project']`) — so it doesn't remove the binary, but it replaces the brittle `spawn("claude -p ...")` string + stdout-JSON scraping with a typed `query()` returning structured messages/usage/cost ([platform.claude.com agent-sdk/skills](https://platform.claude.com/docs/en/agent-sdk/skills)).
- **Auth catch:** as of **Feb 19 2026**, Anthropic's compliance docs state the **Agent SDK requires API-key auth**; using Pro/Max OAuth tokens with the Agent SDK is not permitted. And from **June 15 2026**, subscription `claude -p`/SDK usage draws from a **separate Agent-SDK credit pool**. So moving to the SDK effectively means moving to a pay-per-token `ANTHROPIC_API_KEY` model. *(Verify these dates/policies at implementation time — they're the kind of thing that shifts.)*
- This is *why* the vendor decision has real consequences and is worth deferring until you have token data.

**Therefore:**

1. **Now (keep production alive):** bundle the `claude` CLI binary inside the app, keep subscription auth, and add a first-class **in-app auth health-check + guided login** (detect "not logged in," surface it, health-check on startup). This is the smallest change that makes packaging viable and kills the silent-death failure mode — independent of the eventual provider.
2. **Build the provider seam** (`llm/provider.js`, Phase 2) so note-gen/ICD/CDI/future engines call `ctx.llm.runSkill(...)`, never the CLI directly.
3. **Later (when you've decided, with data):** implement the chosen provider as one new file behind the seam:
   - **Anthropic org API key** → `agentSdkProvider.js` (or raw Messages API), key held by a **thin backend broker** so it's never on the client. Billing moves from "each scribe's subscription" to "org pays per token" — centralized and predictable, and the only TOS-clean way to run note-gen as embedded product code. *(A thin backend is acceptable per your answer — it also becomes the home for telemetry and the future feedback-loop.)*
   - **A different vendor** → `<vendor>Provider.js` implementing the same interface.

   Either way, **engines, pipeline, status, and DB are untouched** — flip one line in `appContext.js`. That decoupling is the entire point of building the seam before deciding.

**Be explicit with stakeholders:** moving off the subscription CLI changes billing to per-token (org card), likely via a small key-broker server. The seam lets you make that decision on your timeline; it doesn't make it for you.

---

## Code signing / notarization (for our scale)

Scale = a handful of internal scribes, growing. Pragmatic stance:

- **Windows — recommended: Azure Trusted Signing (~$9.99/mo, Basic).** GA since ~April 2026, no hardware token, CI-friendly; restricted to established US/Canada/EU/UK businesses, not EV ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)). EV no longer skips SmartScreen reputation-building, so the ~$400/yr EV premium isn't justified. Signing is **strongly recommended, not strictly required** — unsigned runs but throws SmartScreen warnings (bad for non-technical medical users and for an `irm | iex` install). Do it when cutting the first real installer.
- **macOS — required.** Apple Developer Program **$99/yr**; you must **code-sign + notarize + staple** or Gatekeeper blocks the app on every Mac since Catalina. electron-builder + `@electron/notarize` automate it in CI. Non-negotiable the moment mac ships.

**Verdict:** ~$10/mo (Azure) + $99/yr (Apple) covers both. Windows signing at first installer; mac signing when mac ships.

---

## Migrating existing production users (no data loss; ≤5-min ceiling)

**The crucial invariant:** `NOTES_DIR` (`~/Documents/AI Medical Notes`) is **fully external to the install dir** — it holds `settings.json`, `app.db`, `Cases/`, `templates/`. The git working tree at `%LOCALAPPDATA%\...` holds **no user data** except the repo `.env` (ElevenLabs key + `NOTES_DIR_PATH`). So migration is genuinely low-risk for data, and even a full reinstall loses zero clinical notes as long as the Documents folder is preserved.

**One-time scripted migration (on a call), `migrate-to-packaged.ps1`:**
1. **Capture two bits** from the old `.env`: `NOTES_DIR_PATH` + `ELEVENLABS_API_KEY`. (Notes data never moves.)
2. **Quit the app**; disable/unregister the old `AI Medical Scribe` scheduled task so it can't relaunch.
3. **Remove only the launch surface** — Task Scheduler task, Start-Menu `.lnk`, uninstall registry key, the git working tree. **Do not touch Documents.**
4. **Run the signed `Setup.exe`** (per-user NSIS, no admin). On first launch the packaged app: writes config to `app.getPath('userData')` going forward; **detects the legacy `NOTES_DIR_PATH`** (or defaults to `~/Documents/AI Medical Notes` if present) and reuses it — `app.db`, `Cases/`, `templates/` picked up unchanged (and the DB is rebuildable + doctors restore from `settings.doctors.backup.json`, so even a DB hiccup is non-fatal); re-prompts the ElevenLabs key only if not carried over.
5. **Re-auth Claude** via the new in-app health-check/guided login.

**Worst case (full reinstall):** uninstall everything except Documents, run `Setup.exe`, point it at the existing notes folder. Under 5 minutes, zero note loss. Keep `reinstall.ps1` alive only until everyone's migrated.

---

## Release channels mapped to the branch model

Current: `feature/* → develop → staging → main`; staging via `.staging-marker`.

| Branch | Today | Under electron-updater |
|---|---|---|
| `develop` | `npm start` from source | unchanged — devs run unpackaged; no published artifact |
| `staging` | `install-staging.ps1`, pulls `staging` | **`beta` channel** — CI builds a signed `Setup.exe` tagged `x.y.z-beta.N`, publishes to the `beta` feed; staging installs subscribe via a `channel` setting (not a branch). Exercises the *real* updater before users. |
| `main` | user installs, pull `main` | **`latest`/stable** — promotion = tag `vX.Y.Z` → CI publishes to `latest`. `staging → main` becomes "promote the beta build to stable." |

- **`.staging-marker` → a `channel` setting** (still local-only, still not a branch property — preserves the CLAUDE.md invariant; the STAGING badge keys off `channel === 'beta'`).
- **Distinct beta `appId`/`productName`** ("AI Medical Scribe (Beta)") → prod + beta install side-by-side with separate userData, fixing the shared single-instance-lock collision the current design has.
- **Hotfix rule survives:** `hotfix/*` → patch release published to both `latest` and `beta`; back-merge to keep them aligned.

---

## Phasing (maps to [03](03-migration-plan.md) Phase 6)

**Phase 0 of distribution (do early, low risk, independent of code structure):**
- Pin a real semver; tag releases; log the git SHA at startup.
- Add the in-app **dependency + Claude-auth health check** (Python? ffmpeg? `claude` logged in?) surfaced to the renderer — closes silent-death failure modes regardless of packaging path.
- Resolve the billing/TOS direction with stakeholders (subscription vs org key vs other vendor) — informs *when* C2 happens, not *whether* the seam is built.

**Phase 6 proper (after refactor Phases 1 + 5):**
- electron-builder → signed NSIS `Setup.exe`; `better-sqlite3` built in CI.
- Bundle Python (python-build-standalone + wheels) + ffmpeg; repoint `PYTHON`.
- Bundle the `claude` CLI (C1); subscription auth + guided login.
- Move config to `userData`; first-run migration reusing the existing NOTES_DIR.
- Windows code signing.
- electron-updater → GitHub Releases (or S3/R2); retire `checkForUpdates`/`git pull`/`runPostUpdateSetup`; map staging→beta, main→latest; ship `migrate-to-packaged.ps1`.
- **Then** convert JS+JSDoc → TypeScript (build now lives in CI).

**Phase 7:** macOS DMG + notarization (see [06](06-macos-and-platform.md)).

---

## Open items for stakeholders (also in [07](07-open-questions-and-decisions.md))

1. **Billing/TOS:** org-pays-per-token vs each-scribe-subscription vs a different vendor — gates *which* provider lands behind the seam, and when. (Deferred by design; you're gathering token data.)
2. **Repo visibility:** public (free GitHub Releases hosting) or private (needs S3/R2 + a release token/proxy)?
3. **CI + signing identity:** is there CI today, or does Phase 6 stand up GitHub Actions + the Azure Trusted Signing identity + Apple cert?
4. **Thin backend:** confirmed acceptable (your answer) — it will hold the future API key, broker engines, and centralize telemetry/feedback. Scope it when the provider decision is made.
5. **Confirm the GitHub URL/visibility** — every script hardcodes `rishabh-navadhiti/pa-recording-app`; a rename silently breaks all current installs.

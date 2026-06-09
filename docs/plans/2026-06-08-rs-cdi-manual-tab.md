# Manual CDI tab — run cdi-review on a standalone SOAP note

**Status:** Planned. Single PR — new renderer tab + new IPC domain + new manual-CDI job module land together.

**Branch:** `feature/cdi-manual-tab` (off `refactor/phase-5`).

---

## One-sentence summary

Add a fourth tab to the main popup — **CDI** — that lets a scribe run the existing `cdi-review` skill on a SOAP note **they supply directly** (pasted text, or an uploaded `.md`/`.docx`), independent of the recording pipeline, store **nothing**, and hand the user back a single `.docx` CDI report to save wherever they want.

This reuses the *same* `cdi-review` skill, standards packs, and per-doctor specialty that the audio pipeline's CDI step uses (see `docs/ARCHITECTURE.md` → *Per-case post-processing chain*). The only difference: the SOAP note already exists (with ICD codes baked in) instead of being produced by `generate-note`, and the run is fully ephemeral.

---

## Scope

1. **New `CDI` tab** in the main popup (4th tab: Record · Pre-chart · Templates · **CDI**).
2. Tab fields: **doctor** picker (filtered to supported specialties), **skill** picker (`CDI Review`, single option, future-proofed), **CDI mode** picker (`Balanced`/`Compliance`/`Aggressive`), a **SOAP-note input** that is *either* a paste textarea *or* a single uploaded file (`.md`/`.docx`), and a **Run** button.
3. A new **manual-CDI job** in main that: builds an ephemeral temp case folder → normalizes the note to `<stem>_soap_note.md` → ICD pre-flight check → invokes `cdi-review` → converts the resulting `_cdi.md` to `.docx` → offers the `.docx` via an OS save dialog → deletes the temp folder.
4. New IPC domain (`src/ipc/cdi.js`) + channels + `preload.js` methods.
5. Reuse of the shared single-flight job lock + job-status banner (new `type: 'cdi'`).

## Out of scope

- **No persistence of anything.** No `cases` row, no `cdi_flags` rows, no `processing_events` event, no file left under `<NOTES_DIR>/Cases/`. The only durable artifact is the `.docx` the *user* chooses to save, wherever they save it.
- **The audio-pipeline CDI step is untouched** (`src/engines/cdi.js`, `src/pipeline/chain.js`). The global `enableCdi`/`cdiMode` settings continue to gate *only* the Record-tab flow. This tab ignores them.
- **No ICD coding in this tab.** If the supplied note lacks ICD codes we stop with a message (see *ICD pre-flight*). We never run the `icd` engine here.
- **No new specialties / standards packs.** Orthopedics is still the only supported specialty in v1; the doctor dropdown is filtered to whatever has a standards pack.
- **The `docx → md` conversion script is user-supplied** (Python, to be added — see *Open items*). This plan wires the integration point; the script itself is not authored here.

---

## Decisions locked (from clarification round)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Skill picker is a list with one entry** (`CDI Review`), not a mode picker. | Future-proofs for more CDI skills; today it's a single, effectively-fixed option. |
| D2 | **CDI mode comes from a dropdown in the tab** (`Balanced` default), *not* from global `cdiMode`. | Global CDI settings apply to the Record tab only (D5); the tab owns its own mode. |
| D3 | **Per-run ephemeral temp case folder** in `os.tmpdir()` (outside `<NOTES_DIR>`). Deleted on failure, on save, on Close/Discard, **or when the next CDI run starts** (see D11). Nothing is persisted to `<NOTES_DIR>` or `app.db`. | User: "no need to store anything … temporary case folder for every case." (Lifecycle refined by D11.) |
| D4 | **Input normalization:** paste → write to `.md`; `.md` upload → use as-is; `.docx` upload → convert to `.md` via user's Python script. | User spec. |
| D5 | **Global `enableCdi`/`cdiMode` are irrelevant to this tab.** The tab always works regardless of the global toggle. | User: "global cdi … either enable or disable doesn't matter; that matters only for record tab." |
| D6 | **ICD pre-flight:** if the note has no `## ICD-10-CM Codes` section, show "ICD codes not available" and **stop** — no Claude call. | User: "mention ICD code is not available and stop." |
| D7 | **Doctor dropdown filtered to supported specialties only** (specialty set *and* a standards pack exists). | User: "filter to supported only." Avoids dead-end runs. |
| D8 | **Single deliverable:** the `cdi-review` `.md` → `.docx`, offered via OS save dialog. The `_cdi.json`, the prepared soap `.md`, and the temp folder are discarded once the held report's lifecycle ends (D11). | User: convert `.md` to docx, show save option, open file system. |
| D9 | **Inputs are mutually exclusive** — choosing a file disables the paste textarea and vice-versa. | One SOAP note per run; avoids ambiguity. |
| D10 | **Save UX:** on success the tab shows a **Save CDI report** button → OS save dialog (default name `CDI_Review_<doctorLast>_<YYYY-MM-DD>.docx`) + a **Close** (discard) button; the temp `.docx` is held until the user saves or closes — or the next run starts (D11). | User: "show option to save and file system should open … save anywhere." |
| D11 | **Held report persists until the NEXT run (revised lifecycle).** A completed report is NOT auto-deleted and is NOT discarded when the user navigates away from the tab. It stays held (Save/Close visible on the tab) until: (a) the user Saves it, (b) the user Closes/Discards it, or (c) the user starts another CDI run — at which point main.js discards the prior temp folder before creating the new one. | User: "once we process a cdi job … it just stays as it is, till we want to process another file for cdi — that time this old one will be discarded." Supersedes the earlier "discard on tab-leave" idea. |
| D12 | **Live progress via the shared job banner.** The manual CDI job persists its `{type:'cdi', status, startedAt}` to `.template_job.json` (same store as template/prechart jobs) AND pushes `template-job-status` events. Persisting is load-bearing: the renderer's 3s status poller and tab-re-entry both read `getTemplateJobStatus()` (which reads the store), so without persistence the live banner would be overwritten by a stale read within 3s. The banner shows "Running CDI review for `<doctor>` — `<elapsed>`" with a live timer, then a transient "CDI report ready" that auto-dismisses (the real completion UX is the tab's Save/Close row). | User: "a timer or any status would help which keeps running while cdi is happening, similar to template." |

---

## Target UX

```
┌─ CDI ───────────────────────────────┐
│ Doctor    [ Dr. Smith (Orthopedics) ▾]   ← filtered: specialty + standards pack
│ Skill     [ CDI Review              ▾]   ← single option (D1)
│ Mode      [ Balanced                ▾]   ← Balanced | Compliance | Aggressive (D2)
│                                          │
│ SOAP note (paste OR upload one file):    │
│ ┌──────────────────────────────────┐    │
│ │ (paste the ICD-coded SOAP note…)  │    │  ← textarea; disabled if a file is added (D9)
│ └──────────────────────────────────┘    │
│ [ Add .md / .docx file ]  filename.md ✕  │  ← single file; clears textarea when added (D9)
│                                          │
│ [ Run CDI review ]                       │  ← enabled when doctor set AND (text OR file)
│ <inline error / status line>             │
└──────────────────────────────────────────┘
```

States:
- **Running** → shared job banner: *"Running CDI review for `<doctor>` — `<elapsed>`"* (live timer, updates every 3s; D12). Run button hidden/disabled. State persists across tab navigation.
- **ICD missing** → inline error *"ICD codes not available in this note."* No run.
- **Failure** → inline error on the tab + transient red banner (auto-dismisses).
- **Success** → transient *"CDI report ready"* banner (auto-dismisses); tab shows **[ Save CDI report ]** + **[ Close ]**. The held report STAYS (survives tab navigation) until Save, Close, or the next run (D11). Save → OS dialog → copies the `.docx` out → temp deleted. Close → temp deleted. Next run → prior temp deleted, then new run starts.

---

## Architecture — the manual-CDI flow

New module: **`src/jobs/cdiManual.js`** exporting `runManualCdiJob(input, ctx)`. It deliberately does **not** go through `jobDispatcher.runJob` (which writes `processing_events`) nor `engineRunner.runEngine` (which writes DB rows *and* enforces the `enableCdi` gate). It uses the lower-level seams directly so the run stays DB-free (D3).

Sequence (all paths clean up the temp folder in a `finally`):

1. **Acquire the single-flight lock** via `ctx.stores.jobs.start('cdi', { kill }, null)` — refuse if `ctx.stores.jobs.isRunning()`. Broadcast `{ type: 'cdi', status: 'running' }` on `TEMPLATE_JOB_STATUS` (banner reuse).
2. **Create temp folder** `os.tmpdir()/cdi_manual_<pid>_<ts>/`. (Outside `<NOTES_DIR>` entirely — nothing lands in the notes area.) `<ts>` passed in from the caller (scripts can't call `Date.now()`; main can).
3. **Normalize the note → `<stem>_soap_note.md`** inside the temp folder (`<stem>` = a slug from the doctor + date, e.g. `cdi`):
   - **paste** → write the textarea contents verbatim to `<stem>_soap_note.md` (D4).
   - **`.md` upload** → copy as-is to `<stem>_soap_note.md` (D4).
   - **`.docx` upload** → spawn the user's Python `docx → md` script (see *Open items*) → write its stdout/output to `<stem>_soap_note.md` (D4).
4. **ICD pre-flight** (D6): read the prepared `.md`; if it has no `## ICD-10-CM Codes` heading (primary check) *and* no ICD-10 code pattern (`/\b[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/`, fallback), abort with `{ ok: false, error: 'ICD codes not available in this note.' }`. No Claude call.
5. **Resolve CDI inputs** (mirrors `src/engines/cdi.js` `buildInput`, but mode from the tab):
   - `caseDir` = temp folder (absolute)
   - `specialty` = doctor's specialty (lowercased)
   - `mode` = the tab's selection (D2)
   - `doctor` = doctor full name
   - `standardsDir` = `<NOTES_DIR>/.claude/standards`
   - Re-validate the specialty standards file exists (`standards/specialties/<specialty>.md`) — belt-and-suspenders vs the dropdown filter (D7).
6. **Run the skill:** `prompt = buildPrompt('cdi-review', input)`; `runResult = await ctx.llm.runSkill({ prompt, model: cfg.soapModel || 'claude-sonnet-4-6', effort: 'high', label: 'cdi-manual', signal })`. The skill writes `<stem>_cdi.json` + `<stem>_cdi.md` into the temp folder.
7. **Parse manifest** with `parseSkillManifest(runResult.text)`; on null/malformed, fall back to reading the on-disk `<stem>_cdi.json` (reuse the `synthesizeManifestFromDisk` approach from `src/engines/cdi.js:122`). If `status !== 'ok'` or no `md_path`, fail with the skill's reason.
8. **Convert `_cdi.md` → `.docx`** via a new **DB-free** helper `convertMdToDocx(mdPath, { python, log }) → Promise<docxPath>` — just the bare `spawn(python, [.../md_to_docx.py, mdPath])` from `docx.js:55`, resolving `<stem>_cdi.docx` on exit 0. (Does **not** call `spawnDocxConversion`, which is DB-coupled.)
9. **Hold the result** in a main-side slot (owned by `src/ipc/cdi.js`, written via an injected `setCdiResult` callback): `{ tempDir, docxPath, suggestedName: 'CDI_Review_<doctorLast>_<date>.docx' }`. Broadcast (and persist to jobState, D12) `{ type: 'cdi', status: 'success' }`. Release the job lock. The held report persists until Save/Close/next-run (D11) — it is NOT auto-deleted.
10. **Save / Close** (separate IPC, D10): `saveCdiReport()` → `dialog.showSaveDialog(win, { defaultPath: suggestedName, filters: [{name:'Word', extensions:['docx']}] })` → copy `docxPath` to the chosen path → delete `tempDir` + clear slot. `discardCdiReport()` (the Close button) → delete `tempDir` + clear slot. Save-dialog *cancel* keeps the slot so the user can retry.
11. **Next-run discard (D11):** `START_CDI_REVIEW` discards any pre-existing held slot (`_cleanup(tempDir)`) before starting the new run, so a back-to-back run never orphans the previous temp folder.
12. **Cleanup invariant:** on any failure in steps 2–8, delete `tempDir` immediately and broadcast `failed`. On success, `tempDir` lives until Save / Close / next-run (D11). Navigating away from the tab does NOT delete it.

Service-warning scanning (ElevenLabs/Claude limits, MCP auth) is inherited from `ctx.llm.runSkill`'s existing stderr/stdout regex surface — reuse as-is.

---

## File-by-file implementation

### Renderer

- **`renderer/index.html`** — add a `<div id="tab-cdi" class="hidden">` container (next to `#tab-prechart`, ~line 310) with the doctor/skill/mode selects, paste textarea, file-add row, Run button, error line, and the post-success Save/Discard row. Add `<button id="btn-tab-cdi" class="tab-btn" data-tab="cdi">CDI</button>` to `#tab-bar` (~line 360). *Note: popup is 280×420 — verify the 4-tab bar still fits; shorten labels if needed.*
- **`renderer/views/cdiView.js`** *(new)* — `createCdiView()` returning `{ mount, update, unmount, refreshCdiTab }`, following the `prechartView.js` pattern exactly (listener tracking via `on()`, cleanup in `unmount`). Responsibilities:
  - `refreshCdiTab()` — populate doctor `<select>` from `ipc.getCdiDoctors()`; populate mode `<select>` from `CDI_MODES`; reset paste/file/inputs.
  - File add via `ipc.browseCdiSoapFile()` (single file); selecting one disables the textarea, and clearing it re-enables (D9).
  - Run → `ipc.startCdiReview(doctorId, mode, pastedText, filePath)`; show inline error on `{ ok:false }`.
  - Render Save/Discard when a success banner for `type:'cdi'` arrives → `ipc.saveCdiReport()` / `ipc.discardCdiReport()`.
- **`renderer/app.js`** — import + instantiate `createCdiView()`; query `tabCdi` + `btnTabCdi`; add the `'cdi'` branch to `showTab()` (toggle visibility + `.tab-active`, call `cdiView.refreshCdiTab()` on enter); mount it in `init()`; wire `btnTabCdi` click.
- **`renderer/views/jobBanner.js`** — add a `'cdi'` case to the `type` switch (running/success/failed labels: *"Running CDI review"*, *"CDI report ready"*, etc.).
- **`renderer/constants.js`** — add `CDI_MODES` (`[{value:'balanced',label:'Balanced'}, {value:'compliance',label:'Compliance'}, {value:'aggressive',label:'Aggressive'}]`), drift-mirrored from a new shared source (below).
- **`renderer/styles.css`** — reuse existing form styles; add only what's missing (the file-add row mirrors prechart).

### Shared / preload

- **`src/shared/cdi-modes.js`** *(new)* — single-source `CDI_MODES` (value/label pairs). Mirrored in `renderer/constants.js`; covered by the drift test (below).
- **`src/shared/ipc-channels.js`** — add `GET_CDI_DOCTORS`, `BROWSE_CDI_SOAP_FILE`, `START_CDI_REVIEW`, `SAVE_CDI_REPORT`, `DISCARD_CDI_REPORT`. (Reuse existing `TEMPLATE_JOB_STATUS` for the banner.)
- **`preload.js`** — expose `getCdiDoctors()`, `browseCdiSoapFile()`, `startCdiReview(doctorId, mode, pastedText, filePath)`, `saveCdiReport()`, `discardCdiReport()`. Document each in the IPC table in `CLAUDE.md`.

### Main / IPC / job

- **`src/ipc/cdi.js`** *(new)* — `registerCdiIpc(ipcMain, appCtx, deps)`, mirroring `src/ipc/prechart.js`:
  - `GET_CDI_DOCTORS` → `getAllDoctors()` filtered to `specialty` set **and** `standards/specialties/<specialty>.md` exists (D7).
  - `BROWSE_CDI_SOAP_FILE` → single-select `dialog.showOpenDialog` with `extensions:['md','docx']`.
  - `START_CDI_REVIEW` → validate doctor/specialty/standards + (paste XOR file); kick off `runManualCdiJob`; return `{ ok }` (the run is async, status via banner).
  - `SAVE_CDI_REPORT` / `DISCARD_CDI_REPORT` → operate on the main-side held result; confine any path to the temp dir.
- **`main.js`** — register `registerCdiIpc(...)` in `registerIpcHandlers()` (next to the prechart registrar, ~line 671); pass deps (`getAllDoctors`, the new `runManualCdiJob`, `convertMdToDocx`, `python`, `log`, the held-result slot, save/discard helpers). Add the held-result module-level slot.
- **`src/jobs/cdiManual.js`** *(new)* — `runManualCdiJob(input, ctx)` implementing the sequence above. Pure-ish: takes the temp `ts`/paths from caller; uses `ctx.llm.runSkill`, `buildPrompt`, `parseSkillManifest`, `convertMdToDocx`, `ctx.stores.jobs`, and the banner broadcast helpers.
- **`src/pipeline/docx.js`** — extract/add `convertMdToDocx(mdPath, { python, log }) → Promise<string>` (DB-free; just spawns `md_to_docx.py` and resolves the `.docx` path). Have `spawnDocxConversion` optionally reuse it internally, or leave `spawnDocxConversion` as-is and add the small sibling — whichever keeps the diff smallest.

### Python

- **`python/docx_to_md.py`** *(new — user-supplied, see Open items)* — reads a `.docx` path arg, emits Markdown (stdout or a sibling `.md`). Invoked via the `PYTHON` resolver like `md_to_docx.py`. Add a `tests/python/test_docx_to_md.py` golden once the script lands.

---

## IPC contract additions (for the `CLAUDE.md` table)

| Method | Purpose |
|---|---|
| `getCdiDoctors()` | Doctors eligible for manual CDI — specialty set **and** a standards pack exists. |
| `browseCdiSoapFile()` | Single-file picker (`.md`/`.docx`) for the SOAP note. |
| `startCdiReview(doctorId, mode, pastedText, filePath)` | Kick off the ephemeral manual CDI run. Returns `{ok, error?}`. Progress via `onTemplateJobStatus` (`type:'cdi'`). |
| `saveCdiReport()` | Opens the OS save dialog for the held CDI `.docx`, copies it out, deletes the temp folder. |
| `discardCdiReport()` | Deletes the held temp folder without saving. |

Event reuse: `onTemplateJobStatus` now also emits `{ type: 'cdi', status, … }`.

---

## Testing

- **`npm test`** (Node):
  - `tests/unit/shared-drift.test.js` — extend to assert `CDI_MODES` matches between `src/shared/cdi-modes.js` and `renderer/constants.js`, and the new `CHANNELS` keys match `preload.js`.
  - New unit test for the ICD pre-flight detector (has-`## ICD-10-CM Codes` → ok; bare code regex → ok; neither → blocked).
  - New unit test for the manual-CDI input normalizer (paste/`.md`/`.docx` branch selection; mutual-exclusion validation; temp-folder cleanup-on-failure).
- **`npm run test:py`** — add `test_docx_to_md.py` once the script lands.
- **Manual (`npm start`)** — exercise all three input modes (paste, `.md`, `.docx`), the ICD-missing stop path, the supported-specialty filter, the success → Save dialog → file-saved path, Discard, and confirm the temp folder is gone afterward and **no** `Cases/` row/folder/DB change occurred.

---

## Docs to update (same PR)

- **`CLAUDE.md`** — tab count (3 → 4: add CDI), the IPC table (5 new methods), the settings note (clarify `enableCdi`/`cdiMode` gate the *Record-tab* CDI only; the CDI tab is independent), and the code map (`src/ipc/cdi.js`, `src/jobs/cdiManual.js`, `src/shared/cdi-modes.js`, `python/docx_to_md.py`, `renderer/views/cdiView.js`).
- **`docs/ARCHITECTURE.md`** — new subsection *Manual CDI tab* under the CDI/post-processing area, describing the ephemeral temp-folder flow and how it diverges from the audio-pipeline CDI step (no DB, no gate, mode-from-tab, ICD-presence-required).
- **`docs/DECISIONS.md`** — dated entry: *manual CDI is fully ephemeral (temp folder, no DB), independent of global `enableCdi`/`cdiMode`, requires ICD codes already present, and reuses the same `cdi-review` skill + standards packs* — with the why (on-demand review of externally-produced notes without polluting the case store).
- After merge: `git mv` this plan to `docs/archive/plans/` and drop its row from `docs/plans/README.md`.

---

## Open items / dependencies

1. **`python/docx_to_md.py`** — user will supply this Python script. Until it lands, the `.docx` upload path is stubbed: `START_CDI_REVIEW` returns `{ ok:false, error:'docx conversion not yet available' }` for `.docx` inputs, while paste + `.md` work end-to-end. The integration point (spawn via `PYTHON` resolver, read stdout → `<stem>_soap_note.md`) is fixed; only the script body is pending.
2. **Popup real-estate** — confirm the 4th tab fits the 280px-wide tab bar; abbreviate tab labels if the bar wraps.
3. **`cdi-review` ICD validation** — the skill validates every ICD code against the ICD-10 MCP connector (load-bearing, per the 2026-06-02 DECISIONS addendum). The MCP config is already synced to `<NOTES_DIR>/.mcp.json`; the manual run inherits it since `runSkill` uses `cwd = <NOTES_DIR>`. No extra wiring needed.

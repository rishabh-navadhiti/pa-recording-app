# Costigan procedure checklist → HTML report (pipeline-wired)

**Owner:** sr
**Status:** Implemented on `feature/costigan-cdi-api`. HTML + PDF + an "Open report" banner all shipped (Q1 resolved — user confirmed HTML first for testing, then PDF + button added in the same batch).
**Branch:** `feature/costigan-cdi-api` (current — the Costigan checklist already lives here)
**Date:** 2026-06-29

> **Update (PDF + button added):** Beyond the HTML, the job now also renders `<stem>_costigan_report.pdf` via `htmlToPdf()` ([src/render/htmlToPdf.js](../../src/render/htmlToPdf.js)) — an offscreen Electron `printToPDF` of the same HTML, best-effort (falls back to HTML on failure), kept visible. Because the checklist runs detached from the pre-chart job, completion pushes a new one-way **`costigan-report-ready`** event (channel added to `CHANNELS` + `preload.js`; no new `ipcMain.handle`), and a global **"Open report"** banner ([renderer/views/costiganBanner.js](../../renderer/views/costiganBanner.js)) surfaces it — opening reuses the existing `open-soap-note` IPC (report lives in `casesDir`). The `_costigan_report.{html,pdf}` stay visible; `.json`/`.md` stay hidden.

---

## 0. Goal in one paragraph

When **Costigan is enabled in Settings** (`enableCostiganCdi`) and the procedure checklist runs, the app should — in addition to today's `_costigan.json` + `_costigan.md` — auto-generate a **self-contained, shareable HTML report** from the checklist JSON, styled in the existing **Clinical Cockpit** look (navy command header, teal accent, clinical severity palette). The HTML is the *visible* deliverable in the case folder (like the SOAP `.docx`); the `.json`/`.md` stay hidden internals on Windows. No new dependencies, no DB schema change, no new Claude call — it's a pure deterministic render of data already on disk.

This is the Costigan-shape analogue of the combined-engine "cockpit report" the user already has for CDI / E/M / patient-summary. The Costigan JSON is a **different shape** (procedure-checklist, not CDI flags), so it needs its own render layer — but the same design system.

---

## 1. Why / scope

- Today `runCostiganChecklist()` ([src/jobs/costiganChecklist.js](../../src/jobs/costiganChecklist.js)) writes `_costigan.json` (canonical) + `_costigan.md` (via `renderCostiganMd`) and hides both on Windows. There is no human-friendly visual surface — the `.md` is hidden and plain.
- The user wants a single, self-contained `.html` per Costigan case, generated automatically whenever the checklist runs, matching their cockpit reference design (`C:\Users\Quickemu\Downloads\presentation_cockpit_scroller.html`).
- **In scope:** a new `renderCostiganHtml(data)` renderer + wiring it into `runCostiganChecklist`, gated by the same `enableCostiganCdi` that already gates the whole job. Tests + docs.
- **Out of scope (this batch):** PDF (the cockpit-engine plan's `printToPDF` path — note as a fast-follow), a Settings sub-toggle separate from `enableCostiganCdi`, any DB column, any change to the checklist JSON shape or the Claude call.

---

## 2. Reference design (the contract to preserve)

The look comes from `docs/notes/cdi-ui-reference/presentation_cockpit_scroller.html` (and the Downloads copy). We reuse its **design tokens and component vocabulary**, not its CDI/E/M/patient render layer (wrong data shape). Specifically we adopt:

- The `:root` CSS variable palette (navy `--bg`, teal `--accent`, severity colors `--crit/--warn/--sugg/--opp`, `--found/--missing`, radii, shadows, mono/sans stacks).
- The **non-sticky navy header** (`.cockpit-header` / `.patient-block` / `.verdict-pill`).
- **Cards**, **callouts**, **evidence boxes** (found/missing), **code chips**, **status pills**, and the **code-validation table** styles.
- The `@media print` + `@page Letter` rules (so a later PDF step is trivial).

The load-bearing contract from the reference — **data separated from render; swap the data and it re-renders for any case** — is preserved: `renderCostiganHtml(data)` reads *only* from the passed JSON.

---

## 3. Design decisions (with recommendations)

### 3a. Render in Node (string builder) vs. embed-data + client render-JS?

**Recommend: Node string builder** — `src/render/costiganHtml.js` exporting `renderCostiganHtml(data) → string` (a complete `<!DOCTYPE html>…</html>` document), exactly mirroring the existing `src/render/costiganMd.js` pattern.

Rationale:
- Consistency with `renderCostiganMd` (same module folder, same call site, same testing style as `costiganMd.test.js`).
- **Deterministic + unit-testable** without a browser — assert on the produced HTML string.
- No `</script>`-in-data escaping hazard (the reference embeds JSON in an inline `<script>`; we avoid that whole class of bug by building markup server-side).
- The render still reads only from `data`, so the "swap data, re-renders" contract holds.

Rejected: the reference's embed-`COSTIGAN_DATA`-+-inline-render-JS approach. It's the right choice when a browser/Electron renders it live (that's what the engine-cockpit PDF plan does), but for a one-shot file written from Node it adds an escaping footgun and a client-JS dependency for no gain here.

### 3b. Escaping (correctness-critical)

All dynamic strings (patient name, doctor, criterion text, evidence lines, fixes, denial reasons, coding issues, notes) are **clinical free text** and **must be HTML-escaped** (`& < > " '`) through a single `esc()` helper before interpolation. Un-escaped `<` / `&` in evidence text would silently corrupt the markup. The plan's tests must include a string with `<`, `&`, `"` and assert it round-trips escaped. (This is the analogue of the memory note's `</script>` concern, handled structurally by escaping every value.)

### 3c. Output file name + visibility

- File: `<stem>_costigan_report.html` in the case folder (`stem` = the `_soap_note.md` basename stem, same stem `runCostiganChecklist` already computes for `_costigan.json`). Parallel to the combined report's `<stem>_report.html` naming, namespaced with `costigan` so it can't collide.
- **Do NOT hide it on Windows.** The `.json`/`.md`/`.raw.txt`/`_chart_input.md` go into `writtenArtifacts` and get `attrib +h`'d — the HTML must stay **visible** (it's the deliverable the scribe opens, like the `.docx`). So: write it, but **do not** push it into `writtenArtifacts`.

### 3d. Where to wire it

Inside `runCostiganChecklist()` ([src/jobs/costiganChecklist.js](../../src/jobs/costiganChecklist.js)), immediately after the `jsonPath`/`mdPath` writes (around line 122), add a third write:

```js
const { renderCostiganHtml } = require('../render/costiganHtml')   // top of file
const htmlPath = path.join(caseDir, `${stem}_costigan_report.html`)
try { fs.writeFileSync(htmlPath, renderCostiganHtml(data), 'utf8') }   // NOT added to writtenArtifacts → stays visible
catch (e) { log(`${tag} html write failed: ${e.message}`) }
```

Single call site covers **both** prechart paths — `prechart.js` (CLI) and `prechartApi.js` (API) both delegate to `runCostiganChecklist`, so neither caller changes. The existing `enableCostiganCdi` + `isCostiganDoctor` gates at the top of the function already protect it; no new gate needed. Best-effort (try/catch, log on failure) — a render failure never breaks the job, matching how the `.md` write is treated.

Also handle the `data.parse_error` branch: `renderCostiganHtml` renders a clean error stub (pointing at `raw_output_path`), mirroring `renderCostiganMd`'s parse-error stub — so even a failed run produces a readable HTML.

### 3e. Surfacing / opening

The file lands in the case folder and is visible — the user can open it directly. **Optional fast-follow (note, not this batch):** an "Open Costigan report" affordance in the status popup, reusing an `openSoapNote`-style IPC (OS default handler, confined to `CASES_DIR`). Deferred unless the user wants the button now.

---

## 4. The render layout (sections, in data order)

`renderCostiganHtml(data)` produces, top to bottom:

1. **Navy header** — patient (`meta.patient`), doctor (`meta.doctor`), date of service (`meta.date_of_service`); an **overall verdict pill** colored by `summary.overall_status` (`audit_ready`→green, `needs_edits`→amber, `likely_denied`→red, `unknown`/`no_procedure`→grey); a small count cluster: `procedures_in_play` + `audit_ready_count` / `needs_edits_count` / `likely_denied_count`.
2. **Headline callout** — `summary.headline` (the one-paragraph executive summary).
3. **Per procedure** (`procedures_detected[]`, **rendered in JSON order** per the user's choice — no reordering by status):
   - Procedure card header: verdict pill + `procedure` — `subtype`; meta row `Intent · Stage(rung) · Site`.
   - **Denial-risk callout** when `verdict === 'likely_denied'` and `denial_reason` present.
   - **Medical-necessity checklist** — each `checklist[]` item in order, styled by `status`: `met`→green ✓, `not_met`→red ✗, `unclear`→amber ⚠. Shows `[id]` + `criterion`, an `evidence_found[]` "found" box, and a `fix` "action" box when non-null.
   - **Coding** — `cpt_observed` / `icd_observed` as code chips; `icd_suggested[]` as "add" chips (`code — description`, with `why`); `coding_issues[]` as a list.
   - **Frequency** — `cap`, `prior_dates[]`, `within_cap` (note this is **tri-state**: `true`/`false`/`"unclear"` string → render yes/no/unclear pill), `note`.
4. **Code validation summary** — `code_validation.codes_in_note` / `supported` chips; `flagged[]` as the cockpit code-validation table (code / issue / linked proc).
5. **Footer** — `generated_at`, `standards_versions` (`{facet: "procedures/facet v1 …"}`), a clinical-decision-support disclaimer.

**Edge cases the renderer must tolerate** (all present in the real `rizorodriguez_randy` JSON): empty arrays (`cpt_observed:[]`, `icd_observed:[]`, `prior_dates:[]`, `codes_in_note:[]`, `supported:[]`), `within_cap:"unclear"` (string not bool), `fix:null`, `denial_reason` long text, multi-paragraph `headline`, and missing optional fields. Sections with no content are omitted (mirror `renderCostiganMd`'s guards).

---

## 5. File-by-file change list

**New:**
- `src/render/costiganHtml.js` — `renderCostiganHtml(data) → string`. Self-contained HTML (inline `<style>` adapted from the cockpit tokens/components in §2; no external requests; `@media print`/`@page Letter`). `esc()` helper applied to every dynamic value. Verdict/status→color maps mirror `costiganMd.js`'s `VERDICT`/`STATUS`.
- `tests/unit/costiganHtml.test.js` — mirror `costiganMd.test.js`: (a) renders headline/verdict/checklist id/fix/suggested code for the sample; (b) `no_procedure` skip message; (c) `parse_error` stub; (d) `within_cap:false`/`"unclear"` render; (e) **escaping test** — `<`/`&`/`"` in evidence text comes out escaped; (f) **self-contained test** — no `http://`/`https://`/`src=`-to-external in output.

**Modified:**
- `src/jobs/costiganChecklist.js` — require + write `<stem>_costigan_report.html` after the md write; keep it **out** of `writtenArtifacts` (visible). Log the html path on success.
- `CLAUDE.md` — Pre-chart pipeline §7 (Costigan): note it now also writes `<stem>_costigan_report.html` (visible HTML report); Quick references (Skills/artifacts line).
- `docs/ARCHITECTURE.md` — Costigan checklist artifacts list.
- `docs/DECISIONS.md` — dated entry: Costigan HTML report is a Node string-builder render (not the embed+client-JS cockpit approach), visible (not hidden), PDF deferred.
- `docs/plans/README.md` — add this plan's row; on ship, `git mv` to `archive/plans/`.

**Explicitly NOT touched:** the checklist JSON shape, the `cdi-costigan-api` skill / Claude call, `renderCostiganMd` (the `.md` stays), the DB, the prechart callers, `enableCostiganCdi` gating.

---

## 6. Risks / things to get right

- **Escaping** (§3b) — the one real correctness risk; covered by a dedicated test.
- **Visibility** — must NOT join `writtenArtifacts` or Windows will hide the report. Test/verify on Windows that the file is visible.
- **Tri-state `within_cap`** — `false` and `"unclear"` are different; don't collapse them (the `costiganMd` test already guards `false`).
- **Self-contained / CSP-safe** — all CSS inline, system fonts only, zero external requests (so it's shareable offline and PDF-ready). Asserted in tests.
- **Best-effort** — render failure logs + continues; the job's success/`processing_events` status is unaffected (the HTML is derivative of the already-persisted JSON).
- **Print-readiness** — keep the `@media print`/`@page` + `break-inside:avoid` on cards so a future `printToPDF` (fast-follow) paginates cleanly.

---

## 7. Sequencing

1. Build `src/render/costiganHtml.js` against the real `rizorodriguez_randy_2026-06-29_costigan.json` (open the output in a browser to eyeball the design vs. the reference).
2. Add `tests/unit/costiganHtml.test.js`; `npm test` green.
3. Wire the one write into `costiganChecklist.js`.
4. Run a Costigan case end-to-end (`npm start`, pre-chart on a Costigan doctor with chart text) and confirm the visible `_costigan_report.html` appears and renders.
5. Update living docs; move this plan to `archive/plans/` after merge.

---

## 8. Open question

- **Q1 — PDF now or later?** The user asked for HTML. Recommend HTML-only this batch; add `printToPDF` as a fast-follow (the `@media print` rules are built in so it's a small add). Confirm before implementing if they also want the `.pdf`.

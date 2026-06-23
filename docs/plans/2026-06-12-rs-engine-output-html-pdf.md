# Engine outputs: Markdown/docx → HTML→PDF render path

**Owner:** rs
**Status:** Planned (design only — do NOT implement from this doc yet; open questions below)
**Branch (when implementing):** off `feature/pa-engines-v0.2` (or `develop` if v0.2 has merged by then) — confirm at start
**Date:** 2026-06-12

---

## 0. Goal in one paragraph

Move the **review/scoring engine outputs** (CDI, E/M MDM, Patient Summary — and any future engine of this kind) off the Markdown→docx render path onto an **HTML→PDF** path rendered in-process by Electron's `webContents.printToPDF` (Chromium, **zero new deps**). Each engine keeps emitting its JSON exactly as today; the app fills a **reusable, self-contained HTML template** from that JSON and prints it to `<case>_<engine>.pdf` in the case folder. The JSON is hidden (`attrib +h`, like other internals); the scribe sees the **PDF** (+ the hidden JSON). **No Markdown, no docx for these engine outputs.** The SOAP note's own md→docx is a **separate clinical-document concern and stays exactly as-is.**

The chosen look is the **cockpit** design; the PDF-target is the single-scroll, print-optimised variant. Both are already in the repo as reference (see §2).

---

## 1. Why / what changes

Today (`feature/pa-engines-v0.2`):
- **CDI** emits `<case>_cdi.json` + `<case>_cdi.md`, and `src/pipeline/chain.js` runs `docx.spawnDocxConversion()` on the `_cdi.md` → `<case>_cdi.docx`.
- **em-score / patient-summary** emit JSON only (no MD, no docx) — already JSON-only, so they just need a *render* added, not a render *removed*.
- The SOAP note: `generate-note` → `_soap_note.md` → `spawnDocxConversion` → `_soap_note.docx`. **Unchanged by this work.**

After this work:
- **CDI** stops emitting `_cdi.md` and the chain stops converting it to `_cdi.docx`. CDI's canonical output is `_cdi.json` (hidden) + a rendered `<case>_cdi.pdf`.
- **em-score / patient-summary** gain a `<case>_em.pdf` / `<case>_patient_summary.pdf` rendered from their JSON.
- A new **engine-agnostic PDF post-step** renders any engine that declares it wants a document, exactly the way docx is a fixed post-step today.
- The **SOAP note** keeps md→docx untouched.

This is the presentation half of the "JSON is canonical, presentation renders from JSON" contract the v0.2 engines were built around (see `docs/plans/2026-06-11-rs-pa-engines-v0.2.md` §0 and the 2026-06-11 DECISIONS entry).

---

## 2. Reference design (the contract to preserve)

Two reference HTMLs live in **`docs/notes/cdi-ui-reference/`** (see its README):

- **`presentation_cockpit.html`** — the chosen look & colour (dark navy command header + teal accent + clinical severity palette), a **tabbed** working surface. This is the reference for the *future in-app interactive* surface — NOT this batch.
- **`presentation_cockpit_scroller.html`** — *(moved into the repo by this task)* the **single-scroll, print-optimised** version of the same design, with `@media print` + `@page` rules. **This is the PDF-target reference for this batch.**

Both share the load-bearing contract:

```
const PA_DATA = { meta, cdi, em, patient_summary };   // verbatim engine JSON
// … then a RENDER LAYER that reads ONLY from PA_DATA and is case-agnostic.
```

Render logic is **separated from data**: swap `PA_DATA` and the page re-renders for a different case. The three sample JSONs in that folder (`amy_2026-06-12_{cdi,em,patient_summary}.json`) are a real run's actual output and document the exact shapes the template must handle (nulls, empty arrays, absent fields).

**The contract we preserve:** the app injects the same `{ meta, cdi, em, patient_summary }` object into the template. The template's render layer is lifted (near-verbatim) from the scroller; the app supplies `PA_DATA` from the engine JSON on disk. CSP-safe (verified: the scroller makes zero external requests).

---

## 3. Design decisions to make (with recommendations)

### 3a. One template with sections, or per-engine templates?

**Recommendation: ONE template with conditional sections** (`meta` + `cdi?` + `em?` + `patient_summary?`), matching the scroller's existing shape — but driven by **which engine(s) ran for this case**, not always all three.

Rationale:
- The scroller already renders all three from one `PA_DATA` with `renderCDI()` / `renderEM()` / `renderPatient()` each guarding on presence. That's the natural unit.
- **But** engines run independently and are individually toggle-gated — a case may have CDI but not em-score. Two sub-options:
  - **(A) Per-engine PDFs from one template.** Render the one template with only the relevant section populated, once per engine → `<case>_cdi.pdf`, `<case>_em.pdf`, `<case>_patient_summary.pdf`. Each engine's `toDocument()` returns `{templateId:'cockpit', data:{meta, <engineKey>:result}}`; the PDF post-step prints one PDF per engine. **Simplest mapping to the existing per-engine post-step model; recommended for this batch.**
  - **(B) One combined case PDF.** After all engines finish, render one `<case>_review.pdf` containing every section that ran. Closer to the cockpit's "one cockpit per case" feel, but it's a *case-level* post-step (must run after the whole chain, needs to gather all engine JSONs), not a per-engine one — more orchestration, and re-rendering when only one engine re-runs is awkward.

  **→ Recommend (A) for this batch** (per-engine PDF, one shared template, section-scoped), with (B) — a combined cockpit PDF — noted as a fast-follow once the per-engine path is proven. **OPEN Q1.**

- Keep the template a **single self-contained `.html` asset** with the render layer inlined; the app injects `PA_DATA` (see §3c). Per-engine *templates* (separate files per engine) are rejected — it fragments the shared design system and the scroller already proves one template handles all three.

### 3b. Where does the HTML/template live, and how is it filled?

- **Template asset:** `templates/engine-report/cockpit.html` (new top-level `templates/` dir, or `src/render/templates/` — **OPEN Q2** on location). It is the scroller's CSS + render-layer JS, with the hardcoded `PA_DATA` block replaced by an **injection point**.
- **Injection mechanism (CSP-safe, no deps):** the render layer reads `window.PA_DATA`. The app produces the final HTML by replacing a sentinel (e.g. `/*__PA_DATA__*/` or a `<script id="pa-data" type="application/json"></script>` placeholder) with the case's JSON, then loads that HTML into an offscreen `BrowserWindow` for `printToPDF`. **No template engine, no string interpolation into markup** — only a single JSON blob is injected into a `<script type="application/json">` tag (inert, XSS-safe; the render layer `JSON.parse`s it). This keeps the markup identical to the reference and the data strictly separated.
- The render layer stays **verbatim from the scroller** as much as possible, so design iteration happens in the reference HTML and is copied across (or, better, the reference *becomes* the template — **OPEN Q3**: do we dedupe the scroller and the template into one file, or keep the scroller as a design sandbox and the template as the shipped copy?).

### 3c. The PDF render pipeline (mirror how docx is treated)

docx today (`src/pipeline/docx.js`) is a **fixed post-step** the chain calls after the engines — it is NOT inside `runEngine`. We mirror that exactly:

1. **New module `src/pipeline/pdf.js`** exporting `renderEnginePdf(doc, caseCtx, ctx)` (and the chain calls it), structured like `spawnDocxConversion` but Chromium-based:
   - Build the final HTML: read `templates/engine-report/cockpit.html`, inject `PA_DATA` (the `{meta, <engineKey>:<engine JSON from disk>}` object).
   - Create an **offscreen `BrowserWindow`** (`show:false`, `webPreferences:{ sandbox:true, nodeIntegration:false, contextIsolation:true }`), `loadURL('data:text/html;base64,…')` or load a temp file, `await win.webContents.printToPDF({ printBackground:true, pageSize:'Letter'/'A4', margins })`, write the Buffer to `<case>_<engine>.pdf`, destroy the window.
   - Hide the source JSON via `ctx.platform.hideInternal(jsonPath)` on success (Windows `attrib +h`; no-op mac), matching how docx hides the `.md`.
   - Record a `processing_events` row (`job_kind:'pdf'`) for telemetry, like docx does.
   - Update the case's DB path field for that engine's PDF (see §3d).
   - Best-effort: failure logs + leaves the JSON on disk; the chain continues. **No throw.**

2. **Engine-agnostic hook on the descriptor: `toDocument(result, caseCtx) → { templateId, data, outPath } | null`.** The PDF post-step calls `engine.toDocument(...)` rather than switching on `engine.id`. An engine that returns `null` (or omits `toDocument`) gets no PDF. Example for em-score:
   ```js
   toDocument(result, caseCtx) {
     if (!result?.manifest) return null
     const json = JSON.parse(fs.readFileSync(result.manifest.json_path, 'utf8'))
     return {
       templateId: 'cockpit',
       data: { meta: deriveMeta(caseCtx, json), em: json },
       outPath: result.manifest.json_path.replace(/_em\.json$/, '_em.pdf'),
     }
   }
   ```
   This keeps `src/pipeline/pdf.js` free of any per-engine knowledge — it just renders whatever `{templateId, data}` it's handed. Adding a future engine that wants a PDF = give it a `toDocument()`; the renderer needs no edits. (This is the same philosophy as the existing `interpret()`/`persist()` hooks — behaviour lives on the descriptor, the runner/post-step is generic.)

3. **Chain wiring (`src/pipeline/chain.js`):** after the engines persist (today: after `runEngine(patientSummary)`, before/around the docx calls), iterate the engines that ran and, for each whose `toDocument()` returns non-null, call `pdf.renderEnginePdf(...)`. Keep it **sequential** for now (status simplicity — same rationale as the engines themselves). The SOAP docx call stays where it is; only the **CDI** docx call is removed (§3e).

   > Treat the PDF step like docx: a fixed post-step after `persist()`, **not** inside `runEngine`. `runEngine` stays render-agnostic; `render()` (the existing status-UI hook) is unrelated and still unused.

### 3d. DB / paths

- **No new `cases` columns for the new engines.** em-score/patient-summary PDFs are referenced from the generic **`engine_outputs`** table — add a nullable **`pdf_path`** column to `engine_outputs` (migration 006), set by the PDF post-step. (One column on the *generic* table, not per-engine `cases` columns — consistent with the v0.2 anti-splatter decision.)
- **CDI** already has a `cases.cdi_docx_path` column. Two options (**OPEN Q4**):
  - **(A)** Repurpose nothing — add `cases.cdi_pdf_path` (one column, migration 006) and stop writing `cdi_docx_path`/`cdi_md_path` (leave the columns, just NULL going forward). Cleanest semantically.
  - **(B)** Reuse `cdi_docx_path` to hold the PDF path (rename in a migration, or just store the `.pdf` there). Less clean but no new column and no renderer/DB-reader churn.
  - **→ Recommend (A)**: add `cdi_pdf_path`, leave the docx/md columns for back-compat (older cases keep their values), new runs populate `cdi_pdf_path` only.
- `db/cases.js updateCaseCdi` allow-list + `db/engine_outputs.js` get the new path field. The status UI's "Open CDI Review" button (today opens the docx) re-points to the PDF (**renderer change — OPEN Q5** on how the status window opens it; `openSoapNote`-style confinement to CASES_DIR applies).

### 3e. Removing CDI's Markdown + docx

- **`cdi-review` SKILL.md:** drop the deterministic MD-render step (Step 8) and stop writing `_cdi.md`. The skill emits **JSON + manifest only** (manifest's `md_path` becomes `null`). The on-disk-JSON fallback (`synthesizeManifestFromDisk`) stays — it keys on `_cdi.json`, not the md.
- **`src/engines/cdi.js`:** `persist()` stops needing `cdi_md_path`; `interpret()` no longer expects an md. Its `toDocument()` (new) returns the cockpit-CDI document.
- **`src/pipeline/chain.js`:** remove the second `spawnDocxConversion(cdiMdPath, …)` call. (The SOAP `spawnDocxConversion` stays.)
- **`src/pipeline/docx.js`:** the `'cdi'` classification branch becomes dead for new runs — **leave it** (older cases / safety; it's harmless) or remove it (**OPEN Q6**, minor). Recommend leaving it this batch to minimise churn.
- **`cdi-costigan`** (the procedure-checklist CDI variant) emits `_costigan.md` + a render too — **OPEN Q7**: bring it onto the HTML→PDF path in this batch (consistent), or leave it on MD for now since it's not in the audio pipeline? Recommend: same treatment (drop its MD, give it a `toDocument()`), but it's lower priority since it's not pipeline-wired — could be a fast-follow.
- **Update tests + living docs** (CLAUDE.md flow, ARCHITECTURE.md chain, DECISIONS entry, the engine tracker).

### 3f. Engine fix — `em-score` must emit a structured `billed_em_code`

**Problem (real, found while building the prototypes):** the scroller's render layer **hardcodes `99215`** in three places (the billed-level strike-through, the downcode card, the upgrade card) because the billed code only exists as **prose** inside `em.json`'s `upgrade_path` / `headline` (e.g. *"the note contains the billing placeholder '[.KS15 — 99215]'"*). There is no structured field for "what the provider billed." A data-driven template can't render the downcode story (billed vs supported) without it.

**Fix at the engine (`em-score` skill + schema):**
- The skill already reads the note. Have it **parse the billing placeholder** (Dr. Costigan/Sabbag notes carry a `.KS15`-style Level-of-Service placeholder, e.g. `[.KS15 — 99215]`) and emit a structured field:
  ```json
  "billed_em_code": "99215",          // the code the note is billed at, parsed from the placeholder; null if none found
  "billed_em_source": "placeholder",  // 'placeholder' | 'explicit' | null  — where it came from
  ```
- The **downcode story becomes data-driven**: `downcode_risk` + `billed_em_code` vs `predicted_em_level`. The template renders "billed 99215 → supported 99214" purely from data; no hardcoded code anywhere in the render layer.
- Keep the existing prose (`headline`, `upgrade_path`) — but the structured field is the source of truth for the render.
- **Connector-free** (CPT, not ICD — the connector can't validate CPT anyway; em-score is already ICD-clean).
- Add to the em-score JSON schema + the manifest (a `billed_em_code` echo is optional in the manifest). Update `em_mdm_2021.md` only if a worked example needs it (the placeholder parsing is a skill instruction, not a standards rule).
- **OPEN Q8:** the `.KS15` placeholder format — is it stable across doctors, or doctor-specific? The skill should parse defensively (regex for a `99xxx` near a Level-of-Service/`.KS`-style token) and set `billed_em_code:null` when absent (then the template simply omits the billed-vs-supported comparison and shows the predicted level alone).

### 3g. PHI / de-identification (note for later, not this batch)

The HTML inlines real patient data (name, DOB, clinical detail) — **fine now** (PHI handling is deferred, per the reference README + the v0.2 posture). **Flag for later:** before any external distribution or cloud render, a de-identification pass is needed. The `meta` block is the natural choke point (it carries patient identity); a future `deidentify(PA_DATA)` step could redact there. **Not in scope here** — just recorded so it isn't forgotten.

---

## 4. File-by-file change list (for the implementer)

**New:**
- `templates/engine-report/cockpit.html` (or `src/render/templates/` — OPEN Q2) — the shared template: scroller CSS + render layer + a `<script type="application/json" id="pa-data">` injection point (no hardcoded `PA_DATA`).
- `src/pipeline/pdf.js` — `renderEnginePdf(doc, caseCtx, ctx)`: build HTML (inject PA_DATA) → offscreen BrowserWindow → `printToPDF` → write `<case>_<engine>.pdf` → hide JSON → DB path + `processing_events`. Engine-agnostic.
- `db/migrations/006_*.sql` — `engine_outputs.pdf_path TEXT` + `cases.cdi_pdf_path TEXT` (OPEN Q4).
- `tests/unit/pdf.test.js` — render-layer/template smoke (inject a sample PA_DATA, assert the produced HTML is well-formed + contains expected sections); `toDocument()` shape tests per engine.

**Modified:**
- `src/engines/{cdi,emScore,patientSummary}.js` — add `toDocument(result, caseCtx)`. CDI: stop relying on `_cdi.md`.
- `src/engines/cdi.js` + `notes-claude/skills/cdi-review/SKILL.md` — drop the MD render (Step 8), JSON-only, manifest `md_path:null`.
- `notes-claude/skills/em-score/SKILL.md` + em-score JSON schema — add `billed_em_code` / `billed_em_source` parsing (§3f).
- `src/pipeline/chain.js` — call `pdf.renderEnginePdf` for engines that returned a `toDocument`; remove the `_cdi.md` docx call; keep SOAP docx.
- `db/engine_outputs.js` (+ `db/cases.js` allow-list) — new path field(s).
- `renderer/` (status window) — "Open CDI Review" opens the PDF, not the docx (OPEN Q5).
- Docs: CLAUDE.md (pipeline flow + the new PDF post-step + "engine review outputs are JSON+PDF, no MD/docx"), `docs/ARCHITECTURE.md` (the chain + a new "engine-output rendering" subsection), `docs/DECISIONS.md` (the HTML→PDF decision + the `billed_em_code` fix + PHI-deferred note), `docs/pa-planning/05-engines.md` (presentation status), `docs/notes/cdi-ui-reference/README.md` (already updated to point at the scroller as PDF-target).

**Explicitly NOT touched:**
- `generate-note` / the SOAP note's `_soap_note.md` → `_soap_note.docx` path. (Clinical document — separate concern.)
- `python/md_to_docx.py` (still used by SOAP + transcript).
- The engines' JSON shapes (except em-score's additive `billed_em_code`) and their `persist()`/`engine_outputs` writes.

---

## 5. Risks / things to get right

- **`printToPDF` needs `app.whenReady()` + a BrowserWindow** — it's main-process Electron, available in the pipeline context. The offscreen window must be created and destroyed per render (don't leak windows across many cases). Consider a small serialization (one offscreen render at a time) — fits the "sequential for now" stance.
- **CSP / self-contained:** the template must inline all CSS/JS/fonts and embed any images as data URIs (the scroller already does — verified zero external requests). A strict CSP on the offscreen window (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`) is belt-and-suspenders; confirm the inlined render JS runs under it (it uses inline `<script>`, so `'unsafe-inline'` or a nonce is required — **OPEN Q9**).
- **Page breaks:** the scroller's `@media print`/`@page` rules decide multi-page flow. Long CDI flag lists must paginate cleanly (avoid mid-card breaks — `break-inside: avoid` on cards). Verify against the longest real case (the Amy run has a full flag set).
- **Data-driven render:** once `billed_em_code` lands, audit the template for **any** remaining hardcoded case-specific values (the three `99215`s, any patient-name literal) and replace with `PA_DATA` reads. The "swap PA_DATA, re-renders for any case" invariant must hold.
- **Best-effort parity:** a PDF render failure must not fail the case (SOAP completion is the primary deliverable). Mirror docx's best-effort behaviour.

---

## 6. Open questions (resolve before implementing)

- **Q1 — per-engine PDFs vs one combined case PDF?** Recommend per-engine (one shared template, section-scoped) this batch; combined cockpit PDF as fast-follow.
- **Q2 — template location:** `templates/engine-report/` (new top-level) vs `src/render/templates/`? (Affects packaging — must ship with the app, and be readable at runtime in both dev and the installed app.)
- **Q3 — scroller vs shipped template:** dedupe into one file (the reference *is* the template) or keep the scroller as a design sandbox and maintain a separate shipped copy? (Dedupe = no drift but couples design iteration to the app; separate = a copy step.)
- **Q4 — CDI PDF path column:** add `cases.cdi_pdf_path` (recommend) vs reuse `cdi_docx_path`?
- **Q5 — "Open CDI Review" button:** how does the status window open the PDF (OS default handler via an `openSoapNote`-style IPC confined to CASES_DIR)? Confirm the renderer change.
- **Q6 — `docx.js` 'cdi' branch:** leave the now-dead CDI-docx branch (recommend, minimal churn) or remove it?
- **Q7 — `cdi-costigan`:** bring it onto HTML→PDF in this batch, or leave it on MD (it's not pipeline-wired)? Recommend same treatment as a fast-follow.
- **Q8 — `.KS15` placeholder format:** stable across doctors or doctor-specific? Defensive regex + `null` fallback assumed.
- **Q9 — CSP for inline render script:** `'unsafe-inline'` vs a nonce injected alongside PA_DATA?
- **Q10 — page size / margins:** Letter (US clinical default) vs A4? Header/footer (page numbers, "generated" stamp) via `printToPDF`'s `headerTemplate`/`footerTemplate` or baked into the HTML?

---

## 7. Sequencing

1. Land `em-score`'s `billed_em_code` fix first (small, isolated engine+schema change; unblocks the data-driven template).
2. Build `templates/engine-report/cockpit.html` from the scroller (replace hardcoded PA_DATA with the injection point; remove the three hardcoded `99215`s once `billed_em_code` exists).
3. Build `src/pipeline/pdf.js` + the `toDocument()` hooks + migration 006.
4. Wire the chain; remove CDI's md/docx; update the status-window "open" path.
5. Tests + living docs.

Each step is independently testable. Implement on a branch off `feature/pa-engines-v0.2` (or develop if v0.2 merged); promote `develop → staging → main` per the branch flow.

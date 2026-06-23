# CDI / Engine-Output UI Reference

Visual reference for how Physician Assist engine output (CDI, E/M MDM, Patient Summary) is presented to a scribe. Built from a real run (Dr. Sabbag / patient Amy Berger / workers'-comp left distal-radius case — the `*_{cdi,em,patient_summary}.json` files here are that run's actual engine output).

**Not production code.** This is a design reference for two future phases:
- the **semi-UI** — the in-app HTML-rendered case view, and
- the **full unified app dashboard**.

## Chosen direction
**`presentation_cockpit.html`** — the chosen look & colour (dark navy command header + teal accent + a clinical severity palette; a tabbed working surface). This is the reference for the in-app surface.

## Other directions explored (kept as reference)
- `presentation_triage.html` — single-scroll, action-first ("scan & act" mode; its action-first ordering is worth folding into the cockpit's CDI tab).
- `presentation_editorial.html` — typeset print/PDF-quality document.
- `presentation_dashboard.html` — dense multi-panel grid (north-star for the eventual all-cases dashboard).
- `index.html` — launcher + critique scorecard comparing all four.

## The contract that carries forward
Every file renders entirely from a single `const PA_DATA = { meta, cdi, em, patient_summary }` object near the top — **verbatim engine JSON** — with render logic kept separate from the data. This is deliberate: the app's renderer later injects the same object into the chosen template (the "saved case-file rendered in our renderer" path). The `.json` files document the exact data shapes the template must handle (including nulls / empty arrays / absent fields).

## Current phase vs this reference
The **current** phase uses a single-scroll, print-optimised cockpit (**`presentation_cockpit_scroller.html`**, now in this folder) → PDF via Electron `printToPDF`. It is the **PDF-target reference** for the HTML→PDF engine-output pipeline (see the plan `docs/plans/2026-06-12-rs-engine-output-html-pdf.md`). `presentation_cockpit.html` (tabbed) is the richer, interactive reference for the later in-app UI. Both render from the same `PA_DATA` contract; the scroller adds `@media print` / `@page` rules and a single-scroll layout so one Chromium print pass produces a clean multi-page PDF.

**Verified CSP-safe:** the scroller makes zero external resource requests (no CDN, fonts, or remote images) — required for `printToPDF` and the future in-app webview.

## PHI note
These HTMLs inline a real patient's clinical data (test case). Fine for the current dev posture; scrub before any external distribution.

_Generated 2026-06-19 from the presentation design exploration._

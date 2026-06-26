# Costigan Procedure-Checklist (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, Costigan-only **procedure-checklist** that runs as a single Anthropic Messages-API call inside the pre-chart (edit-note) flow — segregating a pasted Epic-chart input from the scribe-facing note edit — and writes a checklist JSON + Markdown to the case folder.

**Architecture:** Mirror the existing `generate-note-api` / `edit-note-api` single-call pattern. A new `cdi-costigan-api` skill is the **system prompt**; the 5 procedure rubric packs are concatenated onto the system prompt (static reference); the per-case clinical record (final SOAP note + pasted Epic chart + injected facts) is the **user message**. **No tools, no ICD connector** — the packs already carry connector-validated closed code lists, so the model relies on them. The run is wired as a step in `prechartApi.onSuccess` (and the CLI prechart's `onSuccess` for dev parity), gated by a new global setting **and** a "doctor is Costigan" check. **No DB schema changes** — one `processing_events` row per run + on-disk artifacts discovered by path convention.

**Tech Stack:** Electron, Node (CommonJS), Anthropic Messages API via `ctx.api.runSingleCall`, the existing job/engine framework, `node:test` for unit tests.

## Global Constraints

- **Base branch:** `develop` (already has the full API stack: `generate-note-api`, `edit-note-api`, `prechartApi.js`, `singleCall.js`, `anthropicApiProvider.js`).
- **No new DB migrations or columns.** The only DB write is one `processing_events` row via `db/events.js` (`jobKind: 'costigan'`). Artifacts (`_costigan.json`, `_costigan.md`) live in the case folder, found by path convention.
- **No live ICD connector.** The Anthropic single call has no tools. Rely on the packs' covered-code lists (validated at pack-authoring time). Never invent or "suggest a more specific" code beyond a pack's list.
- **Edit-note path unchanged.** "Box A" (instructions + file attachments) feeds edit-note exactly as today. The new "Box B" chart textarea feeds ONLY the checklist and appears ONLY when `enableCostiganCdi` is on.
- **Provider:** the checklist always uses `ctx.api` (Anthropic) with model `claude-sonnet-4-6`, regardless of the edit-note `soapModel` provider. (Reason: the packs/skill are Claude-tuned; the checklist is an EOD batch — quality over cost.)
- **Parallel + additive to general CDI.** This is independent of `cdi-review` (general CDI may still run for Costigan). No coupling between `enableCostiganCdi` and `enableCdi`.
- **No transcript input (v1).** The checklist evaluates the *auditable record* (note + chart). Transcript is excluded — see Background §"Why no transcript."
- **Commit style:** `<type>: <imperative>`. No `Co-Authored-By`. Update living docs (CLAUDE.md, DECISIONS.md, docs/plans/README.md) in the same work.
- **Platform parity:** hide new `.md`/`.json` artifacts on Windows via `ctx.platform.hideInternal` (no-op on macOS), mirroring the prechart note handling.

---

## Background — everything a fresh session needs

### What this feature is
`cdi-costigan` is a CDI variant specialized for **interventional spine/pain** procedures (ESI, facet, TPI, sacroiliac, PVA/kyphoplasty). It takes a finalized note + chart, detects which procedure(s) are **performed or requested**, and checks each against the Medicare medical-necessity checklist for that procedure (Cedars-Sinai CRI / LCD-derived), producing a per-item `met` / `not_met` / `unclear` verdict with the evidence quote and the specific documentation fix, plus an overall audit-readiness verdict. It exists because the practice (Dr. William Costigan, Cedars-Sinai, MAC Noridian J-E) was hit by a Medicare TPE audit on **CPT 64483** (transforaminal epidural): 23.3% error rate, 7 denials, a Corrective Action Plan. The signature gap it catches: prior-injection **dates** are documented but the **% relief on the same scale** is not — exactly what fails the repeat-procedure necessity test.

The **existing agentic skill** lives at `notes-claude/skills/cdi-costigan/SKILL.md`. It runs via `claude -p`, reads files with the Read tool, reads the 5 packs from disk, validates every emitted ICD code against the ICD-10 **MCP connector**, and writes `<stem>_costigan.json` + `<stem>_costigan.md`. **This plan does not change that file.** It creates a parallel **API** variant.

### The 5 procedure rubric packs (the substance)
`notes-claude/standards/procedures/{esi,facet,tpi,si,pva}.md` (+ `README.md`). Each pack = detection cues, CPT codes, **covered ICD-10 list** (closed for facet/TPI/SI/PVA; representative-only for ESI — the LCD publishes no closed ESI list), the medical-necessity checklist items (with stable IDs like `ESI-2`, `FACET-D2`, `SI-5`), thresholds (ESI repeat ≥50%/3mo same scale; facet diagnostic ≥80%×2; SI diagnostic ≥75% + ≥3 of 6 named provocative tests; TPI ≥50%/6wk + covered only for myalgia/tension-HA; PVA inclusion/exclusion, marrow-edema MRI, osteoporosis continuum), frequency caps, modifiers (KX on diagnostic facet/SI; −50 bilateral), exclusions, and verdict guidance. **The covered-code tables are explicitly connector-validated at authoring time** (each says "All connector-validated billable") — that is why dropping the live connector in the API variant is safe. Total ≈ 720 lines across the 5 packs.

### Input-source reality (why the design splits inputs)
The doctor's **physical exam is never dictated or handwritten** — the scribe fills it from Epic SmartList dropdowns. So the checklist's exam-axis items (SI's ≥3 named provocative tests, trigger-point findings, motor/sensory/reflex) and the imaging reports live in the **Epic chart**, not in the audio or the HPI+A&P note. By **end of day**, when the scribe assembles the chart, the exam + imaging are present. Hence:
- **Box A — handwritten/instructions + file attachments** → feeds `edit-note` → the final HPI+A&P (the scribe's deliverable, pasted into Epic). Kept lean so exam/imaging never leak into it.
- **Box B — the pasted Epic chart** (exam, imaging, prior-procedure history) → feeds the **checklist only**.

The checklist runs on **{final SOAP note + Box-B chart}**. The handwritten is redundant (the final note was generated from it); the transcript is excluded.

**Why no transcript:** an auditor never sees the transcript, so transcript content must never count as "criterion met." Evaluating only the auditable record (note + chart) keeps the verdict honest and avoids false-positive "met"s. (A future v2 could add the transcript as a labeled cross-reference to power "said-but-not-charted" nudges — out of scope here.)

**Tier-C guardrail (critical):** when the chart is absent or lacks the structured exam, exam-dependent items must be `unclear` with a fix like "confirm in the Epic exam," **never** `met`. The model must not assume an exam it cannot see. (Costigan's exam is mostly default values; a model told to "assume normal" would stamp false audit confidence.)

### Current API architecture (the pattern to mirror)
`develop` already ported SOAP-gen and edit-note to a single Anthropic API call:
- **Provider** `src/llm/anthropicApiProvider.js` → `createAnthropicApiProvider({getKey, log})` exposes `runSingleCall({ system, user, model, maxTokens=16000, tag, label })` → `{ ok, text, rawUsage, stopReason, statusCode, durationMs, errText }`. No tools, no streaming. Assembled as `ctx.api` in `context/appContext.js`.
- **Message builders** `src/llm/skill-io/singleCall.js`: `buildSingleCallNoteGen` / `buildSingleCallNoteEdit`. Pattern: `system = stripFrontmatter(skillText)`; the per-case content is assembled into the `user` string. **Builders are pure (no file I/O)** — the calling job reads files and passes text in.
- **The edit-note job** `src/jobs/prechartApi.js` is a `JobDescriptor` with a `runLlm(input, ctx, {model})` hook: it finds the existing note, reads template/note/transcript/attachment + the skill file, creates a backup, calls `buildSingleCallNoteEdit`, calls `provider.runSingleCall`, writes the note. Its `onSuccess(runResult, input, ctx, extra, {durationMs})` re-runs ICD + docx (`runEngine(icdEngine, ...)` — `runEngine` is in `extra`), re-hides `.md`, and notifies. `extra` carries `{ patientLabel, caseId, combinedAttachmentPath, runEngine, icdEngine, spawnDocxConversionFn, findExistingSoapNoteFn }`.
- **Provider/descriptor selection** `main.js spawnPrechartJob` (≈ lines 945–970): builds `input = { caseDir, templatePath, attachmentPath, instructions }`, picks `descriptor = (resolveOption(soapModel).provider === 'cli') ? prechartJob : prechartApiJob`, and calls `runJob(descriptor, input, ctx, extra)`.
- **Engines (cdi-review, icd, em) are NOT API** — they still run via `ctx.llm.runSkill` (claude -p). They are used on dev systems only; the scribe's installed app is API-only and only exercises SOAP + edit-note. **This is why the checklist must be the API single-call pattern, NOT an engine descriptor.**

### System vs user prompt division + pack injection (the key design)
Mirroring `generate-note-api` (skill = system; per-case content = user), and extending it:

- **SYSTEM prompt** = `stripFrontmatter(cdi-costigan-api/SKILL.md)` **+ the 5 procedure packs concatenated** under a `# PROCEDURE RUBRIC PACKS` header. The skill body is the *invariant analytical framework* (detection, two-pass evaluation, item statuses, coding checks, verdict guidance, the output JSON schema, behavior rules). The packs are *invariant reference material* used on every case. Both are identical across all Costigan cases → they belong in the system prompt (and are the natural future prompt-cache breakpoint).
- **USER message** = the *per-case* clinical record: INJECTED FACTS (patient, date of service, doctor) + the final SOAP note + the Epic chart. This is what varies case to case.

**Why all 5 packs, not detect-then-load:** a single API call can't do the agentic "detect first, then read only the matching pack" two-step. Injecting all 5 (≈720 lines) lets the model do detection + evaluation in one pass, and the packs are small enough that this is cheap (and cacheable later). **Pack injection mechanism:** the calling job reads the 5 pack files from `notes-claude/standards/procedures/` at call time and passes the concatenated text to the builder — keeping the packs as the single source of truth shared with the agentic skill (no duplication into the SKILL.md). *(Future optimization, out of scope: add `cache_control` to the system block so the skill+packs are prompt-cached; or pre-filter packs by a JS keyword scan. Not needed for an EOD batch.)*

### The end-to-end flow this builds
```
Scribe records audio → SOAP note generated (HPI+A&P).
EOD: scribe opens Pre-chart tab, picks the case, pastes the doctor's handwritten into Box A,
     and (Costigan only) pastes the Epic chart into Box B.
  → edit-note-api integrates Box A → final HPI+A&P (+docx)              [unchanged]
  → IF enableCostiganCdi && doctor is Costigan:
       cdi-costigan-api single call on {final note + Box-B chart}
         → writes _costigan.json + _costigan.md + _chart_input.md
         → one processing_events row (jobKind 'costigan')              [NEW]
```

---

## File Structure

**Create**
- `notes-claude/skills/cdi-costigan-api/SKILL.md` — the ported API skill (system prompt; analytical framework + JSON-only output contract; no tools/connector/file-I/O).
- `src/jobs/costiganChecklist.js` — `runCostiganChecklist()`, `isCostiganDoctor()`, `loadProcedurePacks()`, `extractChecklistJson()`. Reads inputs, calls the API, parses/validates, writes artifacts, records the event.
- `src/render/costiganMd.js` — `renderCostiganMd(data)` → markdown string (JS port of the agentic skill's Step-7 Python renderer).
- `tests/unit/singleCall-costigan.test.js`, `tests/unit/costiganMd.test.js`, `tests/unit/costigan-gate.test.js`.

**Modify**
- `src/llm/skill-io/singleCall.js` — add pure `buildSingleCallCostiganCdi(...)` + export it.
- `config/settings.js` — add `enableCostiganCdi: false` to `DEFAULT_SETTINGS`.
- `src/jobs/prechartApi.js` — in `onSuccess`, after the note write, call `runCostiganChecklist(...)`.
- `src/jobs/prechart.js` — same `onSuccess` hook for the CLI edit-note path (dev parity; the checklist itself still uses `ctx.api`).
- `main.js` — `spawnPrechartJob(...)` gains `chartText` + `doctor`; thread into `input.chartText` and `extra.doctor`.
- `src/ipc/prechart.js` — `START_PRECHART_JOB` handler accepts `chartText`, passes it + the resolved `doctor` to `spawnPrechartJob`.
- `preload.js` — `startPrechartJob(doctorId, caseDir, instructions, attachmentPaths, chartText)`.
- `renderer/views/prechartView.js` + `renderer/index.html` — add the Box-B chart textarea (shown only when `enableCostiganCdi`), pass its value through.
- The settings view (find via `grep -rn enableCdi renderer/`) — add an `enableCostiganCdi` checkbox mirroring the `enableCdi` toggle.
- `docs/plans/README.md`, `CLAUDE.md`, `docs/DECISIONS.md` — index line + skill-list/flow note + dated decision.

---

## Task 1: Settings flag `enableCostiganCdi`

**Files:**
- Modify: `config/settings.js:5-19` (`DEFAULT_SETTINGS`)
- Test: `tests/unit/config.test.js` (extend)

**Interfaces:**
- Produces: `DEFAULT_SETTINGS.enableCostiganCdi: boolean` (default `false`), independent of `enableCdi`/`enableIcd`.

- [ ] **Step 1: Write the failing test** — append to `tests/unit/config.test.js`:

```js
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULT_SETTINGS } = require('../../config/settings')

test('enableCostiganCdi defaults to false and is independent of enableCdi', () => {
  assert.equal(DEFAULT_SETTINGS.enableCostiganCdi, false)
  // No coupling: enabling Costigan CDI must NOT force enableIcd/enableCdi.
  const { createSettingsStore } = require('../../config/settings')
  // If the store exposes a normalize/applyInvariants seam, assert it here;
  // otherwise this default-presence check is sufficient for the unit.
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx node --test tests/unit/config.test.js`
Expected: FAIL — `enableCostiganCdi` is `undefined`.

- [ ] **Step 3: Add the field.** In `config/settings.js`, inside `DEFAULT_SETTINGS`, after `enablePatientSummary: false,`:

```js
  enablePatientSummary: false,
  enableCostiganCdi: false,   // opt-in interventional-pain procedure checklist (Costigan only)
```

Do **not** touch `applyInvariants` — there is no coupling to ICD/CDI.

- [ ] **Step 4: Run it, verify it passes**

Run: `npx node --test tests/unit/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/settings.js tests/unit/config.test.js
git commit -m "feat(settings): add enableCostiganCdi toggle (default off)"
```

---

## Task 2: `buildSingleCallCostiganCdi` message builder

**Files:**
- Modify: `src/llm/skill-io/singleCall.js` (add function + export)
- Test: `tests/unit/singleCall-costigan.test.js`

**Interfaces:**
- Consumes: `stripFrontmatter` (already in singleCall.js).
- Produces: `buildSingleCallCostiganCdi({ skillText, packsText, noteText, chartText, patientName, dateOfService, doctorName }) -> { system: string, user: string }`. **Pure** — no file I/O. `system` = stripped skill + a `# PROCEDURE RUBRIC PACKS` section containing `packsText`. `user` = injected facts + the SOAP note + the chart (or an explicit "not provided" sentinel).

- [ ] **Step 1: Write the failing test** — `tests/unit/singleCall-costigan.test.js`:

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSingleCallCostiganCdi } = require('../../src/llm/skill-io/singleCall')

const skillText = '---\nname: cdi-costigan-api\n---\nANALYTICAL FRAMEWORK BODY\n'
const packsText = '<!-- pack: esi -->\nESI PACK CONTENT'

test('system prompt = stripped skill + packs section', () => {
  const { system } = buildSingleCallCostiganCdi({
    skillText, packsText, noteText: 'NOTE', chartText: 'CHART',
    patientName: 'Jane Doe', dateOfService: '06/26/2026', doctorName: 'William Costigan',
  })
  assert.ok(system.startsWith('ANALYTICAL FRAMEWORK BODY'))      // frontmatter stripped
  assert.ok(system.includes('# PROCEDURE RUBRIC PACKS'))
  assert.ok(system.includes('ESI PACK CONTENT'))
})

test('user message carries facts, note, and chart', () => {
  const { user } = buildSingleCallCostiganCdi({
    skillText, packsText, noteText: 'THE NOTE BODY', chartText: 'THE CHART BODY',
    patientName: 'Jane Doe', dateOfService: '06/26/2026', doctorName: 'William Costigan',
  })
  assert.ok(user.includes('Patient: Jane Doe'))
  assert.ok(user.includes('Date of Service: 06/26/2026'))
  assert.ok(user.includes('THE NOTE BODY'))
  assert.ok(user.includes('THE CHART BODY'))
  assert.ok(/Output ONLY the checklist JSON/i.test(user))
})

test('absent chart yields an explicit sentinel, not empty', () => {
  const { user } = buildSingleCallCostiganCdi({
    skillText, packsText, noteText: 'NOTE', chartText: '',
    patientName: 'Jane Doe', dateOfService: '', doctorName: 'William Costigan',
  })
  assert.ok(/not provided/i.test(user))
  assert.ok(/SOAP note alone/i.test(user))
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx node --test tests/unit/singleCall-costigan.test.js`
Expected: FAIL — `buildSingleCallCostiganCdi is not a function`.

- [ ] **Step 3: Implement.** In `src/llm/skill-io/singleCall.js`, add before `module.exports`:

```js
/**
 * Build the system + user messages for the single-call Costigan procedure checklist.
 * Pure — the caller reads the skill, the 5 packs, the note, and the chart and passes text in.
 *
 * @param {object} opts
 * @param {string} opts.skillText       Raw contents of cdi-costigan-api/SKILL.md
 * @param {string} opts.packsText       The 5 procedure packs, concatenated (single source of truth)
 * @param {string} opts.noteText        Final SOAP note (HPI + A&P) — the auditable note
 * @param {string} [opts.chartText]     Pasted Epic chart (exam/imaging/prior procedures); may be empty
 * @param {string} [opts.patientName]
 * @param {string} [opts.dateOfService] MM/DD/YYYY (anchors rolling-12-month frequency math)
 * @param {string} [opts.doctorName]
 * @returns {{ system: string, user: string }}
 */
function buildSingleCallCostiganCdi({ skillText, packsText, noteText, chartText, patientName, dateOfService, doctorName }) {
  const system = stripFrontmatter(skillText)
    + '\n\n# PROCEDURE RUBRIC PACKS (reference — evaluate the record against these; do not invent criteria or codes beyond them)\n\n'
    + packsText

  const parts = [
    'Review the clinical record below against the procedure rubric packs in your instructions, and output the checklist JSON.',
    '',
    'INJECTED FACTS (authoritative — use exactly where given):',
    `- Patient: ${patientName || '(not provided)'}`,
    `- Date of Service: ${dateOfService || '(not provided — use the note, else leave empty)'}`,
    `- Doctor: ${doctorName || '(not provided)'}`,
    '',
    'SOAP NOTE (HPI + Assessment & Plan — the auditable note):',
    '---',
    noteText,
    '---',
  ]

  if (chartText && chartText.trim()) {
    parts.push(
      '',
      'EPIC CHART (physical exam, imaging, prior-procedure history — the rest of the auditable record):',
      '---', chartText, '---',
    )
  } else {
    parts.push(
      '',
      'EPIC CHART: (not provided — evaluate on the SOAP note alone; mark exam/imaging-dependent items "unclear", never "met").',
    )
  }

  parts.push('', 'Output ONLY the checklist JSON now — no prose, no code fences.')
  return { system, user: parts.join('\n') }
}
```

Then extend the exports line:

```js
module.exports = { buildSingleCallNoteGen, buildSingleCallNoteEdit, buildSingleCallCostiganCdi, splitNoteAndManifest, stripFrontmatter }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx node --test tests/unit/singleCall-costigan.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/llm/skill-io/singleCall.js tests/unit/singleCall-costigan.test.js
git commit -m "feat(llm): add buildSingleCallCostiganCdi message builder"
```

---

## Task 3: `renderCostiganMd` — JSON → Markdown renderer

**Files:**
- Create: `src/render/costiganMd.js`
- Test: `tests/unit/costiganMd.test.js`

**Interfaces:**
- Produces: `renderCostiganMd(data: object) -> string`. Deterministic; a JS port of the agentic skill's Step-7 Python renderer so the two never drift. Handles `parse_error` stub, the `no_procedure` case, per-procedure sections (verdict, intent/stage/site, denial-risk callout, checklist items with evidence + fix, coding, frequency), an optional `code_validation` summary, and a footer.

- [ ] **Step 1: Write the failing test** — `tests/unit/costiganMd.test.js`:

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { renderCostiganMd } = require('../../src/render/costiganMd')

const sample = {
  meta: { patient: 'Emilia Martinez', doctor: 'William Costigan', date_of_service: '06/18/2026', generated_at: '2026-06-26T00:00:00Z', standards_versions: { esi: 'procedures/esi v1 (2026-06-05)' } },
  summary: { procedures_in_play: 1, overall_status: 'needs_edits', audit_ready_count: 0, needs_edits_count: 1, likely_denied_count: 0, headline: 'Lumbar ESI requested; add prior-injection relief %.' },
  procedures_detected: [{
    id: 'proc-001', procedure: 'ESI', subtype: 'caudal ILESI lumbar', intent: 'requested', rung: 'repeat', site: 'L5 right',
    verdict: 'needs_edits', denial_reason: null,
    checklist: [
      { id: 'ESI-R1', criterion: '>=50% relief >=3mo on same scale', status: 'not_met', evidence_found: ['prior injection ... relief'], fix: 'Document the % relief and dates on the same scale.' },
      { id: 'ESI-1', criterion: 'Concordant diagnosis + imaging', status: 'met', evidence_found: ['stenosis at L4-L5'], fix: null },
    ],
    coding: { cpt_observed: [], icd_observed: [], icd_suggested: [{ code: 'M48.062', description: 'Lumbar stenosis with claudication', why: 'matches documented stenosis' }], coding_issues: [] },
    frequency: { cap: '4 ESI / region / 12mo', prior_dates: ['03/2026'], within_cap: true, note: null },
  }],
}

test('renders headline, verdict, checklist item status, and fix', () => {
  const md = renderCostiganMd(sample)
  assert.ok(md.includes('# Procedure Checklist — Emilia Martinez'))
  assert.ok(md.includes('Needs edits'))
  assert.ok(md.includes('ESI-R1'))
  assert.ok(md.includes('→ fix:'))
  assert.ok(md.includes('M48.062'))
})

test('no_procedure renders a clean skip message', () => {
  const md = renderCostiganMd({ meta: { patient: 'Balian' }, summary: { procedures_in_play: 0, overall_status: 'no_procedure' }, procedures_detected: [] })
  assert.ok(/No interventional procedure/i.test(md))
})

test('parse_error renders a stub', () => {
  const md = renderCostiganMd({ meta: { patient: 'X' }, parse_error: true, raw_output_path: '/tmp/x.raw.txt' })
  assert.ok(/could not be produced/i.test(md))
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx node --test tests/unit/costiganMd.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/render/costiganMd.js`** (faithful port of the agentic skill's Step-7 Python):

```js
'use strict'

const VERDICT = {
  audit_ready:   ['🟢', 'Audit-ready'],
  needs_edits:   ['🟡', 'Needs edits'],
  likely_denied: ['🔴', 'Likely denied'],
  unknown:       ['⚪', 'Unknown'],
  no_procedure:  ['⚪', 'No procedure'],
}
const STATUS = { met: ['✅', 'Met'], not_met: ['❌', 'Not met'], unclear: ['⚠️', 'Unclear'] }

function vlabel(v) {
  const [e, l] = VERDICT[v] || ['⚪', ((v || '—')[0] || '').toUpperCase() + (v || '—').slice(1)]
  return `${e} ${l}`
}

function renderProc(p) {
  const out = []
  const name = p.procedure || ''
  const title = name + (p.subtype ? ` — ${p.subtype}` : '')
  out.push(`## ${vlabel(p.verdict || '')} · ${title}`, '')
  const bits = []
  if (p.intent) bits.push(`**Intent:** ${p.intent}`)
  if (p.rung)   bits.push(`**Stage:** ${p.rung}`)
  if (p.site)   bits.push(`**Site:** ${p.site}`)
  if (bits.length) out.push(bits.join('  ·  '), '')
  if (p.verdict === 'likely_denied' && p.denial_reason) out.push(`> 🔴  **Denial risk:** ${p.denial_reason}`, '')

  const checklist = p.checklist || []
  if (checklist.length) {
    out.push('### Medical-necessity checklist', '')
    for (const item of checklist) {
      const [se, sl] = STATUS[item.status] || ['•', item.status || '']
      const cid = item.id ? `[${item.id}] ` : ''
      out.push(`- ${se} **${sl}** · ${cid}${item.criterion || ''}`)
      for (const ev of (item.evidence_found || [])) out.push(`    - *evidence:* ${ev}`)
      if (item.fix) out.push(`    - **→ fix:** ${item.fix}`)
    }
    out.push('')
  }

  const c = p.coding || {}
  const cpt = c.cpt_observed || [], icdObs = c.icd_observed || [], icdSug = c.icd_suggested || [], issues = c.coding_issues || []
  if (cpt.length || icdObs.length || icdSug.length || issues.length) {
    out.push('### Coding', '')
    if (cpt.length)    out.push('**CPT in note:** ' + cpt.map(x => `\`${x}\``).join(', ') + '  ')
    if (icdObs.length) out.push('**ICD-10 in note:** ' + icdObs.map(x => `\`${x}\``).join(', ') + '  ')
    if (icdSug.length) { out.push('**Suggested ICD-10:**'); for (const s of icdSug) out.push(`- \`${s.code || ''}\` — ${s.description || ''}` + (s.why ? ` · ${s.why}` : '')) }
    if (issues.length) { out.push('**Coding issues:**'); for (const it of issues) out.push(`- ${it}`) }
    out.push('')
  }

  const f = p.frequency || {}
  if (f.cap || (f.prior_dates && f.prior_dates.length)) {
    out.push('### Frequency', '')
    if (f.cap) out.push(`**Cap:** ${f.cap}  `)
    const priors = f.prior_dates || []
    if (priors.length) out.push(`**Prior same-family procedures (${priors.length}):** ${priors.join(', ')}  `)
    if (f.within_cap !== undefined && f.within_cap !== null) {
      const label = f.within_cap === true ? 'yes' : f.within_cap === false ? 'no' : String(f.within_cap)
      out.push(`**Within cap:** ${label}  `)
    }
    if (f.note) out.push(`*${f.note}*  `)
    out.push('')
  }

  out.push('---', '')
  return out
}

function renderCostiganMd(data) {
  data = data || {}
  const meta = data.meta || {}, summary = data.summary || {}, procs = data.procedures_detected || []
  const lines = [`# Procedure Checklist — ${meta.patient || ''}`, '']
  if (meta.doctor) lines.push(`**Provider:** ${meta.doctor}  `)
  if (meta.date_of_service) lines.push(`**Date of service:** ${meta.date_of_service}  `)
  lines.push(`**Generated:** ${meta.generated_at || ''}`, '')

  if (data.parse_error) {
    lines.push(`> ⚠️  **Checklist could not be produced.** Raw output: \`${data.raw_output_path || ''}\``, '')
    return lines.join('\n')
  }

  const overall = summary.overall_status || 'no_procedure'
  lines.push(`## ${vlabel(overall)} — overall`, '')
  if (summary.headline) lines.push(`**${summary.headline}**`, '')

  const n = summary.procedures_in_play || 0
  if (n === 0) {
    lines.push('No interventional procedure was performed or requested in this note, so no procedure checklist applies.', '')
    return lines.join('\n')
  }

  const parts = []
  for (const key of ['audit_ready', 'needs_edits', 'likely_denied']) {
    const cnt = summary[`${key}_count`] || 0
    if (cnt) parts.push(`${cnt} ${VERDICT[key][1].toLowerCase()}`)
  }
  lines.push(`${n} procedure${n !== 1 ? 's' : ''} in play: ${parts.length ? parts.join(', ') : '—'}.`, '', '---', '')
  for (const p of procs) lines.push(...renderProc(p))

  const cv = data.code_validation
  if (cv && typeof cv === 'object') {
    lines.push('## Code validation summary', '')
    const inNote = cv.codes_in_note || [], supported = cv.supported || [], flagged = cv.flagged || []
    if (inNote.length)    lines.push(`**Codes in note (${inNote.length}):** ` + inNote.map(x => `\`${x}\``).join(', '), '')
    if (supported.length) lines.push(`**Supported (${supported.length}):** ` + supported.map(x => `\`${x}\``).join(', '), '')
    if (flagged.length) { lines.push(`**Flagged (${flagged.length}):**`); for (const e of flagged) lines.push(`- \`${e.code || ''}\` — ${e.issue || ''}${e.linked_proc_id ? ` (see ${e.linked_proc_id})` : ''}`) }
    lines.push('', '---', '')
  }

  const versions = meta.standards_versions || {}
  const vstr = Object.keys(versions).length ? Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(' · ') : '—'
  lines.push(`*Generated ${meta.generated_at || ''} · Rubrics: ${vstr}*`, '')
  return lines.join('\n')
}

module.exports = { renderCostiganMd }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx node --test tests/unit/costiganMd.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/render/costiganMd.js tests/unit/costiganMd.test.js
git commit -m "feat(render): add renderCostiganMd (json -> markdown)"
```

---

## Task 4: The `cdi-costigan-api` skill

**Files:**
- Create: `notes-claude/skills/cdi-costigan-api/SKILL.md`

**Interfaces:**
- Produces: a system-prompt skill whose entire output is the checklist JSON (the schema below). No tools, no file I/O, no manifest line. Reads the clinical record from the user message and the packs from its own (appended) system prompt.

This is a **rewrite** of `notes-claude/skills/cdi-costigan/SKILL.md` for the no-tools single-call API. **Keep** the analytical core (detection discipline, two-pass evaluation, item statuses + verbatim evidence + fix, verdict guidance, the JSON schema, behavior rules). **Remove** every tool/agentic step: the permission pre-flight, `Case:`/`Standards:` parsing, output-path resolution, "Use the Read tool", "Read the pack from disk", the MCP-connector validation (Step 4d), the bash JSON-validation, the Python MD render, and the manifest line. **Replace** connector validation with reliance on the packs' covered-code lists.

- [ ] **Step 1: Create the directory and file.**

```bash
mkdir -p notes-claude/skills/cdi-costigan-api
```

- [ ] **Step 2: Write `notes-claude/skills/cdi-costigan-api/SKILL.md`** with exactly this content:

````markdown
---
name: cdi-costigan-api
description: >
  Single-call API variant of cdi-costigan. Check a finalized interventional-pain clinical record against per-procedure Medicare medical-necessity checklists (Cedars CRI / LCD-derived) and return a structured procedure-checklist JSON. The app placed the clinical record in the user message and the rubric packs in this system prompt; there are NO tools.
---

# Costigan Procedure Checklist (API) — Interventional-Pain Medical-Necessity Review

You are a senior Compliance & Revenue Integrity (CRI) analyst specialized in **interventional pain medical necessity**. The app calls you ONCE via the Anthropic Messages API. You have **NO tools** — no file access, no shell, no ICD connector. Everything you need is in this conversation.

- **This SYSTEM prompt** contains, below, the **PROCEDURE RUBRIC PACKS** (ESI, facet, TPI, SI, PVA): detection cues, checklists with stable item IDs, thresholds, **covered ICD-10 lists**, CPT/modifier rules, frequency caps, exclusions, and verdict guidance. The covered-code lists were validated against the ICD-10 database when the packs were authored — treat them as ground truth.
- **The USER message** contains the **CLINICAL RECORD**: INJECTED FACTS (patient, date of service, doctor), the **SOAP NOTE** (HPI + A&P — the auditable note), and the **EPIC CHART** (physical exam, imaging, prior-procedure history). The chart may be absent.

Your entire response is **ONE JSON object** — the checklist verdict (schema below). No prose, no code fences, no manifest. Do not ask questions; this runs unattended. When a reading is ambiguous, pick the best-supported one and proceed.

You do **not** assign final codes, rewrite the note, or bill. You check the documentation item-by-item against the matching checklist so it survives a Medicare audit (the practice was hit by a TPE audit on transforaminal epidurals — this is the defense).

## Step 1 — Detect which procedure(s) are in play

Identify **every** interventional procedure **performed or requested/recommended** across the note + chart. These are usually Workers'-Comp consults that *request authorization* for a future injection — **a recommendation/request counts as in-play**.

| Procedure | Pack | Cue keywords (non-exhaustive) |
|---|---|---|
| ESI | esi | epidural steroid injection, ESI, LESI, CESI, ILESI, transforaminal, TFESI |
| Facet | facet | facet block/injection, medial branch block, MBB, RFA, denervation, rhizotomy, facet cyst |
| TPI | tpi | trigger point injection, TPI |
| SI | si | sacroiliac/SI joint injection, SIJI, lateral branch block (SI) |
| PVA | pva | vertebroplasty, kyphoplasty, vertebral augmentation, PVA, PVP, PKP, cement augmentation |

**Detection discipline (avoid false positives):**
- A *historical* mention is not "in play" (e.g. prior LESIs listed in surgical history while this visit recommends only PT → ESI not in play). Distinguish prior-procedure history (longitudinal evidence for a repeat check) from the procedure being performed/requested now.
- A surgical *fusion* (e.g. SI fusion) is not an SI *injection*; a *laminectomy* is not an ESI.
- A bare diagnosis ("facet arthropathy") with no facet procedure performed/requested does not put facet in play.

**If NO procedure is in play:** that is a clean skip. Emit the JSON with `procedures_detected: []` and `summary.overall_status: "no_procedure"`. Do not invent a procedure.

Record per procedure: family, **intent** (`performed`|`requested`), **rung** (ESI initial/repeat; facet diagnostic/therapeutic/RFA/cyst; SI diagnostic/therapeutic; TPI initial/repeat; PVA one-time), and the level/region/laterality.

## Step 2 — Evaluate each procedure against its pack

**Pass 1 — gather evidence** across note + chart: the named pain scale + value(s) and whether the **same scale** appears at >1 timepoint; functional/disability index (ODI/RDQ/Oswestry); provocative exam findings (for SI, count the named six: FABER, Gaenslen, Thigh-Thrust/Posterior-Shear, SI-Compression, SI-Distraction, Yeoman); imaging findings + concordance with the symptomatic level/side; conservative care (what, how long, outcome); prior-procedure history with **dates** and any **relief %**; image guidance/contrast + films; diagnoses + any ICD codes.

**Pass 2 — evaluate each checklist item** in the matching pack (indication items, rung-specific items, documentation rules). Assign exactly one status, with evidence/fix:
- **`met`** — clearly satisfied; provide ≥1 **verbatim** evidence quote from the record.
- **`not_met`** — required and not satisfied; provide the **specific fix** (what to document); quote any contrary evidence.
- **`unclear`** — partial/ambiguous (e.g. a scale value present but not clearly the same scale across timepoints); state what's present and what would upgrade it.

**Exam/imaging guardrail (critical):** the physician's exam is entered into Epic dropdowns, not dictated. If the EPIC CHART is absent or does not contain the structured finding an item needs (e.g. SI's ≥3 named provocative tests, trigger-point palpation, motor/sensory/reflex), mark that item **`unclear`** with a fix like *"confirm in the Epic exam (not present in the supplied record)"* — **never `met`**. Do not assume a normal exam you cannot see.

**Coding-correctness checks — NO connector; use ONLY the packs:**
1. **ICD ↔ procedure.** For closed-list packs (facet/TPI/SI/PVA), a documented Dx must be a member of the pack's covered list; suggest only codes that appear there. For ESI (no closed list), check the Dx against the narrative covered indication and suggest only the representative codes listed in `esi.md`.
2. **Never invent** a code or suggest a more-specific child that is not in the pack. **Header-only codes are non-billable** — never suggest `M47.81`, `M47.89`, `M48.1`, `M53.8`, `G44.20`, `G44.21`, `G44.22`, `M79.1`, `M51.36` (resolve to the listed billable member or omit).
3. **CPT/level/laterality:** level limits (TFESI ≤2, CESI/ILESI ≤1; facet ≤2 levels/region; etc.), −50 for bilateral where required.
4. **KX modifier** on diagnostic facet/SI lines — flag a diagnostic block documented without KX intent (its omission silently erodes the therapeutic cap).
5. **Frequency cap:** count prior same-family procedures within the trailing 12 months of the date of service; flag if over the pack's cap. If prior dates lack region and the cap is per-region, note the ambiguity rather than asserting a violation.

**Per-procedure verdict** (per the pack's Verdict guidance):
- **`audit_ready`** — all load-bearing criteria met; within caps; covered Dx; modifiers correct.
- **`needs_edits`** — covered indication, fixable gaps (the common case: baseline scale but no same-scale follow-up; relief % without dates; conservative care without duration; KX not evident).
- **`likely_denied`** — a load-bearing criterion fails (non-covered indication / exclusion present / repeat without prior relief / over cap / no image guidance where required / wrong procedure for the documented pathology). Set a short `denial_reason`.

## Output — the JSON (your entire response)

Output exactly this shape — no extra/missing top-level fields, no prose, no code fences:

```json
{
  "meta": { "case_dir": "", "patient": "", "doctor": "", "date_of_service": "", "generated_at": "", "standards_versions": { "esi": "" } },
  "summary": { "procedures_in_play": 0, "overall_status": "audit_ready|needs_edits|likely_denied|no_procedure", "audit_ready_count": 0, "needs_edits_count": 0, "likely_denied_count": 0, "headline": "" },
  "procedures_detected": [
    {
      "id": "proc-001", "procedure": "ESI|Facet|TPI|SI|PVA", "subtype": "", "intent": "performed|requested",
      "rung": "initial|repeat|diagnostic|therapeutic|RFA|cyst|one-time|null", "site": "", "verdict": "audit_ready|needs_edits|likely_denied|unknown", "denial_reason": null,
      "checklist": [ { "id": "ESI-2", "criterion": "", "status": "met|not_met|unclear", "evidence_found": [""], "fix": null } ],
      "coding": { "cpt_observed": [], "icd_observed": [], "icd_suggested": [ { "code": "", "description": "", "why": "" } ], "coding_issues": [] },
      "frequency": { "cap": "", "prior_dates": [], "within_cap": "true|false|unclear", "note": null }
    }
  ],
  "code_validation": { "codes_in_note": [], "supported": [], "flagged": [ { "code": "", "issue": "", "linked_proc_id": null } ] }
}
```

**Field constraints:**
- `procedure` ∈ {ESI, Facet, TPI, SI, PVA}; `status` ∈ {met, not_met, unclear}; `verdict` ∈ {audit_ready, needs_edits, likely_denied, unknown}.
- `overall_status` is the **worst** verdict across procedures (`likely_denied` > `needs_edits` > `audit_ready`); `no_procedure` only when `procedures_detected` is empty.
- `evidence_found`: 0–4 verbatim fragments. `fix`: required string when `not_met`/`unclear`; `null` when `met`.
- Suggest only codes that appear in the relevant pack's covered list. Never emit a header-only code.
- `code_validation` is **optional** — include it ONLY when ICD codes were present in the note; omit it entirely otherwise.
- `headline` — one plain sentence the clinician reads first (bottom line + the single most important action). `meta.generated_at` may be left `""` (the app stamps the real time).

**Behavior rules:**
- Quote evidence **verbatim** — defensibility comes from quotes, not paraphrase. Mirror the pack's wording in `criterion` so the report maps 1:1 to what the auditor checks.
- Surface the high-value gap for repeats: *prior dates documented but no relief % / no same-scale follow-up* — call it out with the fix.
- Be specific in `fix` ("document the ≥4-week duration and outcome of the PT/NSAID trial", not "document conservative care").
- Don't manufacture findings — indeterminable → `unclear`, not `not_met`. One procedure = one entry.
- Output ONLY the JSON object. Nothing before or after it.
````

- [ ] **Step 3: Structure verification (no runtime test for a prompt).** Confirm by reading the file: (a) no `bash`, `Read`, `Write`, connector, or manifest references remain; (b) the output contract says "ONLY the JSON object"; (c) the exam/imaging guardrail bullet is present; (d) the JSON schema matches the agentic skill's Step-4f schema (so `renderCostiganMd` and downstream parse identically).

Run: `grep -nE "Read tool|connector|mcp__|manifest|bash|Write the JSON" notes-claude/skills/cdi-costigan-api/SKILL.md`
Expected: no matches (empty output).

- [ ] **Step 4: Commit**

```bash
git add notes-claude/skills/cdi-costigan-api/SKILL.md
git commit -m "feat(skill): add cdi-costigan-api (single-call, no-connector port)"
```

---

## Task 5: `costiganChecklist.js` — gate + orchestration

**Files:**
- Create: `src/jobs/costiganChecklist.js`
- Test: `tests/unit/costigan-gate.test.js`

**Interfaces:**
- Consumes: `buildSingleCallCostiganCdi` (Task 2), `renderCostiganMd` (Task 3), `ctx.api.runSingleCall` (Anthropic provider), `ctx.config.get()`, `ctx.platform.hideInternal`, `db/events.js` `startEvent`/`finishEvent`, `src/llm/pricing.js` `normalizeApiUsage`.
- Produces:
  - `isCostiganDoctor(doctor) -> boolean` — true when the doctor's lastname is "costigan".
  - `loadProcedurePacks() -> string` — reads the 5 packs from `notes-claude/standards/procedures/` and concatenates.
  - `extractChecklistJson(text) -> object|null` — defensive JSON extraction (handles accidental fences / leading prose).
  - `runCostiganChecklist({ caseDir, doctor, chartText, caseId, ctx }) -> Promise<void>` — gated; reads the final note, calls the API, parses (1 retry), writes `_costigan.json` + `_costigan.md` + `_chart_input.md`, records one `processing_events` row. Always resolves (never throws into the caller).

- [ ] **Step 1: Write the failing test** — `tests/unit/costigan-gate.test.js`:

```js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isCostiganDoctor, extractChecklistJson } = require('../../src/jobs/costiganChecklist')

test('isCostiganDoctor matches by lastname, case-insensitive', () => {
  assert.equal(isCostiganDoctor({ lastname: 'Costigan' }), true)
  assert.equal(isCostiganDoctor({ name: 'William M. Costigan, M.D.' }), true)
  assert.equal(isCostiganDoctor({ name: 'Dr. Sabbag' }), false)
  assert.equal(isCostiganDoctor(null), false)
})

test('extractChecklistJson tolerates code fences and leading prose', () => {
  assert.deepEqual(extractChecklistJson('```json\n{"summary":{"overall_status":"no_procedure"}}\n```'), { summary: { overall_status: 'no_procedure' } })
  assert.deepEqual(extractChecklistJson('Here is the result:\n{"a":1}'), { a: 1 })
  assert.equal(extractChecklistJson('not json at all'), null)
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx node --test tests/unit/costigan-gate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/jobs/costiganChecklist.js`:**

```js
'use strict'

const fs   = require('fs')
const path = require('path')
const { buildSingleCallCostiganCdi } = require('../llm/skill-io/singleCall')
const { renderCostiganMd }           = require('../render/costiganMd')
const { normalizeApiUsage }          = require('../llm/pricing')

const SKILL_PATH     = path.join(__dirname, '../../notes-claude/skills/cdi-costigan-api/SKILL.md')
const PROCEDURES_DIR = path.join(__dirname, '../../notes-claude/standards/procedures')
const PACK_FILES     = ['esi', 'facet', 'tpi', 'si', 'pva']   // README is policy, not a rubric
const MODEL          = 'claude-sonnet-4-6'

function isCostiganDoctor(doctor) {
  if (!doctor) return false
  const ln = (doctor.lastname || '').toLowerCase()
  if (ln) return ln === 'costigan'
  return /\bcostigan\b/i.test(doctor.name || '')
}

function loadProcedurePacks() {
  return PACK_FILES.map(name => {
    const p = path.join(PROCEDURES_DIR, `${name}.md`)
    return `<!-- pack: ${name} -->\n` + fs.readFileSync(p, 'utf8')
  }).join('\n\n---\n\n')
}

/** Extract the JSON object from model text (handles ```json fences and leading prose). */
function extractChecklistJson(text) {
  if (!text) return null
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(t) } catch {}
  const start = t.indexOf('{'); const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)) } catch {} }
  return null
}

function findFinalNote(caseDir) {
  try {
    const f = fs.readdirSync(caseDir).find(x => x.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(x))
    return f ? path.join(caseDir, f) : null
  } catch { return null }
}

function parseHeaderFacts(noteText, caseDir) {
  const head = (noteText || '').slice(0, 4096)
  const dos = (head.match(/\*\*Date:\*\*\s*([^\n\r]+)/) || head.match(/Date of Service:\s*([^\n\r]+)/) || [])[1] || ''
  const patient = path.basename(caseDir).replace(/_\d{4}-\d{2}-\d{2}.*$/, '').replace(/_/g, ' ')
  return { dateOfService: dos.trim(), patientName: patient }
}

/**
 * Run the Costigan procedure checklist for a case (gated). Always resolves.
 * @param {{ caseDir:string, doctor:object, chartText?:string, caseId?:(string|number), ctx:object }} args
 */
async function runCostiganChecklist({ caseDir, doctor, chartText, caseId, ctx }) {
  const { log } = ctx
  const tag = '[costigan]'
  try {
    if (!ctx.config.get().enableCostiganCdi) { log(`${tag} disabled — skip`); return }
    if (!isCostiganDoctor(doctor))           { log(`${tag} not Dr. Costigan — skip`); return }

    const notePath = findFinalNote(caseDir)
    if (!notePath) { log(`${tag} no soap note in ${caseDir} — skip`); return }
    const noteText  = fs.readFileSync(notePath, 'utf8')
    const skillText = fs.readFileSync(SKILL_PATH, 'utf8')
    const packsText = loadProcedurePacks()
    const { dateOfService, patientName } = parseHeaderFacts(noteText, caseDir)
    const stem = path.basename(notePath, '_soap_note.md')

    // Persist the raw chart input so it isn't lost (it lives only as pasted text).
    if (chartText && chartText.trim()) {
      try { fs.writeFileSync(path.join(caseDir, `${stem}_chart_input.md`), chartText, 'utf8') } catch (e) { log(`${tag} chart save failed: ${e.message}`) }
    }

    const { system, user } = buildSingleCallCostiganCdi({
      skillText, packsText, noteText, chartText,
      patientName, dateOfService, doctorName: doctor?.name || 'William M. Costigan, M.D.',
    })

    const startedAt = new Date().toISOString()
    let eventId = null
    try { eventId = require('../../db/events').startEvent({ caseId: caseId || null, jobKind: 'costigan', relatedDoctorId: doctor?.id || null, modelUsed: MODEL, effort: 'high', startedAt }) } catch (e) { log(`${tag} startEvent: ${e.message}`) }

    const finish = (status, usage, errMsg) => {
      try { require('../../db/events').finishEvent(eventId, { status, errorMessage: errMsg || null, finishedAt: new Date().toISOString(), ...(usage || {}) }) } catch {}
    }

    let result = await ctx.api.runSingleCall({ system, user, model: MODEL, tag, label: 'cdi-costigan:api' })
    if (!result.ok) { log(`${tag} API failed: ${result.errText}`); finish('failed', normalizeApiUsage({ model: MODEL, rawUsage: result.rawUsage, durationMs: result.durationMs }), result.errText); return }

    let data = extractChecklistJson(result.text)
    if (!data && result.stopReason !== 'max_tokens') {
      // One retry with a stricter nudge.
      log(`${tag} JSON parse failed — retrying once`)
      result = await ctx.api.runSingleCall({ system, user: user + '\n\nReturn ONLY a single valid JSON object. No prose, no code fences.', model: MODEL, tag, label: 'cdi-costigan:api:retry' })
      data = result.ok ? extractChecklistJson(result.text) : null
    }

    const jsonPath = path.join(caseDir, `${stem}_costigan.json`)
    const mdPath   = path.join(caseDir, `${stem}_costigan.md`)
    if (!data) {
      const rawPath = path.join(caseDir, `${stem}_costigan.raw.txt`)
      try { fs.writeFileSync(rawPath, result.text || '', 'utf8') } catch {}
      data = { meta: { patient: patientName, case_dir: caseDir, generated_at: startedAt }, parse_error: true, raw_output_path: rawPath }
    }

    // Stamp the real generated_at + case_dir (the model leaves them blank).
    data.meta = data.meta || {}
    data.meta.generated_at = data.meta.generated_at || startedAt
    data.meta.case_dir = caseDir

    try { fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8') } catch (e) { log(`${tag} json write failed: ${e.message}`) }
    try { fs.writeFileSync(mdPath, renderCostiganMd(data), 'utf8') } catch (e) { log(`${tag} md write failed: ${e.message}`) }

    // Hide artifacts on Windows (no-op on macOS).
    try { for (const p of [jsonPath, mdPath]) ctx.platform?.hideInternal?.(p) } catch {}

    finish(data.parse_error ? 'failed' : 'success', normalizeApiUsage({ model: MODEL, rawUsage: result.rawUsage, durationMs: result.durationMs }), data.parse_error ? 'JSON parse failed after retry' : null)
    log(`${tag} done: ${data.summary?.overall_status || (data.parse_error ? 'parse_error' : '?')} -> ${jsonPath}`)
  } catch (e) {
    log(`${tag} unexpected error: ${e.message}`)
  }
}

module.exports = { runCostiganChecklist, isCostiganDoctor, loadProcedurePacks, extractChecklistJson }
```

> Note: confirm `src/llm/pricing.js` exports `normalizeApiUsage` (it's used by `prechartApi.js`). If `finishEvent`'s usage keys differ, map `normalizeApiUsage`'s output to `{ inputTokens, outputTokens, costUsd, durationMs }` as `prechartApi.js` does via the dispatcher.

- [ ] **Step 4: Run it, verify it passes**

Run: `npx node --test tests/unit/costigan-gate.test.js`
Expected: PASS (2/2). (The pure helpers are tested; `runCostiganChecklist` is exercised end-to-end in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/costiganChecklist.js tests/unit/costigan-gate.test.js
git commit -m "feat(costigan): add checklist orchestration (gate, packs, parse, persist)"
```

---

## Task 6: Wire chartText + doctor through the pre-chart flow

**Files:**
- Modify: `preload.js:56`
- Modify: `src/ipc/prechart.js:57-91` (START_PRECHART_JOB handler)
- Modify: `main.js` `spawnPrechartJob` (≈945-970)
- Modify: `src/jobs/prechartApi.js` `onSuccess` (≈167-211)
- Modify: `src/jobs/prechart.js` `onSuccess` (CLI parity)

**Interfaces:**
- Consumes: `runCostiganChecklist` (Task 5).
- Produces: `input.chartText` and `extra.doctor` available in both prechart descriptors' `onSuccess`; the renderer can pass a 5th `chartText` arg to `startPrechartJob`.

- [ ] **Step 1: preload.** Change `preload.js:56`:

```js
  startPrechartJob:         (doctorId, caseDir, instructions, attachmentPaths, chartText) => ipcRenderer.invoke('start-prechart-job', doctorId, caseDir, instructions, attachmentPaths, chartText),
```

- [ ] **Step 2: IPC handler.** In `src/ipc/prechart.js`, change the handler signature and the `spawnPrechartJob` call:

```js
ipcMain.handle(CHANNELS.START_PRECHART_JOB, async (_, doctorId, caseDir, instructions, attachmentPaths, chartText) => {
  // ... unchanged validation; `doctor` is already resolved by id above ...
  spawnPrechartJob(caseDir, templatePath, trimmedInstructions, combined, (chartText || '').trim(), doctor)
  return { ok: true }
})
```

(The handler already computes `const doctor = allDocs.find(d => d.id === doctorId)` — pass it through.)

- [ ] **Step 3: spawnPrechartJob.** In `main.js`, extend the signature + thread the new values:

```js
function spawnPrechartJob(caseDir, templatePath, instructions, combinedAttachmentPath, chartText, doctor) {
  // ... existing patientLabel / caseId resolution ...
  const input = {
    caseDir:        caseDir.replace(/\\/g, '/'),
    templatePath:   templatePath.replace(/\\/g, '/'),
    attachmentPath: (combinedAttachmentPath || '').replace(/\\/g, '/'),
    instructions:   (instructions || '').replace(/\r?\n/g, ' '),
    chartText:      chartText || '',
  }
  // ... resolveOption / descriptor selection unchanged ...
  runJob(descriptor, input, ctx, {
    patientLabel,
    caseId: prechartCaseId,
    combinedAttachmentPath,
    doctor: doctor || null,
    runEngine, icdEngine,
    spawnDocxConversionFn: (md, tag, folder, cid) => spawnDocxConversion(md, tag, folder, cid),
    findExistingSoapNoteFn: findExistingSoapNote,
  })
}
```

- [ ] **Step 4: prechartApi.onSuccess.** In `src/jobs/prechartApi.js`, require the runner at top:

```js
const { runCostiganChecklist } = require('./costiganChecklist')
```

Then inside `onSuccess`, after the ICD/docx block and before the job-status save, add:

```js
    // Costigan procedure checklist (opt-in, Costigan-only) — single API call on the final note + pasted chart.
    if (ctx.config.get().enableCostiganCdi && extra.doctor) {
      runCostiganChecklist({ caseDir, doctor: extra.doctor, chartText: input.chartText, caseId, ctx })
        .catch(e => log(`[costigan] run error: ${e.message}`))
    }
```

(`runCostiganChecklist` self-gates on the doctor too, so this is safe even if `extra.doctor` is a non-Costigan.)

- [ ] **Step 5: prechart.js (CLI path) parity.** In `src/jobs/prechart.js` `onSuccess`, add the identical block (same `require` + call). The checklist always uses `ctx.api`, so it works regardless of which edit-note provider ran.

- [ ] **Step 6: Verify wiring compiles + existing tests pass.**

Run: `npm test`
Expected: PASS (no regressions; IPC handler count unchanged — `chartText` is a new arg on the existing `start-prechart-job` channel, not a new channel, so `tests/unit/shared-drift.test.js` is unaffected).

- [ ] **Step 7: Commit**

```bash
git add preload.js src/ipc/prechart.js main.js src/jobs/prechartApi.js src/jobs/prechart.js
git commit -m "feat(prechart): thread chart input + doctor; run Costigan checklist on success"
```

---

## Task 7: UI — Box-B chart textarea + settings toggle

**Files:**
- Modify: `renderer/index.html` (prechart-view block, ≈374-402)
- Modify: `renderer/views/prechartView.js` (mount + submit + refresh)
- Modify: the settings view (find via `grep -rn "enableCdi" renderer/`)

**Interfaces:**
- Consumes: `enableCostiganCdi` from settings; passes `chartText` as the 5th arg to `ipc.startPrechartJob`.

- [ ] **Step 1: HTML.** In `renderer/index.html`, inside `#prechart-view`, after the attachments block and before the Start button, add a chart row (hidden by default):

```html
    <div id="prechart-chart-row" class="hidden">
      <label class="setting-label">Chart for checklist <span class="setting-hint">(Costigan)</span></label>
      <textarea id="prechart-chart"
                placeholder="Paste the Epic chart used for the procedure checklist: physical exam, imaging/radiology reports, prior injections/procedures with dates & relief, conservative-care history…"
                rows="6" spellcheck="false"></textarea>
      <div class="setting-hint">Used only for the procedure checklist — not added to the note.</div>
    </div>
```

- [ ] **Step 2: prechartView.js.** Capture the element in `mount()`, show it when the setting is on, read it on submit, and clear it on refresh.

In the element-capture block of `mount()`:
```js
    prechartChartRow = root.querySelector('#prechart-chart-row')
    prechartChart    = root.querySelector('#prechart-chart')
```

In `refreshPrechartTab()` (where doctors/cases load), toggle visibility from settings:
```js
    try {
      const s = await ipc.getSettings()
      if (prechartChartRow) prechartChartRow.classList.toggle('hidden', !s.enableCostiganCdi)
    } catch {}
    if (prechartChart) prechartChart.value = ''
```

In the Start handler, pass the chart text:
```js
    const chartText = prechartChart ? prechartChart.value : ''
    const res = await ipc.startPrechartJob(doctorId, caseDir, instructions, prechartFiles, chartText)
```

(Declare `let prechartChartRow, prechartChart` with the other module-scope element vars at the top of the file.)

- [ ] **Step 3: Settings toggle.** Find the existing `enableCdi` checkbox: `grep -rn "enableCdi" renderer/`. In the same settings view, add an `enableCostiganCdi` checkbox that mirrors it exactly (same load-from-`getSettings`, same write-on-change-via-`saveSettings` pattern), labeled e.g. "Costigan procedure checklist (interventional pain)". It is independent — do **not** couple it to `enableCdi`/`enableIcd`.

- [ ] **Step 4: Manual verification.**

Run: `npm start`
Verify:
1. With `enableCostiganCdi` OFF → the Pre-chart tab shows no chart box (current behavior).
2. Toggle it ON in Settings → reopen Pre-chart → the chart textarea appears.
3. The Start button still enables on instructions OR files (the chart box is optional and does not affect that rule).

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/views/prechartView.js renderer/views/*settings*
git commit -m "feat(ui): add Costigan chart input (gated) + settings toggle"
```

---

## Task 8: End-to-end verification + docs

**Files:**
- Modify: `docs/plans/README.md`, `CLAUDE.md`, `docs/DECISIONS.md`

- [ ] **Step 1: Real API smoke test on sample cases.** With `ANTHROPIC_API_KEY` set (ask rish for a fresh key), exercise the path on a few known cases from `/Users/rish/Development/PA/Doctor details/Dr. Costigan/Dr. Costigan Audio and Reports/` (these `.docx` carry the gold HPI+A&P). Use a throwaway Node script (or extend `/Users/rish/Development/PA/Temp/costigan_twopass_test.py`) that: reads `cdi-costigan-api/SKILL.md` + the 5 packs as the system, builds the user message from a gold note (chart empty for v1), calls the API, and asserts:
  - **martinez_emilia** → `procedures_in_play ≥ 1`, an ESI detected, `overall_status` ∈ {needs_edits, likely_denied}; the ESI-R1 (prior-relief %) item is `not_met`/`unclear` with a fix.
  - a **facet** case → facet detected, FACET-3 (untreated radiculopathy) reasoning present.
  - **balian** (or any no-injection visit) → `overall_status: "no_procedure"`, `procedures_detected: []`.
  - Every run: `extractChecklistJson` returns non-null, `renderCostiganMd(data)` produces a non-empty markdown with the verdict header. `stop_reason` ≠ `max_tokens` (bump `maxTokens` if any case truncates).

Expected: detection + verdicts sane on the necessity axis; exam-axis items `unclear` (no chart) — never falsely `met`.

- [ ] **Step 2: In-app dry run.** `npm start`, enable the setting, pick a real Costigan case, paste a sample chart into Box B + handwritten into Box A, run Pre-chart. Confirm the case folder gains `<stem>_costigan.json`, `<stem>_costigan.md`, `<stem>_chart_input.md`, and that `_costigan.md` opens cleanly. Confirm one `processing_events` row with `job_kind='costigan'` (and that the edit-note note + docx are unaffected).

- [ ] **Step 3: Docs.**
  - `docs/plans/README.md`: add a row linking this plan (mirror the existing rows; status "In progress / implementing").
  - `CLAUDE.md`: add `cdi-costigan-api` to the skills Quick-reference list, and a one-paragraph note under the Pre-chart section that when `enableCostiganCdi` is on for a Costigan case, the pre-chart flow fires a single-call API checklist on the final note + pasted chart, writing `_costigan.{json,md}` (no DB columns; one `processing_events` row).
  - `docs/DECISIONS.md`: append a dated entry — "Costigan checklist ported to single-call API (no live connector; packs carry validated codes); wired into pre-chart, gated by `enableCostiganCdi` + Costigan doctor check; inputs split (Box A → edit-note, Box B chart → checklist only); no DB schema change."

- [ ] **Step 4: Commit**

```bash
git add docs/plans/README.md CLAUDE.md docs/DECISIONS.md
git commit -m "docs: record Costigan checklist (API) plan, skill, and decision"
```

---

## Self-Review (run after implementing)

1. **Spec coverage:** setting (T1), builder + system/user split + pack injection (T2), MD render (T3), the ported skill incl. exam guardrail + no-connector (T4), gate + orchestration + persistence + one event row (T5), input segregation wired through UI→IPC→job→onSuccess (T6, T7), end-to-end + docs (T8). The "no transcript", "no DB columns", "Box A unchanged", and "always `ctx.api`" constraints are honored.
2. **Type consistency:** `buildSingleCallCostiganCdi` keys, `renderCostiganMd(data)` shape, and the skill's output JSON schema all match the same field names (`procedures_detected[].checklist[].{id,criterion,status,evidence_found,fix}`, `summary.overall_status`, etc.).
3. **No placeholders:** every code/step is concrete except the two explicit "find via grep" anchors (the settings-view toggle and confirming `normalizeApiUsage`'s key names) — both are "mirror the existing pattern" with a concrete search.
4. **Open follow-ups (out of scope, noted):** prompt-caching the system+packs; the toned-down HTML→PDF render (depends on the parked `feature/engine-output-html-pdf` PDF fix); transcript-as-cross-reference v2.

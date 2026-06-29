'use strict'

/**
 * Render a Costigan procedure-checklist JSON into a self-contained HTML report,
 * using the SAME "Clinical Cockpit" design system as the combined CDI/E·M/
 * patient-summary report (src/render/cockpit.css — extracted verbatim from the
 * reference scroller). The Costigan JSON has a different shape (procedures +
 * checklist, not CDI flags), so this module maps that shape onto the cockpit's
 * component vocabulary: header, flag-badges, flag-cards, evidence boxes, code
 * chips and the code-validation table.
 *
 * Pure function: reads ONLY from `data`. The cockpit CSS is inlined into the
 * output so the file stays fully self-contained (offline, CSP-safe, print-ready
 * for the PDF pass). EVERY dynamic string is routed through esc().
 */

const fs = require('fs')
const path = require('path')

const COCKPIT_CSS = fs.readFileSync(path.join(__dirname, 'cockpit.css'), 'utf8')

// Costigan-only additions on top of the shared cockpit CSS (a crit callout, the
// grey led, the within-cap pill, muted badges) — kept tiny so the shared design
// stays the source of truth.
const EXTRA_CSS = `
.led.mute{background:#8aa6b6}
.callout.crit{background:var(--crit-bg);border-color:var(--crit-line);color:#7a2018}
.callout.crit b{color:var(--crit)}
.flag-badge.muted{opacity:.45}
.freq-pill{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:20px;border:1px solid;margin-left:10px;vertical-align:middle}
.freq-pill.good{color:var(--good);background:var(--found-bg);border-color:var(--found-line)}
.freq-pill.warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line)}
.freq-pill.crit{color:var(--crit);background:var(--crit-bg);border-color:var(--crit-line)}
.proc-block{padding:16px 18px;margin-top:16px}
.proc-block h3{margin:0 0 11px;font-size:14px;font-weight:700}
.issues-list{margin:8px 0 0;padding-left:18px;font-size:12.5px;line-height:1.55;color:var(--ink-2)}
.freq-line{font-size:13px;line-height:1.55;color:var(--ink-2);margin:0 0 6px}
.freq-line b{color:var(--ink)}
.freq-note{font-size:12.5px;color:var(--ink-3);font-style:italic;margin-top:6px}
`

// ---- verdict / status vocabulary ----
const VERDICT = {
  audit_ready:   { led: 'good', sev: 'sev-opp',  col: 'var(--opp)',    label: 'Audit-ready' },
  needs_edits:   { led: 'warn', sev: 'sev-warn', col: 'var(--warn)',   label: 'Needs edits' },
  likely_denied: { led: 'crit', sev: 'sev-crit', col: 'var(--crit)',   label: 'Likely denied' },
  unknown:       { led: 'mute', sev: 'sev-sugg', col: 'var(--ink-3)',  label: 'Unknown' },
  no_procedure:  { led: 'mute', sev: 'sev-sugg', col: 'var(--ink-3)',  label: 'No procedure' },
}
const STATUS = {
  met:     { sev: 'sev-opp',  col: 'var(--opp)',  label: 'Met' },
  not_met: { sev: 'sev-crit', col: 'var(--crit)', label: 'Not met' },
  unclear: { sev: 'sev-warn', col: 'var(--warn)', label: 'Unclear' },
}

const MARK_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 11l3 3L20 5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const FA_IC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 3L4 14h6l-1 7 9-11h-6l1-7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'

// ---- helpers ----
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const has = (v) => v !== null && v !== undefined && v !== ''
const arr = (v) => Array.isArray(v) ? v : []
const cap = (s) => has(s) ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : ''
const verdictOf = (v) => VERDICT[v] || { led: 'mute', sev: 'sev-sugg', col: 'var(--ink-3)', label: cap(String(v || '').replace(/_/g, ' ')) || '—' }

function fmtDate(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : String(s)
}

function codechip(code, desc, add) {
  return `<span class="codechip${add ? ' add' : ''}">`
    + `<span class="cc-code">${esc(code)}</span>`
    + (has(desc) ? `<span class="cc-desc">${esc(desc)}</span>` : '')
    + `</span>`
}

// ---- checklist item → flag-card ----
function renderChecklistCard(item) {
  const st = STATUS[item.status] || { sev: 'sev-sugg', col: 'var(--ink-3)', label: cap(item.status) || '—' }
  const ev = arr(item.evidence_found).filter(has)
  const action = has(item.fix)
    ? `<div class="fc-action"><span class="fa-ic">${FA_IC}</span><span class="fa-txt"><span class="fa-kicker">Fix</span>${esc(item.fix)}</span></div>`
    : ''
  const evHtml = ev.length
    ? `<div class="evidence-cols" style="grid-template-columns:1fr"><div class="evbox found"><div class="ev-head">Evidence found</div><ul>${ev.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div></div>`
    : ''
  return `<article class="flag-card" style="--fc-col:${st.col}">`
    + `<div class="fc-head">`
    + `<div class="fc-sev"><span class="sev-tag ${st.sev}">${esc(st.label)}</span></div>`
    + `<div class="fc-headmain"><div class="fc-cat">Checklist criterion</div>`
    + `<h3 class="fc-title">${esc(item.criterion)}</h3>`
    + (has(item.id) ? `<div class="fc-id">${esc(item.id)}</div>` : '')
    + `</div></div>`
    + action + evHtml
    + `<div class="fc-foot"></div></article>`
}

// ---- coding sub-block ----
function renderCoding(c) {
  c = c || {}
  const cpt = arr(c.cpt_observed).filter(has)
  const icdObs = arr(c.icd_observed).filter(has)
  const icdSug = arr(c.icd_suggested).filter(Boolean)
  const issues = arr(c.coding_issues).filter(has)
  if (!cpt.length && !icdObs.length && !icdSug.length && !issues.length) return ''
  const lines = []
  if (cpt.length)    lines.push(`<div class="codechips">${cpt.map(x => codechip(x)).join('')}</div>`)
  if (icdObs.length) lines.push(`<div class="codechips">${icdObs.map(x => codechip(x)).join('')}</div>`)
  if (icdSug.length) lines.push(`<div class="codechips">${icdSug.map(s => codechip(s.code, s.description, true)).join('')}</div>`)
  if (issues.length) lines.push(`<ul class="issues-list">${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`)
  return `<div class="card proc-block"><h3>Coding</h3>${lines.join('')}</div>`
}

// ---- frequency sub-block ----
function renderFrequency(f) {
  f = f || {}
  const priors = arr(f.prior_dates).filter(has)
  const hasWithin = f.within_cap !== undefined && f.within_cap !== null
  if (!has(f.cap) && !priors.length && !hasWithin && !has(f.note)) return ''
  let pill = ''
  if (hasWithin) {
    const v = f.within_cap
    const label = v === true ? 'Within cap' : v === false ? 'Over cap' : cap(v)
    const cls = v === true ? 'good' : v === false ? 'crit' : 'warn'
    pill = `<span class="freq-pill ${cls}">${esc(label)}</span>`
  }
  const lines = []
  if (has(f.cap))     lines.push(`<p class="freq-line"><b>Cap:</b> ${esc(f.cap)}</p>`)
  if (priors.length)  lines.push(`<p class="freq-line"><b>Prior same-family procedures (${priors.length}):</b> ${priors.map(esc).join(', ')}</p>`)
  if (has(f.note))    lines.push(`<p class="freq-note">${esc(f.note)}</p>`)
  return `<div class="card proc-block"><h3>Frequency ${pill}</h3>${lines.join('')}</div>`
}

// ---- one procedure → a scroll-section ----
function renderProcedureSection(p, idx) {
  const v = verdictOf(p.verdict)
  const title = esc(p.procedure || 'Procedure') + (has(p.subtype) ? ` — <span style="font-weight:600;color:var(--ink-3)">${esc(p.subtype)}</span>` : '')

  const meta = []
  if (has(p.intent)) meta.push(`<span class="meta-item"><span class="mi-lbl">Intent</span>${esc(p.intent)}</span>`)
  if (has(p.rung))   meta.push(`<span class="meta-item"><span class="mi-lbl">Stage</span>${esc(p.rung)}</span>`)
  if (has(p.site))   meta.push(`<span class="meta-item"><span class="mi-lbl">Site</span>${esc(p.site)}</span>`)
  const metaHtml = meta.length ? `<div class="fc-meta">${meta.join('')}</div>` : ''

  const denial = (p.verdict === 'likely_denied' && has(p.denial_reason))
    ? `<div class="fc-action"><span class="fa-ic">${FA_IC}</span><span class="fa-txt"><span class="fa-kicker">Denial risk</span>${esc(p.denial_reason)}</span></div>`
    : ''

  const summaryCard = `<article class="flag-card" style="--fc-col:${v.col}">`
    + `<div class="fc-head">`
    + `<div class="fc-sev"><span class="sev-tag ${v.sev}">${esc(v.label)}</span></div>`
    + `<div class="fc-headmain"><div class="fc-cat">Procedure</div>`
    + `<h3 class="fc-title">${title}</h3>`
    + (has(p.id) ? `<div class="fc-id">${esc(p.id)}</div>` : '')
    + `</div></div>`
    + denial + metaHtml + `<div class="fc-foot"></div></article>`

  const checklist = arr(p.checklist).filter(Boolean)
  const checklistHtml = checklist.length
    ? `<div class="section-head" style="margin-top:24px"><div><p class="eyebrow">Medical-necessity checklist</p>`
      + `<h2 style="display:inline-block">${checklist.length} criteri${checklist.length === 1 ? 'on' : 'a'}</h2></div></div>`
      + `<div class="flag-list">${checklist.map(renderChecklistCard).join('')}</div>`
    : ''

  const head = `<div class="section-head"><div><p class="eyebrow">Procedure ${idx + 1}</p>`
    + `<h2 style="display:inline-block">${esc(p.procedure || 'Procedure')}</h2></div></div>`

  return `<section class="scroll-section">${head}${summaryCard}${checklistHtml}${renderCoding(p.coding)}${renderFrequency(p.frequency)}</section>`
}

// ---- code validation table ----
function renderCodeValidation(cv) {
  if (!cv || typeof cv !== 'object') return ''
  const inNote = arr(cv.codes_in_note).filter(has)
  const supported = {}; arr(cv.supported).forEach(c => { supported[c] = true })
  const flagged = arr(cv.flagged).filter(Boolean)
  if (!inNote.length && !flagged.length) return ''

  let rows = ''
  inNote.forEach(code => {
    const cls = supported[code] ? 'ok' : 'ok'
    const status = supported[code] ? 'Supported' : 'In note'
    rows += `<tr><td><code>${esc(code)}</code></td><td><span class="cv-status ${cls}"><span class="pip"></span>${esc(status)}</span></td><td style="color:var(--ink-3)">In note</td></tr>`
  })
  flagged.forEach(f => {
    rows += `<tr><td><code>${esc(f.code)}</code></td>`
      + `<td><span class="cv-status miss"><span class="pip"></span>Flagged</span></td>`
      + `<td>${esc(f.issue)}${has(f.linked_proc_id) ? ` <span class="cv-ref">${esc(f.linked_proc_id)}</span>` : ''}</td></tr>`
  })

  const head = `<div class="section-head"><div><p class="eyebrow">Code validation</p>`
    + `<h2 style="display:inline-block">ICD-10-CM code check</h2></div></div>`
  return `<section class="scroll-section">${head}`
    + `<div class="card codeval-card"><div class="codeval-head"><h3>Code validation</h3>`
    + `<p>${inNote.length} code${inNote.length === 1 ? '' : 's'} in note · ${flagged.length} flagged</p></div>`
    + `<div class="tablescroll"><table class="codeval"><thead><tr><th>Code</th><th>Status</th><th>Issue / source</th></tr></thead>`
    + `<tbody>${rows || '<tr><td colspan="3" style="color:var(--ink-3)">No codes recorded.</td></tr>'}</tbody></table></div></div></section>`
}

function renderCostiganHtml(data) {
  data = data || {}
  const meta = data.meta || {}
  const patient = meta.patient || 'Unknown patient'

  // ---- header ----
  const metaParts = []
  if (has(meta.doctor))          metaParts.push(`<span class="pm"><b>${esc(meta.doctor)}</b></span>`)
  if (has(meta.date_of_service)) metaParts.push(`<span class="pm">DOS <b>${esc(meta.date_of_service)}</b></span>`)
  if (has(meta.generated_at))    metaParts.push(`<span class="pm">${esc(fmtDate(meta.generated_at))}</span>`)

  // Parse-error stub — still a cockpit-styled page.
  if (data.parse_error) {
    const body = `<section class="scroll-section"><div class="callout crit"><span class="co-ic">⚠</span>`
      + `<span class="co-body"><b>Checklist could not be produced.</b> The model output could not be parsed into a procedure checklist.`
      + (has(data.raw_output_path) ? ` Raw output: <code>${esc(data.raw_output_path)}</code>` : '') + `</span></div></section>`
    return page(patient, metaParts, '', body, meta)
  }

  const summary = data.summary || {}
  const procs = arr(data.procedures_detected).filter(Boolean)
  const ov = verdictOf(summary.overall_status || 'no_procedure')
  const n = summary.procedures_in_play || 0

  const verdictCluster = `<div class="verdict-pill"><span class="vp-label">Overall</span>`
    + `<span class="vp-value"><span class="led ${ov.led}"></span>${esc(ov.label)}</span></div>`
    + `<div class="verdict-pill"><span class="vp-label">In play</span><span class="vp-value">${esc(n)}</span></div>`

  // ---- overview ----
  const badges = [
    { cls: 'fb-sugg', label: 'Procedures',    n },
    { cls: 'fb-opp',  label: 'Audit-ready',   n: summary.audit_ready_count || 0 },
    { cls: 'fb-warn', label: 'Needs edits',   n: summary.needs_edits_count || 0 },
    { cls: 'fb-crit', label: 'Likely denied', n: summary.likely_denied_count || 0 },
  ]
  const badgeHtml = badges.map(b => `<div class="flag-badge ${b.cls}${b.n === 0 ? ' muted' : ''}">`
    + `<div class="fb-num">${esc(b.n)}</div><div class="fb-lbl">${esc(b.label)}</div></div>`).join('')

  const calloutCls = ov.led === 'good' ? 'callout' : ov.led === 'crit' ? 'callout crit' : 'callout alert'
  const headlineHtml = has(summary.headline)
    ? `<div class="${calloutCls}" style="margin-bottom:18px"><span class="co-ic">${ov.led === 'good' ? '✓' : '⚠'}</span><span class="co-body">${esc(summary.headline)}</span></div>`
    : ''

  const overviewHead = `<div class="section-head"><div><p class="eyebrow">Verdict &amp; overview</p>`
    + `<h2 style="display:inline-block">Procedures at a glance</h2></div></div>`

  let body
  if (n === 0) {
    body = `<section class="scroll-section">${overviewHead}${headlineHtml}`
      + `<div class="card" style="padding:22px 24px;color:var(--ink-3)">No interventional procedure was performed or requested in this note, so no procedure checklist applies.</div></section>`
  } else {
    const overview = `<section class="scroll-section">${overviewHead}${headlineHtml}`
      + `<p class="eyebrow">Procedure verdicts</p><div class="flag-badges">${badgeHtml}</div></section>`
    const procSections = procs.map(renderProcedureSection).join('<hr class="section-rule">')
    const codeval = renderCodeValidation(data.code_validation)
    body = overview + '<hr class="section-rule">' + procSections + (codeval ? '<hr class="section-rule">' + codeval : '')
  }

  return page(patient, metaParts, verdictCluster, body, meta)
}

function page(patient, metaParts, verdictCluster, body, meta) {
  meta = meta || {}
  const versions = meta.standards_versions || {}
  const vstr = Object.keys(versions).length
    ? Object.entries(versions).map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('')
    : '<span>—</span>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Procedure Checklist — ${esc(patient)}</title>
<style>${COCKPIT_CSS}${EXTRA_CSS}</style>
</head>
<body>
<header class="cockpit-header"><div class="hdr-inner"><div class="hdr-top">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">${MARK_SVG}</div>
    <div class="brand-txt"><div class="brand-name">Procedure Checklist</div><div class="brand-sub">Costigan CDI Co-Pilot</div></div>
  </div>
  <div class="patient-block">
    <div class="patient-name">${esc(patient)}</div>
    <div class="patient-meta">${metaParts.join('<span class="dot">·</span>')}</div>
  </div>
  <div class="verdict-cluster">${verdictCluster}</div>
</div></div></header>
<main class="stage">
${body}
<footer class="cockpit-foot">
  <div class="cf-disclaim">Clinical-documentation decision support — for provider review, not a coding or billing directive.</div>
  <div class="cf-versions">${vstr}</div>
</footer>
</main>
</body>
</html>`
}

module.exports = { renderCostiganHtml }

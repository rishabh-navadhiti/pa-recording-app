'use strict'

/**
 * Render a Costigan procedure-checklist JSON into a self-contained HTML report.
 *
 * Sibling of renderCostiganMd (src/render/costiganMd.js): same data shape, same
 * verdict/status vocabulary — this one produces the *visible* Clinical-Cockpit
 * styled report. Pure function: reads ONLY from `data`; swap `data` and it
 * re-renders for any case. Self-contained (inline CSS, system fonts, zero
 * external requests) and print-ready (@media print / @page Letter) so a later
 * Electron printToPDF pass paginates cleanly.
 *
 * EVERY dynamic string is routed through esc() — checklist criteria, evidence,
 * fixes and denial reasons are clinical free text and may contain < & ".
 */

const VERDICT = {
  audit_ready:   { led: 'good', label: 'Audit-ready' },
  needs_edits:   { led: 'warn', label: 'Needs edits' },
  likely_denied: { led: 'crit', label: 'Likely denied' },
  unknown:       { led: 'mute', label: 'Unknown' },
  no_procedure:  { led: 'mute', label: 'No procedure' },
}
const STATUS = {
  met:     { cls: 'met',     mark: '✓', label: 'Met' },
  not_met: { cls: 'not-met', mark: '✗', label: 'Not met' },
  unclear: { cls: 'unclear', mark: '!', label: 'Unclear' },
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function verdict(v) { return VERDICT[v] || { led: 'mute', label: titleize(v) } }
function titleize(v) { v = String(v || '—'); return v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') }
function chip(code, desc, add) {
  return `<span class="codechip${add ? ' add' : ''}">`
    + `<span class="cc-code">${esc(code)}</span>`
    + (desc ? `<span class="cc-desc">${esc(desc)}</span>` : '')
    + `</span>`
}

function renderChecklistItem(item) {
  const st = STATUS[item.status] || { cls: 'unclear', mark: '?', label: titleize(item.status) }
  const ev = (item.evidence_found || []).filter(Boolean)
  const out = [`<div class="check ${st.cls}">`]
  out.push(`<div class="ck-head">`)
  out.push(`<span class="ck-tag ${st.cls}"><span class="ck-mark">${st.mark}</span>${esc(st.label)}</span>`)
  out.push(`<div class="ck-crit">${item.id ? `<span class="ck-id">${esc(item.id)}</span>` : ''}${esc(item.criterion)}</div>`)
  out.push(`</div>`)
  if (ev.length) {
    out.push(`<div class="evbox found"><div class="ev-head">Evidence found</div><ul>`)
    for (const e of ev) out.push(`<li>${esc(e)}</li>`)
    out.push(`</ul></div>`)
  }
  if (item.fix) {
    out.push(`<div class="fixbox"><span class="fx-kicker">→ Fix</span><div class="fx-txt">${esc(item.fix)}</div></div>`)
  }
  out.push(`</div>`)
  return out.join('')
}

function renderCoding(c) {
  c = c || {}
  const cpt = (c.cpt_observed || []).filter(Boolean)
  const icdObs = (c.icd_observed || []).filter(Boolean)
  const icdSug = (c.icd_suggested || []).filter(Boolean)
  const issues = (c.coding_issues || []).filter(Boolean)
  if (!cpt.length && !icdObs.length && !icdSug.length && !issues.length) return ''
  const out = [`<div class="sub"><h4>Coding</h4>`]
  if (cpt.length)    out.push(`<div class="codeline"><span class="cl-lbl">CPT in note</span><div class="chips">${cpt.map(x => chip(x)).join('')}</div></div>`)
  if (icdObs.length) out.push(`<div class="codeline"><span class="cl-lbl">ICD-10 in note</span><div class="chips">${icdObs.map(x => chip(x)).join('')}</div></div>`)
  if (icdSug.length) out.push(`<div class="codeline"><span class="cl-lbl">Suggested ICD-10</span><div class="chips">${icdSug.map(s => chip(s.code, s.description, true)).join('')}</div></div>`)
  if (icdSug.some(s => s.why)) {
    out.push(`<ul class="whylist">`)
    for (const s of icdSug) if (s.why) out.push(`<li><code>${esc(s.code)}</code> — ${esc(s.why)}</li>`)
    out.push(`</ul>`)
  }
  if (issues.length) {
    out.push(`<div class="issues"><span class="cl-lbl">Coding issues</span><ul>`)
    for (const it of issues) out.push(`<li>${esc(it)}</li>`)
    out.push(`</ul></div>`)
  }
  out.push(`</div>`)
  return out.join('')
}

function renderFrequency(f) {
  f = f || {}
  const priors = (f.prior_dates || []).filter(Boolean)
  const hasCap = !!f.cap, hasWithin = f.within_cap !== undefined && f.within_cap !== null
  if (!hasCap && !priors.length && !hasWithin && !f.note) return ''
  let pill = ''
  if (hasWithin) {
    const v = f.within_cap
    const label = v === true ? 'Within cap' : v === false ? 'Over cap' : titleize(v)
    const cls = v === true ? 'good' : v === false ? 'crit' : 'warn'
    pill = `<span class="freq-pill ${cls}">${esc(label)}</span>`
  }
  const out = [`<div class="sub"><h4>Frequency ${pill}</h4>`]
  if (hasCap)        out.push(`<p class="freq-cap"><b>Cap:</b> ${esc(f.cap)}</p>`)
  if (priors.length) out.push(`<p class="freq-prior"><b>Prior same-family procedures (${priors.length}):</b> ${priors.map(esc).join(', ')}</p>`)
  if (f.note)        out.push(`<p class="freq-note">${esc(f.note)}</p>`)
  out.push(`</div>`)
  return out.join('')
}

function renderProc(p) {
  const v = verdict(p.verdict)
  const title = esc(p.procedure || '') + (p.subtype ? ` <span class="pc-sub">— ${esc(p.subtype)}</span>` : '')
  const meta = []
  if (p.intent) meta.push(`<span><b>Intent</b> ${esc(p.intent)}</span>`)
  if (p.rung)   meta.push(`<span><b>Stage</b> ${esc(p.rung)}</span>`)
  if (p.site)   meta.push(`<span><b>Site</b> ${esc(p.site)}</span>`)

  const out = [`<div class="proc led-${v.led}">`]
  out.push(`<div class="pc-head">`)
  out.push(`<span class="verdict-tag ${v.led}"><span class="led ${v.led}"></span>${esc(v.label)}</span>`)
  out.push(`<div class="pc-title">${title}</div>`)
  out.push(`</div>`)
  if (meta.length) out.push(`<div class="pc-meta">${meta.join('')}</div>`)
  if (p.verdict === 'likely_denied' && p.denial_reason) {
    out.push(`<div class="callout crit"><span class="co-ic">⚠</span><div class="co-body"><b>Denial risk.</b> ${esc(p.denial_reason)}</div></div>`)
  }
  const checklist = (p.checklist || []).filter(Boolean)
  if (checklist.length) {
    out.push(`<div class="sub"><h4>Medical-necessity checklist</h4><div class="checklist">`)
    for (const item of checklist) out.push(renderChecklistItem(item))
    out.push(`</div></div>`)
  }
  out.push(renderCoding(p.coding))
  out.push(renderFrequency(p.frequency))
  out.push(`</div>`)
  return out.join('')
}

function renderCodeValidation(cv) {
  if (!cv || typeof cv !== 'object') return ''
  const inNote = (cv.codes_in_note || []).filter(Boolean)
  const supported = (cv.supported || []).filter(Boolean)
  const flagged = (cv.flagged || []).filter(Boolean)
  if (!inNote.length && !supported.length && !flagged.length) return ''
  const out = [`<section class="block"><div class="section-head"><h2>Code validation</h2></div>`]
  if (inNote.length)    out.push(`<div class="codeline"><span class="cl-lbl">Codes in note (${inNote.length})</span><div class="chips">${inNote.map(x => chip(x)).join('')}</div></div>`)
  if (supported.length) out.push(`<div class="codeline"><span class="cl-lbl">Supported (${supported.length})</span><div class="chips">${supported.map(x => chip(x)).join('')}</div></div>`)
  if (flagged.length) {
    out.push(`<div class="card cv-card"><table class="codeval"><thead><tr><th>Code</th><th>Issue</th><th>Procedure</th></tr></thead><tbody>`)
    for (const e of flagged) {
      out.push(`<tr><td><code>${esc(e.code)}</code></td><td>${esc(e.issue)}</td><td>${e.linked_proc_id ? `<span class="cv-ref">${esc(e.linked_proc_id)}</span>` : '—'}</td></tr>`)
    }
    out.push(`</tbody></table></div>`)
  }
  out.push(`</section>`)
  return out.join('')
}

function renderCostiganHtml(data) {
  data = data || {}
  const meta = data.meta || {}
  const patient = esc(meta.patient || 'Unknown patient')

  // Parse-error stub — mirror renderCostiganMd: still produce a readable page.
  if (data.parse_error) {
    return page(patient, `
      <section class="block"><div class="card empty-card">
        <div class="empty-ic">⚠</div>
        <h2>Checklist could not be produced</h2>
        <p>The model output could not be parsed into a procedure checklist.</p>
        ${meta && data.raw_output_path ? `<p class="raw">Raw output: <code>${esc(data.raw_output_path)}</code></p>` : ''}
      </div></section>`, meta)
  }

  const summary = data.summary || {}
  const procs = (data.procedures_detected || []).filter(Boolean)
  const ov = verdict(summary.overall_status || 'no_procedure')
  const n = summary.procedures_in_play || 0

  const body = []

  // ---- Overview ----
  body.push(`<section class="block">`)
  if (summary.headline) {
    body.push(`<div class="callout ${ov.led === 'good' ? 'ok' : ov.led === 'crit' ? 'crit' : 'alert'}">`
      + `<span class="co-ic">${ov.led === 'good' ? '✓' : ov.led === 'crit' ? '⚠' : 'ℹ'}</span>`
      + `<div class="co-body">${esc(summary.headline)}</div></div>`)
  }
  if (n === 0) {
    body.push(`<div class="card empty-card"><div class="empty-ic">○</div><h2>No procedure in play</h2>`
      + `<p>No interventional procedure was performed or requested in this note, so no procedure checklist applies.</p></div>`)
  } else {
    const badges = [
      ['proc', n, n === 1 ? 'Procedure' : 'Procedures'],
      ['good', summary.audit_ready_count || 0, 'Audit-ready'],
      ['warn', summary.needs_edits_count || 0, 'Needs edits'],
      ['crit', summary.likely_denied_count || 0, 'Likely denied'],
    ]
    body.push(`<div class="badges">`)
    for (const [cls, num, lbl] of badges) {
      body.push(`<div class="badge ${cls}"><div class="bd-num">${esc(num)}</div><div class="bd-lbl">${esc(lbl)}</div></div>`)
    }
    body.push(`</div>`)
  }
  body.push(`</section>`)

  // ---- Procedures ----
  for (const p of procs) {
    body.push(`<section class="block"><div class="section-head"><h2>${esc(p.procedure || 'Procedure')}</h2>`
      + `<span class="sh-sub">${esc(p.id || '')}</span></div>`)
    body.push(renderProc(p))
    body.push(`</section>`)
  }

  // ---- Code validation ----
  body.push(renderCodeValidation(data.code_validation))

  return page(patient, body.join(''), meta, { overall: ov, summary })
}

/** Wrap header + body + footer into the full self-contained document. */
function page(patient, bodyHtml, meta, extra) {
  meta = meta || {}
  const ov = extra && extra.overall
  const summary = (extra && extra.summary) || {}
  const metaBits = []
  if (meta.doctor)          metaBits.push(`<span class="pm"><b>Provider</b> ${esc(meta.doctor)}</span>`)
  if (meta.date_of_service) metaBits.push(`<span class="pm"><b>DOS</b> ${esc(meta.date_of_service)}</span>`)
  if (meta.generated_at)    metaBits.push(`<span class="pm"><b>Generated</b> ${esc(fmtDate(meta.generated_at))}</span>`)

  const verdictPill = ov ? `<div class="verdict-pill">`
    + `<div class="vp-label">Overall</div>`
    + `<div class="vp-value"><span class="led ${ov.led}"></span>${esc(ov.label)}</div></div>` : ''
  const countPill = (summary.procedures_in_play != null) ? `<div class="verdict-pill">`
    + `<div class="vp-label">In play</div>`
    + `<div class="vp-value">${esc(summary.procedures_in_play || 0)}</div></div>` : ''

  const versions = meta.standards_versions || {}
  const vstr = Object.keys(versions).length
    ? Object.entries(versions).map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('')
    : '<span>—</span>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Procedure Checklist — ${patient}</title>
<style>${CSS}</style>
</head>
<body>
<header class="cockpit-header"><div class="hdr-inner">
  <div class="hdr-top">
    <div class="brand">
      <div class="brand-mark">${MARK_SVG}</div>
      <div class="brand-txt"><div class="brand-name">Procedure Checklist</div><div class="brand-sub">Costigan CDI Co-Pilot</div></div>
    </div>
    <div class="patient-block">
      <div class="patient-name">${patient}</div>
      <div class="patient-meta">${metaBits.join('<span class="dot">·</span>')}</div>
    </div>
    <div class="verdict-cluster">${verdictPill}${countPill}</div>
  </div>
</div></header>
<main class="stage">${bodyHtml}</main>
<footer class="cockpit-foot">
  <div>Generated ${esc(fmtDate(meta.generated_at) || '')}. Clinical-documentation decision support — for provider review, not a coding or billing directive.</div>
  <div class="cf-versions">${vstr}</div>
</footer>
</body>
</html>`
}

function fmtDate(s) {
  if (!s) return ''
  // Leave the ISO string mostly intact but trim the ms/zone noise for the header.
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : String(s)
}

const MARK_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'

const CSS = `
:root{
  --bg:#0d1b2a;--surface:#f4f6f8;--panel:#fff;--panel-2:#fbfcfd;
  --ink:#15212e;--ink-2:#42566a;--ink-3:#73869a;--line:#dde4ea;--line-2:#e9eef2;
  --accent:#0f6e8c;--accent-deep:#0a4f64;--accent-soft:#e3f0f4;
  --crit:#c0392b;--crit-bg:#fdecea;--crit-line:#f3c0ba;
  --warn:#b87208;--warn-bg:#fdf3e2;--warn-line:#f1d8a8;
  --good:#2c8a5a;--good-bg:#e7f5ec;--good-line:#bfe2cc;
  --found-bg:#edf7f0;--found-line:#c9e6d3;
  --shadow:0 1px 2px rgba(13,27,42,.06),0 4px 14px rgba(13,27,42,.05);
  --radius:12px;--radius-sm:8px;
  --mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}html,body{margin:0;padding:0}html{overflow-x:hidden}
body{font-family:var(--sans);background:var(--surface);color:var(--ink);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow-x:hidden}
.led{width:9px;height:9px;border-radius:50%;flex:0 0 auto;display:inline-block}
.led.good{background:#3fc07e}.led.warn{background:#e8a33d}.led.crit{background:var(--crit)}.led.mute{background:#8aa6b6}

.cockpit-header{background:linear-gradient(180deg,#10283c,#0d1b2a);color:#eaf1f6;box-shadow:0 2px 18px rgba(0,0,0,.25)}
.hdr-inner{max-width:1080px;margin:0 auto;padding:14px 20px 18px}
.hdr-top{display:flex;flex-wrap:wrap;align-items:flex-start;gap:14px 22px;justify-content:space-between}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.brand-mark{width:34px;height:34px;border-radius:9px;flex:0 0 auto;background:linear-gradient(135deg,#2a9fbf,#0f6e8c);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.brand-name{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#cfe2ea}
.brand-sub{font-size:11px;color:#7e9bac;letter-spacing:.04em;margin-top:1px}
.patient-block{min-width:0;flex:1 1 280px}
.patient-name{font-size:22px;font-weight:700;line-height:1.15;letter-spacing:-.01em;color:#fff}
.patient-meta{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:6px;font-size:12.5px;color:#a9c0cd;align-items:center}
.patient-meta .pm b{color:#dce8ef;font-weight:600;margin-right:4px}
.patient-meta .dot{color:#46627a}
.verdict-cluster{display:flex;align-items:center;gap:12px;flex:0 0 auto}
.verdict-pill{display:flex;flex-direction:column;gap:2px;padding:9px 15px;border-radius:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);min-width:120px}
.verdict-pill .vp-label{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#8aa6b6}
.verdict-pill .vp-value{font-size:14.5px;font-weight:700;display:flex;align-items:center;gap:7px}

.stage{max-width:1080px;margin:0 auto;padding:24px 20px 50px}
.block{margin:0 0 30px}
.section-head{display:flex;align-items:baseline;gap:11px;margin:4px 0 14px}
.section-head h2{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:0}
.section-head .sh-sub{font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}

.callout{display:flex;gap:13px;padding:15px 17px;border-radius:var(--radius);border:1px solid;align-items:flex-start;margin:0 0 18px}
.callout .co-ic{flex:0 0 auto;font-size:16px;line-height:1.4}
.callout .co-body{font-size:13.5px;line-height:1.6}
.callout.alert{background:var(--warn-bg);border-color:var(--warn-line);color:#6b4503}
.callout.crit{background:var(--crit-bg);border-color:var(--crit-line);color:#7a2018}
.callout.ok{background:var(--good-bg);border-color:var(--good-line);color:#1e5a3b}

.badges{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.badge{border-radius:var(--radius-sm);padding:15px 10px;text-align:center;border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow)}
.badge .bd-num{font-size:28px;font-weight:800;line-height:1}
.badge .bd-lbl{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;margin-top:5px;color:var(--ink-3)}
.badge.proc .bd-num{color:var(--accent-deep)}
.badge.good{border-color:var(--good-line);background:var(--good-bg)}.badge.good .bd-num,.badge.good .bd-lbl{color:var(--good)}
.badge.warn{border-color:var(--warn-line);background:var(--warn-bg)}.badge.warn .bd-num,.badge.warn .bd-lbl{color:var(--warn)}
.badge.crit{border-color:var(--crit-line);background:var(--crit-bg)}.badge.crit .bd-num,.badge.crit .bd-lbl{color:var(--crit)}

.proc{background:var(--panel);border:1px solid var(--line);border-left:5px solid #999;border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px}
.proc.led-good{border-left-color:var(--good)}.proc.led-warn{border-left-color:var(--warn)}.proc.led-crit{border-left-color:var(--crit)}.proc.led-mute{border-left-color:#8aa6b6}
.pc-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}
.verdict-tag{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:5px 11px;border-radius:20px;border:1px solid}
.verdict-tag.good{color:var(--good);background:var(--good-bg);border-color:var(--good-line)}
.verdict-tag.warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line)}
.verdict-tag.crit{color:var(--crit);background:var(--crit-bg);border-color:var(--crit-line)}
.verdict-tag.mute{color:var(--ink-3);background:var(--line-2);border-color:var(--line)}
.pc-title{font-size:17px;font-weight:700;letter-spacing:-.01em}
.pc-title .pc-sub{font-weight:600;color:var(--ink-3);font-size:14px}
.pc-meta{display:flex;flex-wrap:wrap;gap:6px 20px;margin:12px 0 4px;font-size:12.5px;color:var(--ink-2)}
.pc-meta b{font-weight:700;color:var(--ink-3);text-transform:uppercase;font-size:10.5px;letter-spacing:.05em;margin-right:5px}

.sub{margin-top:18px}
.sub h4{font-size:12px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--accent);margin:0 0 11px;display:flex;align-items:center;gap:10px}
.checklist{display:flex;flex-direction:column;gap:12px}
.check{border:1px solid var(--line);border-radius:var(--radius-sm);padding:13px 15px;background:var(--panel-2)}
.check.not-met{border-color:var(--crit-line);background:#fdf6f5}
.check.unclear{border-color:var(--warn-line);background:#fdfaf3}
.check.met{border-color:var(--good-line);background:#f6fbf8}
.ck-head{display:flex;gap:11px;align-items:flex-start}
.ck-tag{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:4px 9px;border-radius:6px;color:#fff;white-space:nowrap}
.ck-tag .ck-mark{font-weight:900}
.ck-tag.met{background:var(--good)}.ck-tag.not-met{background:var(--crit)}.ck-tag.unclear{background:var(--warn)}
.ck-crit{font-size:13.5px;line-height:1.5;font-weight:600;color:var(--ink)}
.ck-id{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);background:var(--line-2);padding:1px 6px;border-radius:4px;margin-right:8px;font-weight:700}
.evbox{margin-top:11px;border-radius:var(--radius-sm);border:1px solid var(--found-line);background:var(--found-bg);padding:10px 13px}
.evbox .ev-head{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--good);margin-bottom:7px}
.evbox ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.evbox li{font-size:12.5px;line-height:1.45;padding-left:18px;position:relative;color:var(--ink-2)}
.evbox li::before{content:"\\201C";position:absolute;left:2px;top:2px;color:var(--good);font-weight:800;font-size:15px}
.fixbox{margin-top:11px;border-radius:var(--radius-sm);background:var(--accent-soft);border:1px solid #cce4ec;padding:11px 14px}
.fixbox .fx-kicker{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--accent);display:block;margin-bottom:4px}
.fixbox .fx-txt{font-size:13px;line-height:1.55;color:#0a3d4d}

.codeline{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline;margin-bottom:10px}
.cl-lbl{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);flex:0 0 auto}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.codechip{display:inline-flex;flex-direction:column;gap:1px;border:1px solid var(--accent-soft);background:var(--panel-2);border-radius:8px;padding:6px 11px;max-width:100%}
.codechip .cc-code{font-family:var(--mono);font-weight:800;font-size:13px;color:var(--accent-deep)}
.codechip .cc-desc{font-size:11.5px;color:var(--ink-3);line-height:1.35}
.codechip.add{border-color:var(--good-line);background:var(--good-bg)}.codechip.add .cc-code{color:var(--good)}
.whylist{margin:2px 0 12px;padding-left:18px;font-size:12.5px;line-height:1.5;color:var(--ink-2)}
.whylist code{font-family:var(--mono);font-weight:700;background:var(--line-2);padding:1px 5px;border-radius:4px;color:var(--ink)}
.issues{margin-top:6px}.issues ul{margin:6px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5;color:var(--ink-2)}
.freq-pill{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:20px;border:1px solid}
.freq-pill.good{color:var(--good);background:var(--good-bg);border-color:var(--good-line)}
.freq-pill.warn{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line)}
.freq-pill.crit{color:var(--crit);background:var(--crit-bg);border-color:var(--crit-line)}
.sub p{font-size:13px;line-height:1.55;color:var(--ink-2);margin:0 0 7px}
.freq-note{color:var(--ink-3);font-style:italic}

.cv-card{padding:6px 4px;overflow:hidden;margin-top:6px}
.tablewrap{overflow-x:auto}
table.codeval{width:100%;border-collapse:collapse;font-size:12.5px}
table.codeval th{text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);font-weight:700;padding:10px 14px;border-bottom:2px solid var(--line)}
table.codeval td{padding:10px 14px;border-bottom:1px solid var(--line-2);vertical-align:top;color:var(--ink-2);line-height:1.5}
table.codeval tr:last-child td{border-bottom:0}
table.codeval code{font-family:var(--mono);font-weight:700;color:var(--ink);background:var(--line-2);padding:2px 6px;border-radius:4px;white-space:nowrap}
.cv-ref{font-family:var(--mono);font-size:11px;color:var(--accent)}

.empty-card{padding:34px 24px;text-align:center}
.empty-card .empty-ic{font-size:34px;color:var(--ink-3)}
.empty-card h2{margin:10px 0 6px;font-size:17px}
.empty-card p{color:var(--ink-2);font-size:13.5px;margin:0 auto;max-width:520px}
.empty-card .raw{margin-top:10px;font-size:12px}.empty-card code{font-family:var(--mono)}

.cockpit-foot{max-width:1080px;margin:30px auto 0;padding:20px 20px 28px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-3);line-height:1.6}
.cf-versions{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px}
.cf-versions b{color:var(--ink-2);font-weight:600;margin-right:4px}

@media (max-width:760px){.badges{grid-template-columns:repeat(2,1fr)}.verdict-cluster{width:100%}}

@media print{
  @page{size:Letter;margin:14mm 12mm}
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  html,body{background:#fff!important;overflow:visible!important}body{font-size:11pt}
  .cockpit-header{box-shadow:none}
  .hdr-inner,.stage,.cockpit-foot{max-width:none}
  .card,.proc,.badge{box-shadow:none!important}
  .proc,.check,.callout,.badge,.cv-card,.evbox,.fixbox{page-break-inside:avoid;break-inside:avoid}
  .section-head,h2,h4{page-break-after:avoid;break-after:avoid}
}`

module.exports = { renderCostiganHtml }

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

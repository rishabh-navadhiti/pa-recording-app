# Anthropic Healthcare plugin — connectors & skills, mapped to our roadmap

_Researched 2026-06-25. We installed the Anthropic **`healthcare`** plugin (v2.3.1, hosted at `hcls.mcp.claude.com`). This note records what each connector/skill is, how useful it is to us **now** and **later**, the concrete ways we'd use it, and the gotchas. It is grounded in live calls to the ICD-10 / CMS Coverage / NPI connectors and a full read of the 7 bundled skills + an adversarial verification pass on the three load-bearing claims._

---

## TL;DR — decisions & priorities

| Thing | Verdict |
|---|---|
| **ICD replacement (our immediate need)** | **Viable via the managed-MCP Messages API path** — keep the connector as ground truth; don't let a tool-less model emit codes from prose. See [§3](#3-primary-need-replacing-the-icd-coding-step). |
| **CMS Coverage connector** | ⭐ Highest-leverage new connector. It's the live Noridian LCD/Article layer behind Costigan's TPE audit. **But** it returns *index/metadata only* — full policy body text needs a second path. [§2.2](#22-cms-coverage-) |
| **`icd10-cm` skill** | **Reuse the methodology verbatim** — it's a stricter, guidelines-grounded version of our `add-icd-codes`, and it directly answers the "single-call suggesting is error-prone" worry. [§4.1](#41-icd10-cm--connector-backed-coder-methodology) |
| **`clinical-note-extract` skill** | **Port it** — solves the cdi-costigan **exam-axis gap** (span provenance + null-safety so a *not-mentioned* test never becomes a *negative* test). Also gives us an eval-gold-pair generator. [§4.2](#42-clinical-note-extract--structured-extraction-with-provenance) |
| **`prior-auth` skill** | **Payer-side, confirmed.** Not a drop-in for our (provider-side) Engine 5 — but a near-perfect *mirror/reference* to adapt. [§4.3](#43-prior-auth--payer-side-mirror-for-engine-5) |
| **`fhir-developer` skill** | Conceptual on-ramp for Epic/insurance integration; **not** the integration. [§4.4](#44-fhir-developer--ehrinsurance-on-ramp-reference-only) |
| **`fraud-detection` / `clinical-trial-protocol` / `contracts`** | Out of lane. Mine fraud-detection's rules as a *defensive* self-audit checklist only. [§4.5](#45-out-of-lane-skills) |
| **NPI connector** | Provider validation for WC PR-2 + prior-auth letters. Confirmed working on Dr. Costigan. [§2.3](#23-npi-registry) |
| **PubMed / Clinical Trials connectors** | PubMed = low-priority necessity-narrative evidence; Clinical Trials = out of lane. [§2.4](#24-read-up-only-pubmed--clinical-trials) |

**Two cross-cutting constraints to internalise:**
1. **Managed MCP connector is Anthropic-only** (first-party Claude API + Claude Platform on AWS + Microsoft Foundry hosted-on-Anthropic). **NOT on Bedrock / Vertex, and NOT on Gemini/DeepSeek.** If ICD coding moves to a non-Anthropic model, this bridge evaporates → that's an argument for either keeping ICD on Anthropic *or* going to the local dataset (provider-agnostic).
2. **HIPAA-BAA path conflicts with the managed-MCP path.** Anthropic's HIPAA-ready posture runs through a BAA on Bedrock/Vertex/Enterprise — but the managed `mcp_servers` param doesn't exist on Bedrock/Vertex. So if/when we need a BAA, we can't use the convenient managed connector; we'd call the (plain-HTTP) MCP endpoints ourselves and keep PHI out of them. (Moot for now — dev posture, Anthropic gets everything.)

---

## 1. What we installed

One Claude Code plugin bundling **5 skills** (the plugin also exposes `clinical-note-extract` + `contracts`, so 7 reachable here) and **5 hosted, token-less HTTP MCP connectors** declared in its `.mcp.json`:

```
CMS Coverage     https://hcls.mcp.claude.com/cms_coverage/mcp
ICD-10 Codes     https://hcls.mcp.claude.com/icd10_codes/mcp     ← what our app already uses
NPI Registry     https://hcls.mcp.claude.com/npi_registry/mcp
Clinical Trials  https://hcls.mcp.claude.com/clinical_trials/mcp
PubMed           https://pubmed.mcp.claude.com/mcp               ← DIFFERENT host
```

- **All token-less** (`type:"http"`, no `authorization_token`) → no secret management to wire them into the API.
- **Free** — no per-call connector fee. You pay only the normal token cost of the Claude turn that calls them (including the sometimes-large JSON results re-entering context).
- **Public reference data only** — coverage policies, code sets, the public NPI registry, public trials, public literature. No PHI flows to them beyond what's in your prompt.
- **Versioning:** we have `2.3.1` cached. The old per-skill/per-connector v1 plugins (`cms-coverage`, `icd10-codes`, `npi-registry`, …) are **deprecated aliases** being removed — **don't pin to those names; reference the `hcls.mcp.claude.com/<name>/mcp` URLs directly** (which is exactly what our Messages-API wiring does, so we're insulated from packaging churn).
- **Roadmap to watch:** the plugin README flags "coming next: appeal letters, **coding validation**, denial-backlog triage." Coding-validation is squarely in our lane.

---

## 2. The connectors

### 2.1 ICD-10 Codes ✅ (live-tested)

9 tools, FY2026 ICD-10-CM (diagnoses) + ICD-10-PCS (procedures): `validate_code`, `lookup_code`, `search_codes`, `get_hierarchy`, `get_by_category`, `get_by_body_system`, + dx/procedure search variants.

- **This is the connector our app already uses** (the `.mcp.json` ICD-10 connector behind agentic `add-icd-codes` + `cdi-review`).
- **Ground truth for code existence + billable status.** Live confirmations this session: `M54.50` → billable ("Low back pain, unspecified", validates our deep-review M54.5 → M54.50 fix); `M65.4` (De Quervain) → billable with **no laterality children** (the connector cleanly settles the bug that started the whole "connector wins over prose packs" discipline).
- **Usefulness now/future:** core, permanent. It's the validator for the ICD step *and* the thing every downstream engine (CDI, E/M, prior-auth) checks codes against.

### 2.2 CMS Coverage ⭐ (live-tested)

7 tools: `search_national_coverage`, `search_local_coverage`, `get_coverage_document`, `get_contractors`, `batch_get_ncds`, `get_whats_new_report` (national/local), `sad_exclusion_list`. Wraps the Medicare Coverage Database (**Part B only** — procedures/DME/labs/injectables in medical settings; not Part A/C/D).

**Why it matters most:** Costigan's TPE audit *is* an LCD medical-necessity problem. Live this session, `search_local_coverage(document_type='lcd', keyword='epidural')` returned the **active Noridian policy L39240** ("Epidural Steroid Injections for Pain Management", eff 04/16/2026) — his exact MAC (J-E) — and `document_type='article'` returned its companion **Billing & Coding article A58993** (which holds the **covered ICD-10 + CPT lists**).

**⚠️ The retrieval gap (verified):** the connector gives you **index/metadata + a cms.gov view URL only**. It does **not** return LCD/Article *body text*:
- `get_coverage_document` is hard-enum'd to **national** docs (`ncd`/`nca`/`cal`) — it will not fetch L39240 or A58993.
- `search_local_coverage` payloads carry no criteria text and no covered-code list.
- cms.gov view URLs **403 to WebFetch**.
- → To use an LCD's actual criteria / covered-code list programmatically, we need a **second path**: the public Medicare Coverage Database download/API, or a **one-time ingest** of the relevant Noridian LCD+Article into our standards packs. (This is the same "localize the reference data" pattern as the ICD local-dataset idea — but unlike ICD, *which policy is current* still wants the live connector.)

**WC framing caveat:** CMS = Medicare. Costigan is **workers'-comp**. Medicare LCDs don't *govern* WC — they're **persuasive/benchmark** clinical-necessity reference. Keep that wording in PR-2 letters (cite the LCD criteria as the standard of care, not as the binding payer rule).

**Useful untested tools** (characterized from server instructions, not live-called):
- `get_contractors` — **HIGH**: deterministically resolve state → MAC (Noridian J-E) instead of hardcoding.
- `get_whats_new_report` (local) — **MEDIUM**: cheap staleness detector — know when the Noridian ESI LCD/Article changes so our ingested covered-code lists don't rot.
- `batch_get_ncds`, `sad_exclusion_list` — LOW for interventional pain.

### 2.3 NPI Registry ✅ (live-tested)

3 tools: `npi_validate` (format/Luhn, no API call), `npi_lookup` (by NPI), `npi_search` (by name/specialty/location).

- Live: pulled the full record for **Dr. William M Costigan, NPI 1821084641** — MD, active, CA license A60548, taxonomy "Orthopaedic Surgery — Spine", Pasadena practice + mailing addresses, even a Railroad-Medicare identifier.
- **Usefulness:** provider validation/auto-fill for **WC PR-2 reports + prior-auth letters** (we're definitely doing WC + prior auth). Also referring-provider verification. Caveat: NPPES is self-reported and can lag (Costigan's record `last_updated` 2009) — an NPI existing ≠ currently licensed/credentialed.

### 2.4 Read-up only: PubMed & Clinical Trials

- **PubMed** (`pubmed.mcp.claude.com` — different host): `search_articles`, `get_article_metadata`, `get_full_text_article`, `find_related_articles`, `lookup_article_by_citation`, `convert_article_ids`, `get_copyright_status`. **LOW priority.** Real use = citing peer-reviewed evidence to strengthen a borderline necessity narrative in a PR-2. Not a pipeline dependency (payer coverage policy is the controlling authority, not journals). Check `get_copyright_status` before quoting full text.
- **Clinical Trials** (`hcls.mcp.claude.com/clinical_trials/mcp`): trial search / sponsor / investigator / endpoint tools. **Out of lane** for an ortho/pain WC scribe — it serves the plugin's `clinical-trial-protocol` skill. Ignore.

---

## 3. PRIMARY NEED: replacing the ICD-coding step

Today: agentic `claude -p` (`add-icd-codes`) appends an ICD-10 table to the SOAP note, using the ICD connector via `.mcp.json`. We want a faster/cheaper API-based path, but worry that a **single-call API model *suggesting* codes from prose is error-prone**.

**The answer (validated by the `icd10-cm` skill's design):** don't make a tool-less model emit final codes from memory — that's exactly the failure mode to avoid. Keep the connector as ground truth. Two viable shapes:

**Option A — keep it agentic (cheapest reuse, smallest change).** Leave ICD as a `claude -p` + ICD-MCP step, but upgrade the prompt to the `icd10-cm` methodology ([§4.1](#41-icd10-cm--connector-backed-coder-methodology)). Same architecture, materially better selection/specificity discipline. Good interim.

**Option B — move to the Messages API with the managed MCP connector (the modernization).** Wire the token-less ICD connector into our `src/llm/anthropicApiProvider.js` (raw `fetch`). Verified mechanics:

```js
// additions to the POST body sent to https://api.anthropic.com/v1/messages
{
  model, max_tokens, system, messages,
  mcp_servers: [
    { type: "url", name: "icd10", url: "https://hcls.mcp.claude.com/icd10_codes/mcp" }
    // no authorization_token — token-less public URL works
  ],
  tools: [ { type: "mcp_toolset", mcp_server_name: "icd10" } ]   // BOTH required; omitting this 400s
}
// + header:  anthropic-beta: mcp-client-2025-11-20
// + use the beta endpoint path (client.beta.messages / the beta wire surface)
```

- Server-side execution: the model calls the remote ICD tools **server-side**; the response carries `mcp_tool_use` / `mcp_tool_result` blocks (our existing `text`-block extraction still gets the final note).
- **It's not strictly single-call:** a tool-using turn can hit the server-side iteration cap and return `stop_reason: "pause_turn"`. Handle it by appending the assistant response **unchanged** to `messages` and **re-sending** (a small continue-loop) — distinct from the pure single-call note-gen path, so the ICD path needs its own loop.
- **Cost:** a few cents/note (tool-defs + the JSON tool results re-enter context as input tokens). Prompt-cache the stable prefix. Still ≪ the heavyweight agentic `claude -p`.

**Best-of-both for accuracy (recommended if we go Option B):** *split the work.* Let a cheap single-call model do only **selection + specificity wording** and emit ICD **search queries**; let the managed-MCP step do the **`search_codes` → `lookup_code`/`validate_code`** lookups. The model never invents a code; the connector confirms every one. This keeps the De-Quervain discipline intact while shedding the agentic harness.

**Strategic forks:**
- **If ICD moves to Gemini/DeepSeek** (the multi-provider direction — note `geminiApiProvider.js` already exists): the managed-MCP bridge **does not apply** (Anthropic-only). You'd need client-side tool execution (we host the connector call) or the **local ICD dataset** (provider-agnostic, the eventual reliability/cost win). This is the cleanest reason the local dataset still earns its place.
- **If a BAA becomes required:** managed-MCP isn't available on the BAA platforms (Bedrock/Vertex) — see the cross-cutting constraint in the TL;DR.

---

## 4. The skills

### 4.1 `icd10-cm` — connector-backed coder methodology

A **prompt-only** skill (no scripts/network of its own) that turns a clinical note into the billable ICD-10-CM list a coder would put on the claim. It **codifies the ICD-10-CM Official Guidelines for outpatient coding** into a 4-step method: (1) encounter-as-claim selection (first-listed = reason for visit; Z-code first for aftercare/screening; never code "probable/rule-out"; drop history-only/wellness on problem visits; expect 1–4 codes); (2) specificity discipline (default to unspecified when undocumented; **never infer** chronicity/severity/laterality/episode/diabetes-complication links; complications must be *clinician-linked*, not assembled from labs); (3) **validate every code via the connector**; (4) a 3-question dedupe.

**Why it's directly useful:** it's a stricter, guidelines-grounded version of our `add-icd-codes`, and its core posture **is** the answer to our worry:
> "Look up every diagnosis with the connector's tools — including diagnoses you're sure you know. Trust it over recall." … "If the connector's tools are not available, **stop**. Do not produce codes from memory."

- **Provider/claim-prep side** ("final claim responsibility remains with the billing provider"). Outpatient + diagnosis-only (no CPT/PCS, light on 7th-char episode logic — relevant since our WC injury coding leans on `A/D/S` + laterality; the connector returns them but the skill doesn't deeply teach them).
- **Verdict: reuse the methodology verbatim, adapt the runtime.** Copy Steps 1–4 into our ICD prompt (Option A) or re-host on the managed-MCP path (Option B split). The one thing **not** to do: collapse it into a tool-less single-call model that emits codes from prose — that throws away its whole value.

### 4.2 `clinical-note-extract` — structured extraction with provenance

A general-purpose primitive: extract **user-defined** fields from a note into structured records where **every value carries a verbatim source span** (deterministically verified) and **every absence is an explicit `null` + reason** (`not_mentioned` / `mentioned_unclear` / `redacted` / `out_of_scope`). Each field also gets the ConText 3-axis classification (presence / temporality / experiencer). A **tool-disabled worker** does the extraction (the note is untrusted input — structurally can't reach write/network tools); the **calling session** runs the span-verify + per-field check (terminology lookup via a connector, range, date, pattern, enum).

**Why it's directly useful — it solves the cdi-costigan exam-axis gap.** cdi-costigan needs structured PE provocative tests (SI: ≥3 of FABER/Gaenslen/thigh-thrust/compression/distraction), VAS, conservative-care duration, prior-injection relief% — facts buried in unstructured note text that we must **not fabricate** (the guardrail we wrote was "never stamp a plausible normal exam"). This skill's null-safety + span rules give exactly that: a test that wasn't mentioned comes back `null/not_mentioned`, **not** "negative" — and our checklist logic treats `not_mentioned` as *not satisfied*. The verbatim span is also the **citation a PR-2 needs**.

Concrete schema we can stand up this week: each SI test as its own `finding:true` field; VAS as `{check:{kind:range,min:0,max:10}}`; conservative-care as a date/string field; prior-injection relief as a percent range; `primary_dx` with `{check:{kind:terminology, via:"icd10cm"}}` so it validates against the connector we already use.

**Bonus — eval gold pairs:** the skill ships its own eval harness (9 adversarial cases, 15 trap types: negation, family_history, multi_axis, parametric_leak, batched_refusal, …). We can reuse the trap taxonomy as the template for our eval-framework gold pairs, and use `{note → validated record with spans}` as draft gold labels a human edits.

- **Verdict: port it.** Runtime as shipped is Workflow/subagent/bun-shaped — doesn't match our single-call API path. For production, **port the contract**: take its `rules.md` verbatim as the prompt, replicate the closed JSON output schema, enforce it ourselves (one tool-less API call per note), then run span-verify + the ICD `check.via` validation in our own JS. Use the skill as-is only for offline gold-pair generation / evals.
- **Caveats:** guarantees provenance + null-safety, **not recall** — it can miss an obliquely-phrased test ("pain reproduced with hip flexion-abduction-external rotation" without the word "FABER"); `desc` must use the note's actual language, and recall on *our* transcripts is unmeasured → validate before trusting the "≥3 positive" count. Span verification is verbatim string match → feed it the **exact** transcript text (don't reformat the note first).

### 4.3 `prior-auth` — payer-side mirror for Engine 5

**Payer-side, unambiguously confirmed** (skill's own words: _"automates the payer review process"_, _"Target Users: Health insurance payer organizations"_, _"Enable auto-approval for 40-60% of clear-cut cases"_). It ingests a PA request a provider **already submitted**, then adjudicates: validates provider/codes (NPI + ICD-10 + CMS Coverage in parallel), maps the chart to each LCD criterion (MET/NOT_MET/INSUFFICIENT + confidence), runs a doc-gap check + covered-vs-submitted ICD comparison, and emits APPROVE/PEND/DENY + a provider notification letter + an audit-justification doc. Two file-checkpointed subskills; default rubric is lenient (never auto-DENY → PEND); everything is **draft, human-sign-off-required**.

**Your hypothesis was right** — it's the insurer's seat, the inverse of our (provider) Engine 5. But it's a near-perfect **mirror to adapt**: the hardest provider-side problem (find the governing LCD → extract criteria → prove the chart meets each one) is *exactly* what this skill does from the other side. Build Engine 5 to satisfy the same criterion list the payer scores against and we're pre-running the payer's rubric.

- **Verdict: adapt, don't reuse, don't rebuild.** Lift the criterion-scoring schema, the doc-gap check, the covered-vs-submitted code comparison, the `audit_justification.md` layout, and the notification-letter placeholder/template engine. **Rewrite the direction** (compose a REQUEST + necessity narrative, not render a DECISION). Also doubles as an internal pre-submission QA reviewer (run our packet through it to predict approve/pend).
- **Gotchas before any reuse:**
  - **Tool-name mismatch** — the skill uses abstract names that **don't match our installed connectors**. Remap:

    | Skill's name | Our installed tool |
    |---|---|
    | `cms_search_all` | `search_national_coverage` / `search_local_coverage` |
    | `cms_lcd_details` | _(no equivalent — see below)_ |
    | `icd10_validate` | `validate_code` |
    | `icd10_get_details` | `lookup_code` |
    | `npi_lookup_provider` | `npi_lookup` |
  - **It assumes `cms_lcd_details` returns covered codes inline** — false on our connector (the LCD/Article body isn't retrievable; covered codes live in the A-number article — see [§2.2 gap](#22-cms-coverage-)). Its flow would miss this.
  - **Medicare-only + WC scope gap** — same caveat as CMS Coverage: doesn't apply commercial/WC payer rules.
  - **Interactive/agentic runtime** (Y/N gates, waypoint files) ≠ our single-call API path → flatten or run agentically.

### 4.4 `fhir-developer` — EHR/insurance on-ramp (reference only)

A **static developer guide** for *building/validating* FHIR R4 servers (HTTP status codes, required-vs-optional fields per resource, value-set enums, coding-system URLs, SMART-on-FHIR OAuth scopes, Bundles, pagination) + a FastAPI scaffold. **No tools, no network, never touches Epic.**

- **Relevant for our EHR/insurance roadmap** (pulling the Epic prechart for cdi-costigan's complete-chart path; future payer APIs). Useful as a **Rosetta stone**: the SMART-on-FHIR auth handshake + scope strings Epic will demand, and the exact JSON shapes of `Condition`/`Observation`/`MedicationRequest`/`Encounter` we'd parse.
- **But it's the wrong half:** it teaches you to *expose* a FHIR API (server side); we're the *client* reading Epic. The auth flow + resource shapes transfer; the scaffold doesn't. No Epic-specifics (app registration, Epic OAuth endpoints, `$everything`/bulk export, US Core profiles), no payer prior-auth FHIR profiles (Da Vinci PAS/CRD/DTR, CARIN).
- **Verdict: reference knowledge, not a component.** When we do Epic work, pair this conceptual primer with Epic's own docs (open.epic.com / fhir.epic.com) + a real FHIR client lib.

### 4.5 Out-of-lane skills

- **`fraud-detection`** — payer SIU tool: screens an adjudicated Medicare/Medicaid claims warehouse (DuckDB) for FWA, emits cited investigation referrals. Architecturally incompatible (we have no claims warehouse; it needs a Workflow/subagent runtime). **Only transferable value = adversarial/defensive:** read its detector logic (NCCI/MUE overage, LEIE exclusions, unbundling, its D4 LCD-necessity check) as a **checklist of what makes an ortho/pain claim look anomalous**, so CDI / cdi-costigan can pre-empt those flags. Reference only — don't wire in.
- **`clinical-trial-protocol`** — drafts NIH/FDA trial protocols for investigational devices/drugs. **Zero overlap.** Skip.
- **`contracts`** (alpha) — Q&A over a local contract corpus with page-anchored citations. **Park** for a future phase: if we ever hold a library of payer / employer-WC agreements, this answers "which agreement covers ESI pre-auth turnaround." Explicitly "not for production"; adds a bun/TS runtime. No action now.

---

## 5. Prioritized roadmap

**Now / next 1–2 weeks**
1. **ICD step:** upgrade the `add-icd-codes` prompt to the `icd10-cm` methodology (Option A) — small win regardless of whether we modernize the runtime.
2. **cdi-costigan exam axis:** prototype a Costigan extraction schema with `clinical-note-extract`'s rules (ported into a single API call + our own span/terminology validation). This is the highest-value new capability — it's the missing exam/VAS/conservative-care axis.
3. Decide Option A vs B for the ICD runtime; if B, implement the `mcp_servers`+`mcp_toolset`+beta-header+`pause_turn`-loop change in `anthropicApiProvider.js` (the split pattern for accuracy).

**Next (when Engine 5 / prior-auth starts)**
4. Adapt the `prior-auth` skill into our provider-side Engine 5 (criterion-scoring schema + audit doc + letter engine; remap connectors; ingest the Noridian LCD/Article criteria once).
5. Use `get_contractors` to resolve MAC, `get_whats_new_report` (local) to detect LCD staleness.
6. NPI auto-fill for PR-2 / PA letters.

**Later**
7. CMS-Coverage one-time-ingest pipeline (download the relevant Noridian LCD+Article bodies → standards packs, since the connector can't return them).
8. Epic FHIR client (using `fhir-developer` as the primer) for cdi-costigan's complete-chart path.
9. PubMed evidence citations for borderline necessity narratives.
10. Watch the plugin's "coding validation" roadmap component.

---

## 6. Gotchas index (don't relearn these the hard way)

- **CMS Coverage returns metadata only** — `get_coverage_document` is national-only; LCD/Article bodies aren't fetchable via the connector and cms.gov 403s WebFetch. ([§2.2](#22-cms-coverage-))
- **Managed MCP connector ≠ all providers** — Anthropic-only (1P + Claude Platform on AWS + Foundry-hosted-on-Anthropic); not Bedrock/Vertex/Gemini/DeepSeek.
- **Managed MCP ⊥ HIPAA-BAA path** — can't have both today.
- **prior-auth tool names don't match ours** — remap before any reuse. ([§4.3](#43-prior-auth--payer-side-mirror-for-engine-5))
- **CMS = Medicare Part B; Costigan = WC** — LCDs are persuasive benchmark, not governing rule.
- **PubMed is on a different host** (`pubmed.mcp.claude.com`) — don't assume one base URL.
- **`clinical-note-extract` guarantees provenance, not recall** — and span-verify is verbatim, so feed it the exact transcript text.
- **Don't pin to deprecated v1 connector plugin names** — use the `hcls.mcp.claude.com/<name>/mcp` URLs.

---

_Source: live calls to ICD-10/CMS Coverage/NPI + full read of the 7 plugin skills (`/Users/rish/.claude/plugins/cache/healthcare/healthcare/2.3.1/`) + claude-api skill (managed-MCP mechanics) + adversarial verification of the payer-vs-provider, CMS-retrieval-gap, and MCP-wiring claims (all confirmed)._

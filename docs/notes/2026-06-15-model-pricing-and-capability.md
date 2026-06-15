# Model Pricing & Capability Catalogue (June 2026)

**Date:** 2026-06-15
**Companion to:** [Model & Provider Strategy](2026-06-15-model-and-provider-strategy.md)
**Basis:** verified web research (June 2026) + **real measured single-call runs** I made against the Anthropic and Google APIs on actual Sabbag and Harris cases. Pricing for non-Anthropic models is "medium confidence" (consistent across multiple 2026 sources, not cross-checked on live consoles) — **confirm on the Vertex/OpenAI/Anthropic consoles before contracting.**

> **One-line framing:** This is a **long-instruction-following + formatting-fidelity** job (pick the note type, fire ~30 conditional boilerplate blocks *verbatim*, obey length rules), **not** a medical-knowledge job. So rank on instruction-following, and let your eval framework — not any leaderboard or this doc — make the final call.

> **⚠️ UPDATE 2026-06-15 — compliance deferred.** The team has **deprioritized HIPAA/BAA for now**: the app is moving off `claude -p` regardless, and compliance will be settled *after* the model is chosen — possibly via cheap PHI **de-identification** (strip identifiers from the transcript before sending → any model becomes usable). **Consequence: nothing below is ruled out by BAA.** OpenRouter, China-hosted DeepSeek, and all open-weight models are back in scope. Read §1's BAA verdicts as a *future* consideration, not a current filter. A dedicated **open-field deep-dive + de-identification analysis is being researched and will be appended as §11–§13.**

---

## 1. Compliance / BAA — a *deferred* consideration (no longer a gate)

*(Reframed per the 2026-06-15 update above.)* Real PHI leaves the machine on every call, so this table still matters **eventually** — but it is **not** the current filter. Treat the verdict column as "what compliance work each path will need later," and note the **de-identification escape hatch** (§13, incoming): if the transcript is de-identified before the call, *every* row below — including the "disqualified" ones — becomes usable, cheaply. So the field is **not** pruned here; quality and cost (and, for Harris, speed) drive the near-term choice.

| Provider | Hosted-API BAA? | How / caveat | PHI verdict |
|---|---|---|---|
| **Anthropic** | ✅ | Direct Claude API (HIPAA-enabled org, contact sales), or via **AWS Bedrock / GCP Vertex** (cloud BAA). **`claude -p` / Claude Code CLI is NOT covered.** | **Eligible** (but not via the current CLI) |
| **OpenAI** | ✅ | Healthcare Addendum/BAA on the API (baa@openai.com), or **Azure OpenAI** (Microsoft BAA). Consumer ChatGPT not eligible. | **Eligible** |
| **Google Gemini** | ✅ | **Vertex AI ONLY.** The `GEMINI_API_KEY` consumer path (your POC + my tests) is **NOT** BAA-covered. Migration = config switch in the same SDK (`vertexai=True` + GCP project + service-account auth). | **Eligible — Vertex only** |
| **DeepSeek (first-party)** | ❌ | China-hosted, no BAA, PRC law exposure. | **DISQUALIFIED for hosted PHI** |
| **DeepSeek (open weights)** | ✅ | Only via **AWS Bedrock / Azure AI Foundry / Fireworks / Together** (their BAA, US infra). | Eligible *on a US-cloud host* |
| **OpenRouter** | ❌ | Does not sign a BAA; multi-provider routing = unbounded PHI surface. | **DISQUALIFIED for PHI** |
| **Open weights self-hosted** | N/A | PHI never leaves your hardware → BAA moot. | Eligible (you own the stack) |

**Two facts to keep for when compliance comes back on the table** (not blockers now):
1. **The `claude -p` path was never BAA-eligible anyway** — which is moot since you're leaving it regardless. If you *stay* on Claude for PHI later, the compliant path is the Messages API / Bedrock / Vertex.
2. **The Gemini POC key is the consumer tier** (works for testing — I used it — but not a PHI path). If Gemini wins on the eval, the later compliance step is a config switch to Vertex, *or* the de-identification route (§13) which keeps the cheap consumer/any endpoint.

---

## 2. Verified pricing (USD per 1M tokens, June 2026)

Flagship **and** cheapest-usable tier per vendor. "Cheapest usable" excludes SKUs below the instruction-following bar for an 85-heading template (Haiku, nano, flash-lite — usable for drafts, not as the primary scribe).

| Family | Tier | Model | Input | Output | Cache-read | Context | Confidence |
|---|---|---|---|---|---|---|---|
| **Anthropic** | flagship | Claude **Opus 4.8** | $5 | $25 | $0.50 | 1M | ★ strong |
| | mid (default) | Claude **Sonnet 4.6** | $3 | $15 | $0.30 | 1M | ★ strong (current default) |
| | cheap | Claude Haiku 4.5 | $1 | $5 | $0.10 | 200K | ★ (below bar for Sabbag) |
| | — | Claude Fable 5 | $10 | $50 | $1 | 1M | ⚠️ forces 30-day retention → **not for ZDR PHI**, overkill |
| **Google** (Vertex) | flagship | Gemini 3.1 Pro | ~$2 | ~$12 | ~$0.13 | 1–2M | ◐ medium |
| | cheap | Gemini **3.5 Flash** | ~$1.50 | ~$9 | ~$0.15 | 1M | ◐ medium (what I tested) |
| | cheaper | Gemini 3 Flash / 2.5 Flash | $0.30–$0.50 | $2.50–$3 | ~$0.03 | 1M | ◐ medium |
| **OpenAI** | flagship | GPT-5.5 | $5 | $30 | ~$0.50 | ~1M | ◐ medium |
| | mid | GPT-5.4 | $2.50 | $15 | $0.25 | ~1M | ◐ medium |
| | cheap | GPT-5.4 mini | $0.75 | $4.50 | $0.075 | 400K | ◐ (verify on eval) |
| **DeepSeek** | flagship | V4 Pro | ~$0.44 | ~$0.87 | — | 1M | ◐ — **BAA-disqualified hosted** |
| | cheap | V4 Flash | $0.14 | $0.28 | — | 1M | ◐ — **BAA-disqualified hosted** |
| **Open-weights** | flagship | Llama 4 Maverick / Qwen 3.5 / Mistral Large 3 | $0.27+ / self-host | $0.85+ | — | 128K–1M | ◐ — BAA only via US-cloud host or self-host |

Caching note: all three majors discount cached input ~90%. Your **~21k-token per-doctor template is the cacheable part** — wiring caching to it is the single biggest cost lever (halves real per-note cost). Anthropic prompt caching **is** HIPAA-eligible.

---

## 3. Cost for *this* workload — measured + projected

The headline numbers come from **real calls I made**, not estimates. Single-call, no cross-call caching (each was a cold call):

| Model / mode | Case | input tok | output tok | latency | **cost/note** |
|---|---|---|---|---|---|
| **Agentic `claude -p`, Sonnet** (baseline) | Sabbag (avg) | 943 +226k cache | ~28,000 | ~523 s | **$0.755** |
| **Agentic `claude -p`, Sonnet** | Harris (avg) | — | ~12,900 | ~233 s | **$0.503** |
| Single-call Sonnet 4.6 (no think) | Sabbag (hardest) | 33,102 | 3,663 | ~40 s | **$0.154** |
| Single-call Sonnet 4.6 (no think) | Harris (fisher_beth) | 16,162 | 2,836 | 64 s | **$0.091** |
| Single-call Sonnet 4.6 (think on) | Harris | 16,191 | 4,486 | 95 s | **$0.116** |
| Single-call Gemini 3.5 Flash (think on) | Sabbag | 31,057 | 2,350 +7,447 think | 52 s | ~$0.03 |
| **Single-call Gemini 3.5 Flash (think off)** | Harris | 15,546 | 1,631 | **10.6 s** | **~$0.01** |

**Projected per-note cost with the template cached** (~21k cached + ~2.5k transcript + ~1.7k out), from research:

| Model | uncached/call | **cached/call** |
|---|---|---|
| Gemini 3.x Flash | ~$0.017 | **~$0.008** |
| GPT-5.4 | ~$0.087 | ~$0.034 |
| Claude Sonnet 4.6 | ~$0.097 | **~$0.040** |
| Claude Opus 4.8 | ~$0.161 | ~$0.066 |
| GPT-5.5 | ~$0.173 | ~$0.067 |

**Conclusions:**
- The **architecture change (agentic→single-call) is worth ~5–8× on its own**, on the same model. That's the big, model-independent win.
- Across single-call models the per-note delta is **cents**. At your volume (~16 notes/day/doctor), even the dearest (Opus) vs cheapest (Gemini Flash) is a few dollars/day/doctor. **Quality, not price, should decide** — one mis-fired boilerplate block in a clinical/legal record costs more than months of the price gap.
- Gemini Flash is genuinely ~10× cheaper than Sonnet and (think-off) ~6× faster — its value is **latency for Harris**, not the marginal cost saving.

---

## 4. Capability ranking for *this* job

Gated to BAA-eligible-or-self-hostable, ranked on **long-instruction-following + SOAP-fidelity evidence** (not medical QA — frontier models all clear the medical-accuracy floor; medical-QA leaderboards are a trap here, topped by self-host-only/BAA-disqualified models).

1. **Claude (incumbent) — top pick.** Strongest long-form instruction-following evidence (Arena-IF leader; "produces coherent long-form prose without drifting over long outlines" — directly the 85-heading-template skill). BAA-eligible, already wired. **Split: Sonnet 4.6 as the production default; Opus 4.8 reserved for the hardest templates** (Sabbag) if Sonnet misses blocks in your eval.
2. **Gemini 3.1 Pro / 3.x Flash — strong co-leader, best value.** IFEval ~95; Flash is the cheapest BAA-eligible option. **BAA only via Vertex.** My tests back this: Gemini Flash matched/beat single-call Sonnet on Sabbag boilerplate. A must-include on your eval.
3. **GPT-5.x — competitive, with a sharp caveat.** Best *measured* SOAP score in the literature — **but only in non-reasoning mode** (see §5). Pin to non-reasoning if trialed. GPT-5.4 is the value tier.
4. **DeepSeek — strong on paper, BAA-disqualified hosted.** Only viable self-hosted (then it competes with open-weights).
5. **Open-weights (Qwen 3.5 / Llama 4 / Mistral) — only if self-hosting for data-sovereignty.** Qwen 3.5 tops open IFEval, but generic open-weights underperform tuned models on note fidelity by 100%+ (SpecialtyScribe) — budget tuning + a GPU. Choose for sovereignty, not out-of-box quality.

### 5. The reasoning/thinking finding — and a real tension to resolve on your eval

The most on-point study ("When Reasoning Hurts", 2026, SOAP-specific) found **reasoning-enabled models did *worse* at SOAP generation** — reasoning-on GPT-5.4 was the *worst* config tested; non-reasoning was best. Hypothesis: extended thinking "improves" prose by **paraphrasing**, which is exactly what **breaks verbatim boilerplate** and length caps.

**But my own bake-off shows the opposite on the hardest case:** on Sabbag, Gemini *with* thinking caught the injection cure-rate dot-phrase that Sonnet *without* thinking missed. On Harris (simpler template), thinking made little structural difference.

Both can be true: **thinking may improve boilerplate *recall* while hurting verbatim *fidelity* (via paraphrasing).** This is unresolved and exactly what your eval must measure per-doctor — score **verbatim-block hit-rate** AND **paraphrase/length violations** separately. **Treat thinking as a per-doctor dial, not a global on/off.** (Default hypothesis to test: think-on for high-boilerplate templates like Sabbag, think-off for simpler/faster ones like Harris.)

---

## 6. Latency / speed — the Harris "fast mode" axis

Harris needs 5 charts in ~15 min (~3 min/note budget). The blocker today is the **agentic loop (~233 s/note)**. Single-call fixes it outright. Measured latencies:

| config | latency/note | 5 notes |
|---|---|---|
| Gemini Flash, think-off | **10.6 s** | ~1 min |
| Sonnet 4.6, think-off | 64 s | ~5 min |
| Gemini Flash, think-on | 51 s | ~4 min |
| Sonnet 4.6, think-on | 95 s | ~8 min |
| *(agentic `claude -p` today)* | *~233 s* | *~19 min — misses the window* |

**Implication:** once you're single-call, *every* config clears Harris's window. **Generation is no longer the bottleneck — transcription latency is** (hence the ElevenLabs-streaming idea is the right lever for him). A future **"fast mode" toggle** (Gemini Flash think-off + streaming transcription) vs **"accurate mode"** (Sonnet/Opus, think-on, full transcript) is a clean per-doctor or per-session option.

---

## 7. ICD-10 — replacing the Claude-only MCP connector

The current `icd10` connector (`hcls.mcp.claude.com`) is **Anthropic-operated, Claude-account-gated, and not callable by a non-Claude orchestrator** — and it just serves the same **public-domain CMS data** you can ship yourself. So:

**★ Recommended: bundle the offline CMS FY2026 dataset.**
- Ship `icd10cm-order-2026.txt` (from the public-domain [CMS Code Descriptions zip](https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/2026/)). One fixed-width file, ~75k codes, ~15 MB. Load into a `Map<code,{billable,shortDesc,longDesc}>` at startup → exact parity with the connector's `validate_code` + `lookup_code`, offline, zero PHI exposure, public-domain (clean license).
- **Python** (you already spawn Python): `simple-icd-10-cm` (MIT, maintained, v1.5.0) adds hierarchy/Excludes/version-switching via a `validate_icd.py` sidecar.
- **Node**: no good package (the npm options are description-only or ~2024-stale) — parse the order file yourself.
- **Online fallback** (fuzzy description search only): [NLM Clinical Tables API](https://clinicaltables.nlm.nih.gov/apidoc/icd10cm/v3/doc.html) — free, no key, **but send diagnosis terms only, never PHI** (their rule).
- Refresh annually after Oct 1 (new codes); light April check if you surface coding guidance (Excludes/sequencing).

Fallback if you don't want to build it yet: **keep ICD on Sonnet API** (the model proposes; you validate later). Cheap (tiny output) and zero migration.

---

## 8. Skill portability — sizing the migration

- **Note generation = near-free vendor swap.** Skill text → system prompt; template+transcript → user turn; one call; app parses the manifest tail. Identical on Anthropic Messages, OpenAI Responses/Chat, Gemini `generateContent`, and OpenAI-compatible open-weight servers. **Budget hours, not weeks.** (My Sonnet + Gemini tests both ran the *unmodified* `SKILL.md` + a preamble.)
- **The JSON manifest contract survives two ways:** the existing **tail-parse** (works on every vendor, zero dependency — keep as baseline) or **native structured output** (now on OpenAI, Gemini, *and* Anthropic — Claude added Structured Outputs in late-2025/2026, so "Claude has no JSON mode" guides are stale).
- **CDI / ICD skills = the real work**, because they call the MCP connector mid-loop. But MCP is now cross-vendor (OpenAI Responses API + Gemini SDK both support remote MCP), so it's a *porting task, not a blocker* — or fold ICD lookup app-side (§7). Don't size these as free.
- **Function/tool-calling parity is high** across all vendors; only the schema dialect differs (Anthropic `input_schema` vs OpenAI `parameters` vs Gemini OpenAPI subset). Mechanically minor.
- ⚠️ The **SKILL.md folder format** is portable across *coding-agent* surfaces (Codex CLI, Cursor, Gemini CLI) but **not** the hosted APIs you'd actually call — don't anchor the plan on it.

---

## 9. The Anthropic API platform (point 8 — stay-vs-move, and you need it regardless)

You'll need the Anthropic API no matter what (Opus for template create/update). What it offers for this app:

- **Messages API** — the single-call replacement for `claude -p`. HIPAA-eligible.
- **Prompt caching** — ~90% off the cached template; HIPAA-eligible; the main cost lever.
- **Extended/adaptive thinking + effort** — the per-doctor quality dial (§5). Eligible.
- **Structured Outputs** — grammar-constrained JSON for a hard manifest guarantee (§8). Eligible.
- **1M context, `inference_geo:"us"`** (US-pinned processing, +10%, HIPAA-eligible).
- **Batch API** (50% off) — *not* HIPAA-eligible, and not useful for real-time scribing, but handy for **offline eval runs** over your 473 reference notes.
- **NOT HIPAA-eligible:** Files API, code execution, **MCP connector**, Managed Agents, web fetch, computer use, Batch. So the agentic/connector features you'd lean on are exactly the ones excluded for PHI — another reason the single-call + offline-ICD architecture is the compliant one.

**The June 15 2026 billing change:** subscription `claude -p` / Agent SDK calls now draw from a **separate capped credit pool** ($20/$100/$200 per plan, no rollover, then full API rates). So continuing on the CLI is both **non-compliant for PHI** and **economically capped**. The decision: **move note-gen to the Messages API regardless**; *then* decide whether a cheaper/faster vendor (Gemini-on-Vertex) beats Anthropic on your eval. Keep Anthropic in the stack for Opus templates either way.

---

## 10. Bottom line / what to put on the eval

1. **Gate on BAA first** → Claude, GPT-5.x, Gemini-**on-Vertex** are eligible; DeepSeek-hosted and OpenRouter are out; open-weights only self-hosted.
2. **Architecture beats model for cost** (~5–8× from single-call alone); across models the per-note delta is cents → **decide on quality**.
3. **Rank on instruction-following, not medical QA.** Put **Sonnet 4.6, Gemini 3.x Flash/Pro (Vertex), optionally GPT-5.4 (non-reasoning)** on your eval against the real 85-heading Sabbag template.
4. **Score per-doctor:** note-type accuracy, **verbatim-block hit-rate**, per-section length compliance, omission, hallucination — and **thinking on vs off as a variable** (the literature says it can hurt; my Sabbag test says it can help — resolve it empirically).
5. **ICD:** bundle the offline CMS dataset; Sonnet-for-ICD as the stopgap.
6. **Migration sizing:** note-gen swap = hours; CDI/ICD = real but unblocked work.

> Non-Anthropic prices are medium-confidence (2026 pricing blogs, not live consoles). Verify on Vertex/OpenAI/Anthropic consoles and confirm BAA terms before contracting. Anthropic prices and all latency/token figures in §3 are either from primary docs or my own measured runs on 2026-06-15.

# Model & Provider Strategy — AI Medical Scribe

**Date:** 2026-06-15
**Author:** Rish + Claude (analysis grounded in the live Sabbag and Spencer/Tsai `app.db` data, the two `Run-claude-skill-using-alternatives` / `Elevenlabs-streaming` POCs, and one real single-call API test on Sonnet 4.6)
**Status:** Decision input — not yet a committed plan
**Companion doc:** [Model Pricing & Capability Catalogue](2026-06-15-model-pricing-and-capability.md) (the per-vendor price/BAA/capability tables)

---

## 0. TL;DR — the recommendation in five lines

1. **There are two independent decisions, not one.** (A) *Architecture*: the agentic `claude -p` loop → a single API call. (B) *Provider/model*: Anthropic → someone else. Decide them separately and in that order.
2. **Axis A is where the money is, and it's the low-*model-risk* move.** Going single-call is **~5× cheaper per note on the same model** (measured: $0.755 → $0.154 on Sabbag's hardest case). You can do it **on Claude (same model = known quality, no capability gamble)** — but note it is *not* integration-free: single-call means leaving the throttled `claude -p` subscription CLI for the Anthropic **Messages API** (pay-as-you-go key). That API move happens regardless of which vendor you pick (see §1.1).
3. **Axis B (cheaper/other model) is capability-gated, not price-gated.** Sabbag's template is the bar. Pick the model with your eval framework, not with the price chart.
4. **Your skills port with minimal edits.** Your POC *sketches* the pattern (a "single-call mode" preamble in front of the existing `SKILL.md`, app does file IO + manifest parse) — it wasn't quality-tested. **Today's single-call tests are the actual evidence** (§4.2): both Sonnet 4.6 and Gemini 3.5 Flash produced structurally faithful Sabbag notes from that exact pattern. It's vendor-agnostic.
5. **The only genuinely Claude-coupled piece is ICD-10** (the claude.ai MCP connector). Replace it with a bundled offline CMS ICD-10-CM dataset; keep "Sonnet API just for ICD" as the cheap fallback.

**Suggested sequence:** single-call on Sonnet (prove quality + bank the 5× saving) → trim the Sabbag template → bake-off cheaper capable models behind the eval framework → migrate note-gen to the winner → handle ICD/CDI separately.

---

## 1. Why split into two axes

The instinct is "swap Sonnet for something cheaper." But the cost data shows the **architecture**, not the model, is the dominant cost driver — and architecture can be changed without touching the model. Conflating them means taking a capability risk (new model) to get a saving that's mostly available *without* that risk (new architecture).

| Axis | What changes | Cost impact | Risk | Reversible? |
|---|---|---|---|---|
| **A. Architecture** — agentic loop → single call | How we *call* the model (one shot, inputs inline, app does IO) | **~5× cheaper** (measured) | Low — same model, quality measurable up front | Yes, trivially |
| **B. Provider/model** — Claude → Gemini/GPT/open | *Which* model answers | Further savings, model-dependent | Higher — capability + HIPAA + integration | Yes, but more work |

Do **A first on Claude** (known quality, immediate saving), then **B** as a measured, gated follow-up.

### 1.1 The two axes are more coupled than they look (important)

The current architecture runs on the **Claude Code subscription CLI** (`claude -p` + `claude login`). As of June 2026 those subscription calls are being throttled / drawn from a separate small credit pool (see catalogue §Anthropic). **So the moment you go single-call, you have to leave the subscription CLI and integrate the Anthropic Messages API with a pay-as-you-go key anyway.**

Consequence: **the effort to wire "single-call on Anthropic API" is ≈ the effort to wire "single-call on Gemini/OpenAI"** — both are an HTTP call behind the existing `provider.js` seam. (ICD is the one exception — see §6.) So Axis A and Axis B aren't sequential-cheap-then-expensive; they collapse into nearly one integration. "Claude-first" therefore survives as a **quality/risk anchor** (start with the model you already trust, prove single-call holds, *then* swap the model as a config change) — **not** as "the cheaper-to-build option."

Two upsides fall out of this:
- **Future-user setup gets dramatically simpler.** No bundled Claude Code CLI, no `claude login`, no skills-sync — just an API key (or a backend proxy) in settings. This alone is a strong reason to make the move.
- **You'll need the Anthropic API regardless** for Opus template-create/update (§2), so an API integration is on the roadmap no matter what.

---

## 2. What the app actually asks a model to do

Every model-consuming task in the app today (and the two planned ones). Each is a separate decision — they do **not** all need the same model.

| Task | Skill | Frequency | Difficulty | Notes |
|---|---|---|---|---|
| **Note generation** | `generate-note` | **Every case, all day** — the critical path | **High** (Sabbag) → medium (Spencer/Tsai) | The one that must be right and cheap. Drives ~all the cost. |
| **Pre-chart / edit-note** | `edit-note` | Occasional | High | Folds prior records into a note; quality-sensitive. |
| **ICD-10 coding** | `add-icd-codes` | Per case (if enabled) | Medium, **but Claude-coupled** | Uses the claude.ai ICD-10 MCP connector. The hard one to port. |
| **CDI review** | `cdi-review` | Per case (if enabled) | High | Reasoning + ICD validation; ortho-only in v1. |
| **Template create** | `create-doctor-profile` | Rare (new doctor) | Very high | One-time. Can stay on the most capable model (Opus API). |
| **Template update** | `update-doctor-profile` | Rare | High | One-time-ish. Same as above. |
| **Patient card** *(planned)* | — | TBD | Low–medium | Summarisation; cheap model likely fine. |
| **E/M score** *(planned)* | — | TBD | Medium | Rule-based scoring; needs reliable reasoning, small output. |

**Key consequence:** template create/update and (probably) CDI can stay on a premium Claude model because they're rare or hard. Note-gen is the only task whose cost and cadence justify aggressive optimisation. **Optimise note-gen first; treat the rest case-by-case.**

### 2.1 Two delivery profiles (accurate vs. fast) — the Harris case

Note-gen has **two latency profiles**, not one:
- **Accurate mode** (most doctors — charts next day): maximise fidelity. Sonnet/Opus, thinking on for hard templates, full transcript.
- **Fast mode** (Dr. Harris — 5 charts signed in ~15 min, ~3 min/note): minimise latency. The blocker today is the agentic loop (~233 s/note); **single-call fixes it outright** — every measured single-call config clears Harris's window, and Gemini Flash (thinking-off) does a note in **~10 s**. Once single-call, **generation is no longer Harris's bottleneck — transcription latency is** (the case for ElevenLabs streaming for him specifically).

This argues for a **per-doctor (or per-session) "fast / accurate" toggle** in the app rather than one global model. Measured latency/quality numbers are in [catalogue §3 + §6](2026-06-15-model-pricing-and-capability.md).

### The capability bar: Sabbag's template

Sabbag's template (`sabbag.md`) is **1,028 lines / ~21k tokens / 85 headings**: three full note-type sub-templates (WC PR-2 follow-up, WC PR-1 initial, Private follow-up), **~30 named boilerplate blocks each with a trigger condition** that must be emitted *verbatim* when triggered, dot-phrases, and conditional inference rules. The model must (1) select the right note type, (2) fire the right boilerplate when its trigger is met, (3) obey strict per-section length rules. This conditional-instruction-following is what collapsed on Haiku and is the bar any replacement must clear. (Spencer/Tsai at ~700–740 lines are materially easier — a model that's marginal on Sabbag may be fine for them.)

---

## 3. The real cost picture (from your live data)

Two scribes' `app.db` files, `processing_events` table — real model, tokens, and computed cost per task. (`cost_usd` is what the run *would* cost at Anthropic pay-as-you-go rates; today it's paid via the Claude subscription, but the number is the right basis for comparing providers.)

### 3.1 Per-note cost, agentic `claude -p`, Sonnet 4.6

| Practice | Template | avg **output** tok/note | avg cache-read tok/note | avg turns | avg time | **avg cost/note** |
|---|---|---|---|---|---|---|
| **Sabbag** | 1,028 ln | **28,317** | 226,168 | 8.7 | 523 s | **$0.755** (max $1.44) |
| **Spencer/Tsai** | ~720 ln | **9,563** | 197,096 | 9.2 | 168 s | **$0.346** |

Same model, same ~9-turn agentic pattern. The 2.2× cost gap between practices is driven **purely by template/note complexity** → more agentic output. (n: 129 + 96 successful notes.)

### 3.2 Where the agentic cost actually goes

The note itself is only **~1,276 words / ~1,700 tokens** (median 1,242). But each agentic run emits **~28,000 output tokens (Sabbag)**. That ~16× gap is the agentic harness, not the note:

- The `claude -p` loop runs ~9 turns (read template → read transcript → think → write → self-check → emit manifest).
- It **re-reads the cached ~21k-token template + transcript on every turn** → ~226k cache-read tokens/note.
- Extended thinking + tool-call plumbing inflate output token counts.

Rough decomposition of Sabbag's $0.755 (at $3/$15 per-Mtok + cache): output ~$0.42 + cache-creation ~$0.25 + cache-reads ~$0.07. **Output dominates** — and output is mostly agentic overhead.

### 3.3 What single-call does to that

A single API call sends template + transcript **once** and gets the note back. No 9-turn loop, no ~226k cache re-reads, output ≈ note size. Measured below: **3,663 output tokens, $0.154/note** — the agentic overhead simply evaporates.

---

## 4. The architecture lever: agentic → single-call

### 4.1 Your POC sketches this pattern; today's tests are the evidence

> Correction (per your note): the POC didn't *prove* anything — it wasn't given a proper quality run. It demonstrates the **mechanism**. The validation is §4.2's live tests.

`Run-claude-skill-using-alternatives/app.py` runs `generate-note` as **one Gemini call**:

- It prepends a **`MODE: SINGLE-CALL — no tools`** preamble to the *existing, unmodified* `SKILL.md` (telling the model to skip the agentic Steps 0/2/3/5a/6 — the bash/file-IO/permission steps — and perform only the reasoning Steps 1/4/5b/5c/7).
- It **reads the template + transcript in Python** and injects them inline.
- The **app saves the note and parses the same single-line JSON manifest** the skill already emits.

That's the whole pattern: *skill text → system prompt; inputs → user message; app does the IO and manifest parsing.* It's vendor-agnostic. Today's tests (§4.2) confirm the pattern produces faithful notes on two different vendors — i.e. your skill investment survives the migration with a preamble, not a rewrite.

### 4.2 Empirical test — single-call Sonnet on Sabbag's hardest case (n=1)

I ran exactly this, once, against the **Anthropic API** (`claude-sonnet-4-6`, no tools, no extended thinking) on the largest Sabbag note on record (`gail_kerr_belansky`, a Private Follow-Up with a 7-problem A&P), and compared it to the on-disk production note.

**Cost / shape:**

| | Agentic (production) | **Single-call (test)** |
|---|---|---|
| input tokens | 943 (+226k cache-read) | 33,102 |
| output tokens | ~28,000 | **3,663** |
| cost/note | $0.755 | **$0.154** |
| wall time | ~523 s | ~40 s |

→ **~5× cheaper, ~13× faster, on the same model.**

**Quality (read the full note, not just regex):**

- ✅ **Correct note-type selection** (Private Follow-Up).
- ✅ **All physical-exam boilerplate verbatim** (Cervical Spine, Bilateral Shoulders/Elbows, Neurologic, Vascular, JAMAR block).
- ✅ **Biopsychosocial paragraph, both attestations, signature block** — all present and exact.
- ✅ **Accurate, self-aware JSON manifest** — it correctly returned `status:"partial"` and listed precise placeholders/warnings (missing visit date, MRN, DOB, JAMAR readings, **and that no prechart was supplied**).
- ⚠️ **One genuine miss:** the injection cure-rate rationale dot-phrase ("first injection has a 60% chance of long-term cure" / second 50%) was **not** fired. That's a triggered boilerplate block the template defines — a real, fixable adherence gap.
- ⚠️ **LOS billing line** was left as an explicit `[... 99214/99215 +25 ... insert .KS14/.KS15 ...]` placeholder rather than filled. Defensible (the code wasn't dictated) and flagged — but the production note filled it.

**Important confound (in single-call's favour):** the on-disk production note has ~10 dated `[INTERVAL]` history blocks back to 2024 and per-problem dated stacks. **The transcript does not contain that history** (it's a single 2,047-word visit that only references "last here November 12, 2025"). That longitudinal content came from a **prechart / prior-records ingestion or a manual scribe edit — not from `generate-note`.** The single-call test only had transcript + template (exactly what `generate-note` gets), correctly detected the absence, and flagged `prechart_not_provided`. So the apparent "thin history / 5-vs-7 problems" gap is **mostly an input artifact, not model weakness** — an apples-to-apples `generate-note` run (agentic, same inputs) would also lack that history.

**Verdict:** On the hardest case, single-call Sonnet is **structurally faithful and ~5× cheaper**, with a real-but-modest boilerplate-adherence gap (one missed triggered dot-phrase, occasional under-firing). This is **not** a Haiku-style collapse. The gap is the kind that closes with: (a) extended thinking enabled, (b) a light second "self-check against the triggered-boilerplate checklist" pass, or (c) clearer machine-checkable triggers in the template. **n=1 — directional, not conclusive. The eval framework is the real arbiter and must gate this before it ships.**

### 4.3 What single-call gives up, and how to get it back

The agentic loop's hidden value is **self-correction**: extra turns re-scan the template and catch missed boilerplate. Single-call does one pass. Mitigations, cheapest first:

1. **Enable extended thinking** on the single call (still one call; recovers most of the reasoning headroom; modest output-token cost).
2. **Two-pass single-call:** generate, then a cheap second call "here's the note + the template's trigger list — add any boilerplate whose trigger is met and is missing." Still ~10× cheaper than the 9-turn loop.
3. **Template trimming** (§7) makes triggers explicit and easier to fire in one pass.
4. Keep the agentic path available as a per-doctor fallback for the few hardest templates if the eval says so.

---

## 5. The provider/model axis (Axis B)

Pricing, BAA, residency, and capability tables are in the [companion catalogue](2026-06-15-model-pricing-and-capability.md). The decision rules:

### 5.1 HIPAA/BAA — deferred (decision update 2026-06-15)

Originally I framed BAA as the first filter. **The team has since deprioritized compliance**: the app is leaving `claude -p` regardless, and compliance gets settled *after* the model is chosen — likely via cheap PHI **de-identification** (strip identifiers from the transcript → any model, including no-BAA/China-hosted/OpenRouter, becomes usable). So the near-term choice is driven by **quality, cost, and (for Harris) speed**, with compliance as a known, scoped follow-up. The full reopened field — open-weight models, OpenRouter, fast-inference platforms, and the de-identification round-trip — is in the [catalogue §11–§14](2026-06-15-model-pricing-and-capability.md). Facts still worth carrying forward (not blockers now):

- **Your POC's Google path is almost certainly not BAA-covered.** `google-genai` + `GEMINI_API_KEY` = Google AI Studio (consumer/dev tier). Production-compliant Gemini = **Vertex AI** (GCP, with a BAA). If you go Gemini, budget for the Vertex path, not the AI Studio key in the POC.
- **DeepSeek's first-party API is China-hosted** — treat raw DeepSeek as a non-starter for PHI. If you want DeepSeek's economics, run its open weights on a **US-hosted, BAA-signing platform** (Bedrock/Azure/Together/Fireworks), not `api.deepseek.com`.

The catalogue branches on this: *if BAA required* → a short shortlist (Anthropic, OpenAI, Gemini-on-Vertex, models on Bedrock/Azure). *If you decide PHI de-identification or a self-hosted model removes the BAA requirement* → the field widens (OpenRouter, raw DeepSeek, open weights).

### 5.2 Capability is the gate; the eval framework picks the winner

Benchmarks (MedQA/HealthBench/IFEval, see catalogue) are **necessary but not sufficient** — they don't measure "fires Sabbag's 30 boilerplate triggers verbatim." Your in-progress SOAP eval framework is the real arbiter. Protocol in §8.

### 5.3 Model choice is per-task and independent of provider

Each engine already declares its own model (`model: (cfg) => cfg.soapModel`, etc.). You can run **note-gen on a cheap capable model, template-create on Opus, ICD on Sonnet** simultaneously — mix freely. Don't assume one model for everything.

---

## 6. The ICD-10 problem (the one genuinely Claude-coupled piece)

`add-icd-codes` and `cdi-review` validate/search ICD-10-CM codes via the **claude.ai-hosted ICD-10 MCP connector**, which only works inside Claude. A Gemini/GPT single-call has no such connector. Options (detail + URLs in the catalogue):

1. **★ Recommended — bundle the official CMS ICD-10-CM FY2026 dataset locally.** It's public-domain, a small flat file (~all ~95k codes), shipped with the app. The model *proposes* codes; a deterministic local lookup *validates* them. No connector, no per-call cost, works offline, provider-independent, and it's actually *more* reliable than the connector (ground-truth table vs. a tool call). This is the clean de-coupling.
2. **Hosted ICD API** (NLM Clinical Tables is free) — simplest, but a network dependency and rate limits.
3. **Keep ICD on Sonnet API** — the fallback you already named. Cheap (ICD output is tiny) and zero migration. Fine as a stopgap while #1 is built.

CDI is downstream of ICD and is rarer/harder — keep it on a capable model and let it consume the same local validation.

---

## 7. Template trimming (a lever orthogonal to everything above)

Sabbag's ~21k-token template is sent on **every** note call — it's the dominant *input* cost and the main thing a weaker model has to track. Trimming compounds with both axes:

- **Cost:** smaller input on every call (single-call input is ~33k tok, of which ~21k is the template).
- **Quality:** fewer, clearer, machine-checkable triggers → weaker/cheaper models adhere better and miss less boilerplate in one pass.
- It's safe, incremental, and doesn't depend on any model decision. Worth a focused pass on Sabbag specifically (it's 1.4× the size of the others and 2.2× the cost).

---

## 8. Recommended sequence + a cheap evaluation protocol

**Phase 1 — Architecture (on Claude, low risk).** Implement single-call `generate-note` behind the existing LLM seam (a `singleCallProvider` alongside `claudeCliProvider`). Same Sonnet model. Wire the app to read template+transcript and parse the manifest (your POC is the reference implementation). Bank the ~5× saving immediately.

**Phase 2 — Eval gate.** Run the SOAP eval framework on N real cases (mix of Sabbag hard + Spencer/Tsai easy) comparing single-call vs. the agentic baseline. Define a pass bar (boilerplate-trigger recall, structure, note-type accuracy). Tune with extended thinking / two-pass if needed.

**Phase 3 — Provider bake-off (gated).** Only once single-call-on-Sonnet passes: run the *same* eval harness against BAA-eligible candidates (catalogue shortlist) on the *same* cases. Pick by quality-per-dollar, not price alone. Keep template-create on Opus.

**Phase 4 — ICD/CDI de-coupling.** Bundle the CMS ICD-10-CM dataset; move ICD validation off the connector. Decide CDI's model independently.

**The eval protocol is cheap and you already have the pieces:** real transcripts + 473 reference notes on disk + a single-call harness (this doc's test is a working one-call example). A few dollars of API spend per candidate model buys a decisive answer.

---

## 9. Open questions for you

1. **BAA: hard requirement or not?** This is the single biggest fork. (Assumption in the catalogue: yes, required.) If you're planning PHI de-identification or a future backend proxy, that changes the shortlist.
2. **Subscription vs. API for Claude going forward** — the June 2026 subscription-credit change (see catalogue) affects whether keeping any Claude usage on `claude -p` still makes sense vs. moving to pay-as-you-go API keys.
3. **Single-call provider seam** — want me to draft the `singleCallProvider` against the existing `provider.js` interface so Phase 1 is a drop-in? (No monolith edits; it's one new file + a settings toggle.)
4. **Eval framework status** — when it's ready, I can wire the bake-off harness (Phase 2/3) to run candidates over your real cases automatically.

> All cost figures are from the live `app.db` data and one real Sonnet API call on 2026-06-15. The single-call quality finding is **n=1** and directional — treat the eval framework, not this doc, as the decision authority on quality.

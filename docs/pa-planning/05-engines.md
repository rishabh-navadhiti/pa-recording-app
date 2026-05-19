# PA Engines — Specification & Delivery Tracking

Detailed reference for each engine in Fahd's Physician Assist vision (the 8 engines + Auto-Pilot orchestrator). This document serves two purposes:

1. **Understanding** — what each engine is, what it reads, what it writes, how it differs from the others
2. **Tracking** — for the engine actively being built (CDI Co-Pilot at the time of writing), an explicit sub-features list with status markers so we know what's shipped, what's deferred, and what's deliberately not in scope

For engines not yet under active development, only the description is filled in. Sub-features list and statuses get added when that engine becomes the active deliverable.

---

## Status legend

| Marker | Meaning |
|---|---|
| 🟢 | **In scope for v1** — actively being built |
| 🟡 | **Deferred to v1.1** — punt to a follow-up cycle once v1 is shipping |
| 🔵 | **Deferred to Phase 2+** — important but later |
| ❌ | **Out of scope** — deliberately not building |
| ⚪ | **TBD** — pending decision (default for sub-features before v1 scoping is finalized) |
| ✅ | **Shipped** — built, merged, in production |

---

## Engine 1 — CDI Co-Pilot 🔍

**Status:** Active — v1 in scoping

**One-liner:** Reviews the clinical note for documentation gaps that affect coding specificity, billing, and audit defense — and produces structured flags with evidence and suggested codes.

**Reads:**
- AI-generated SOAP note
- Original transcript (audio dictation — our advantage over Fahd's pipeline; lets us recover detail lost between dictation and structured note)

**Writes:** Structured CDI review document (markdown, convertible to .docx) — landed alongside the SOAP note in the case folder as `<case>_cdi.md`.

**The defining question:** *"Is every diagnosis coded to the highest specificity supported by the documentation, and are there any documentation gaps that would put a claim at risk?"*

### Sub-features (deliverables)

These are the individual capabilities that make up "CDI." Status markers reflect provisional v1 scoping; finalised during the v1 scoping discussion.

#### Core gap-flagging

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.1 | Generate flags with type (`critical` / `warning` / `suggestion`) | ⚪ | The fundamental output. Without this nothing else matters. |
| 1.2 | Per-flag `title` (short) + `body` (1-2 sentence rationale with guideline reference) | ⚪ | |
| 1.3 | Per-flag `evidence_found` (max 4 specific findings from note) | ⚪ | What the note already supports — lets scribe verify quickly |
| 1.4 | Per-flag `evidence_missing` (max 4 items not yet documented) | ⚪ | What's needed to upgrade the code |
| 1.5 | Per-flag `suggested_codes` (1+ ICD-10 codes with descriptions) | ⚪ | Anchored against an ICD-10 source (either the existing connector or a static list) |
| 1.6 | Per-flag `confidence` score (0-100) | ⚪ | Drives confidence-gated routing (see 1.10) |
| 1.7 | Cap on flags per analysis (e.g. 6 in balanced mode) | ⚪ | Prevents flooding the scribe |
| 1.8 | Specialty-aware ruleset selection (doctor's specialty drives which CDI rules fire) | ⚪ | Requires `doctors.specialty` field (now planned in SQLite design) |

#### ICD-10 specificity checks

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.9 | Laterality (left/right/bilateral) | ⚪ | Highest-volume gap type for ortho |
| 1.10 | Severity | ⚪ | Mild/moderate/severe; relevant for many conditions |
| 1.11 | Acuity (acute / chronic / acute-on-chronic) | ⚪ | Drives Chapter 13 vs 19 selection in ortho |
| 1.12 | Stage | ⚪ | E.g. KDIGO stage for AKI; CMC stage II/III/IV for thumb arthritis |
| 1.13 | Body part / anatomical specificity | ⚪ | "Trigger finger" → which finger; "shoulder" → which structure |
| 1.14 | 7th character (encounter type: A/D/S for injuries; B/C for open fractures) | ⚪ | Required on injury codes |
| 1.15 | Symptom vs definitive Dx logic (Sec IV.H — outpatient uncertain diagnosis rule) | ⚪ | "Probable", "rule out", "possible" should code as symptoms, not the condition |
| 1.16 | Coexisting conditions coding (Sec IV.J — all documented conditions affecting care) | ⚪ | High-value: catches Sabbag-type "Marx has 3 EMG conditions but only 1 in Assessment" gaps |
| 1.17 | Diagnosis-to-procedure linkage check (ICD supports CPT) | ⚪ | E.g. trigger release CPT must be supported by trigger-finger ICD |
| 1.18 | "With" convention recognition (Sec I.A.15 — combo codes like HTN+CKD) | ⚪ | Combination codes when ICD-10 provides them |

#### Per-specialty rulesets

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.19 | Orthopedics ruleset | ⚪ | First specialty — most doctors are ortho; Jayanth's CDI_SKILL_ORTHOPEDICS.md is a strong starting point |
| 1.20 | Hospitalist ruleset | ⚪ | Inpatient — not relevant to current doctors |
| 1.21 | Cardiology ruleset | ⚪ | Both Fahd and Jayanth have content |
| 1.22 | Family Medicine ruleset | ⚪ | Jayanth has content; Fahd doesn't list it explicitly |
| 1.23 | ENT ruleset | ⚪ | |
| 1.24 | Oncology ruleset | ⚪ | |
| 1.25 | Pulmonology ruleset | ⚪ | |
| 1.26 | Emergency Medicine ruleset | ⚪ | |
| 1.27 | Pain Management / Spine ruleset | ⚪ | |
| 1.28 | OB-GYN ruleset | ⚪ | Park is a gynecologist — we have data here even if Fahd's PDF doesn't list it |

#### Operating modes

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.29 | Balanced mode (default — flags both under-documentation and over-coding) | ⚪ | The sane default |
| 1.30 | Compliance mode (audit-defense — flags over-coding only, conservative) | ⚪ | Lower priority — useful after a bad audit |
| 1.31 | Aggressive mode (revenue-capture — flags every legitimate upcoding opportunity) | ⚪ | Lower priority — useful for revenue-lift initiatives |
| 1.32 | Per-doctor or per-encounter mode toggle in UI | ⚪ | UI feature — separate from the mode logic itself |

#### HCC capture (Medicare Advantage risk adjustment)

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.33 | HCC detection from chronic conditions in note | ⚪ | CMS-HCC model v28 per Fahd's PDF |
| 1.34 | Per-flag HCC opportunity label | ⚪ | "This flag captures an HCC: F32.0 (depressed mood)" |
| 1.35 | Per-specialty HCC opportunity scan | ⚪ | Different specialties have different HCC-relevant conditions |

#### DRG impact (inpatient billing)

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.36 | Per-flag DRG impact label (MCC / CC / no impact) | ⚪ | Inpatient-only — not relevant to our current outpatient-focused doctors. May never matter. |

#### Quality scoring

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.37 | Overall documentation quality score (0-100) | ⚪ | Single number for at-a-glance |
| 1.38 | Sub-scores: Specificity / Evidence support / Completeness | ⚪ | Breakdown of the overall |
| 1.39 | "Ring gauge" UI visualization | ⚪ | UI presentation — separate from the score itself |

#### Confidence-gated routing

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.40 | Auto-approve flags with confidence ≥80% | ⚪ | Routing logic — needs UI |
| 1.41 | Review flagged sections for 50–79% confidence | ⚪ | |
| 1.42 | Full review for <50% confidence | ⚪ | |

#### Provider Query Generator

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.43 | Generate AHIMA-compliant queries from CDI flags | ⚪ | Non-leading, multi-choice, "clinically undetermined" always included |
| 1.44 | Query type selection: Concurrent / Retrospective / Verbal | ⚪ | |
| 1.45 | Indicator warning if fewer than 2 clinical indicators support the query | ⚪ | AHIMA 2026 requirement |
| 1.46 | Per-patient repeat-query blocking log (AHIMA 2026 compliance) | ⚪ | Needs persistent storage → ties into SQLite design |
| 1.47 | Query format: Subject / Clinical context / Question / Response options / Provider signature line | ⚪ | |

#### Rules engine (pre-AI pattern matching)

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.48 | Pattern-matched rules fire before AI (zero API tokens for detection) | ⚪ | Fahd's approach — fast preliminary detection |
| 1.49 | 32 structured rules across specialties (JSON schema) | ⚪ | |
| 1.50 | Rule definitions versioned (FY2026 → FY2027 swap) | ⚪ | |

#### Standards source / versioning

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.51 | Bound to FY2026 ICD-10-CM Official Guidelines (CMS/NCHS Oct 1, 2025) | ⚪ | The legal source of truth |
| 1.52 | AHIMA/ACDIS 2026 query compliance rules | ⚪ | |
| 1.53 | Version + effective date metadata in CDI output (audit trail) | ⚪ | |

#### Documentation Defense additions (from Fahd's WhatsApp 15/5/2026)

| # | Sub-feature | Status | Notes |
|---|---|---|---|
| 1.54 | Conservative therapy documented before surgical authorization | ⚪ | Prior auth defense |
| 1.55 | Imaging support / clinical rationale for orders | ⚪ | |
| 1.56 | Surgical decision rationale explicit | ⚪ | |
| 1.57 | CPT modifier support (-24, -25, -57, -59) — Ortho-specific | ⚪ | |
| 1.58 | Surgery scheduling readiness check | ⚪ | |
| 1.59 | Procedure prior auth readiness check | ⚪ | |
| 1.60 | ICD-CPT pairing for medical necessity | ⚪ | Overlaps with 1.17 — may consolidate |

### What CDI catches — concrete examples

From the walkthroughs in chat:

**Spencer (Cecil Daniels, 3/11/2026 post-op):**
- Critical: Primary diagnosis missing (post-op without specifying procedure)
- Warning: Laterality not specified (elbow + wrist without right/left)
- Warning: 7th character context (initial vs subsequent post-op encounter)
- Warning: Symptom not addressed in plan (burning pain in forearm)
- Warning: Medical necessity for visit level not documented
- Suggestion: Implied order not explicit ("consider hand therapy")
- Suggestion: Patient education not documented
- Suggestion: Coexisting conditions / HCC capture

**Sabbag (James Marx, 3/13/2025 follow-up):**
- Critical: Coexisting diagnoses not coded (EMG shows 3 conditions, Assessment lists 1)
- Warning: Blank PMH/PSH/Medications fields → HCC capture gap
- Warning: Failed conservative therapy not enumerated before surgical recommendation
- Suggestion: Pronoun consistency errors ("her" in male patient note)
- Suggestion: High MDM supported but time not documented

### Relationship to other engines

- **Engine 3a (Specificity Dictionary)** is a focused subset of CDI — pattern-matches against the 20-50 vague Dx dictionary. Can be folded into CDI or run as a fast pre-check.
- **Engine 2 (SOAP Note Validator)** is structural-completeness, not coding-specificity. Different problem, complementary.
- **Engine 8a (Quality Agent)** cross-reviews CDI output (and other engines) and produces an overall quality decision.
- **Provider Query Generator** (sub-feature 1.43) consumes CDI flags as input. In Fahd's MCP it's a separate tool, but conceptually it's CDI's child.

---

## Engine 2 — SOAP Note Validator 📋

**Status:** Not active

**One-liner:** Pre-CDI structural completeness check — verifies the note has all the required sections, every order is linked to a diagnosis, time is documented for time-based billing, and other audit-defensible structural elements are present.

**Reads:** AI-generated SOAP note

**Writes:** Checklist of pass/fail against ~26 structural points (the AMBCI 25-point billing evidence proof map + a few additions)

**The defining question:** *"Does this note have all the structural elements a payer audit would expect, regardless of coding specificity?"*

**Different from CDI:** CDI is about *coding-specificity* — are the codes specific enough? Validator is about *structural completeness* — are all the necessary sections and connections present?

**Example catches:**
- Chief complaint not stated
- Plan has 4 actions but only 2 diagnoses (2 orphan plan items)
- Time-based billing claimed but no time documented
- Procedure note missing informed consent
- ROS missing or pasted-default
- Addendum without timestamp / authentication

**Source content:**
- AMBCI 25-point billing evidence proof map (referenced by Fahd's PDF)
- Fahd's "Documentation Defense Engine" message (15/5/2026) — provider authentication, consent, ABN, version history

---

## Engine 3 — Specificity Dictionary + E/M MDM Scorer 💰

Two sub-engines bundled by Fahd. They share inputs but produce different outputs.

### Engine 3a — Specificity Dictionary

**One-liner:** Focused subset of CDI — pattern-matches the Assessment against ~20-50 commonly vague diagnoses (sepsis, HF, pneumonia, AKI, etc.) and reports per-Dx specificity gaps.

**Reads:** SOAP note (mainly the Assessment section)

**Writes:** Per-diagnosis gap list with required modifiers + draft AHIMA query

**The defining question:** *"For each common vague diagnosis the doctor wrote, are the required modifiers present?"*

**Why it's its own engine:** Speed. Pattern-matching can run with zero API tokens for the detection phase — only fires the AI for query generation when a gap is found. Fahd implements this as a JSON dictionary lookup before any Claude call.

**Different from CDI:** CDI is general-purpose; Specificity is dictionary-driven and faster. CDI subsumes Specificity in functionality but Specificity is more efficient.

### Engine 3b — E/M MDM Scorer

**One-liner:** Scores the note against AMA 2023 MDM framework and predicts what E/M level (99202-99215) the note actually supports.

**Reads:** SOAP note + optional expected_level

**Writes:** Predicted level + per-element scoring (Problems / Data / Risk, each minimal/low/moderate/high) + upgrade path + time-based alternative

**The defining question:** *"What E/M code does this note actually support, and what specific documentation would upgrade to the next level?"*

**Different from CDI:** Coding-specificity vs billing-level prediction. Completely different problem. CDI looks at diagnosis codes; E/M Scorer looks at evaluation-and-management billing codes.

**Example:** Sabbag's Marx note → would predict 99215 supported (3 chronic problems + EMG interpretation + decision for major surgery), flag "time not documented" as the time-based alternative path.

---

## Engine 4 — Workers Comp Reports ⚖️

**Status:** Not active — pending decision on WC scope

**One-liner:** Generates the legally-required California DWC workers comp reports — PR-1 (initial), PR-2 (progress), PR-4 (MMI / permanent disability).

**Reads:** SOAP note + WC context (DOI, employer, claim number, report type)

**Writes:** Extracted fields + complete narrative report (12-15 sections depending on report type)

**The defining question:** *"What does a California DWC physician report look like for this encounter?"*

**Different from others:** This is **report generation**, not review. It's writing a new document.

**Risk profile:** PR-4 is the highest-stakes engine in the entire platform. Medical-legal document reviewed by QME/AME physicians, defense attorneys, applicant attorneys, and the Workers Comp Appeals Board (WCAB). Errors carry legal weight.

**Source content:**
- California DWC PR-1/PR-2/PR-4 form requirements (referenced by Fahd's `ca_dwc_wc.yaml`)
- AMA Guides 5th Edition for impairment ratings (PR-4)
- California Labor Code §4663 (apportionment standards)

**Status note from open-questions:** Marked as PENDING in Round 2 — rish wants to discuss whether this is in near-term scope before committing.

---

## Engine 5 — Prior Authorization 🔐

**Status:** Not active

**One-liner:** For a procedure or medication that needs payer pre-approval, checks against medical necessity criteria and drafts a persuasive prior authorization letter.

**Reads:** SOAP note + procedure + payer + diagnosis + prior treatments tried

**Writes:** Criteria checklist (met / partial / unmet, each with cited evidence) + complete PA letter with guideline citations and provider signature block

**The defining question:** *"Does this patient meet medical necessity criteria for this procedure, and can we write a persuasive case to the payer?"*

**Different from others:** Outbound communication to a payer — payer-facing letter, not provider-facing review.

**Two-step structure:** Criteria check first (returns met/partial/unmet for 5-7 criteria), then letter generation that cites the criteria-met evidence persuasively.

**Specialty examples in Fahd's PDF:** Hospitalist (CHF admission), Ortho (TKA), ENT (DL biopsy), Cardiology (ICD implant), OB/GYN (hysterectomy), Oncology (immunotherapy), Pulmonology (home O2), ED (CT-PA for PE), Pain (spinal cord stimulator)

---

## Engine 6 — Clinical Order Generation 📝

**Status:** Not active

**One-liner:** Reads the Plan section and generates the actual clinical orders that need to be placed — labs, imaging, referrals, medications, PT/OT, DME, follow-up. Surfaces "implied orders" — clinically indicated items missing from the plan.

**Reads:** SOAP note + specialty + setting (outpatient / inpatient / ED / telehealth)

**Writes:** Structured order list — each order has name, indication, priority (routine/urgent/stat), specific instructions, ICD-10 supporting code, provider action required (sign/review/modify)

**The defining question:** *"What orders should this encounter generate, and is the doctor missing any clinically-indicated ones?"*

**Different from others:** This is **producing new EHR orders**, not reviewing existing ones. The "implied orders" detection is the interesting feature — catches scenarios like "patient has fatigue + chronic kidney disease but plan has no labs" → implied: H&H, BUN/Cr, electrolytes.

**Categories of orders (per Fahd's PDF):**
- Labs
- Imaging
- Referrals
- Medications
- Therapy (PT / OT / Speech)
- Procedures
- DME (durable medical equipment)
- Follow-up

---

## Engine 7 — Patient Summary Generator 👤

**Status:** Not active

**One-liner:** Writes a patient-facing after-visit summary in plain language at 6th-grade reading level. Plus a 150-word pocket card the patient takes home.

**Reads:** SOAP note + specialty + patient + language

**Writes:**
- Full summary with sections: What happened today / Your diagnosis / What we did / Your medications / Next steps / Follow-up / Warning signs (ER vs call us) / Questions for next visit / About your condition
- 150-word pocket card

**Languages:** English, Spanish (Español), Simplified Chinese (简体中文), Tagalog

**The defining question:** *"How do I explain this visit to the patient in their language, at their reading level?"*

**Different from others:** Audience-facing patient communication. The only engine that writes for the patient, not for providers/payers/coders.

**Cost note:** Highest token cost of any engine — output is long, plus 4 language variants. Patient summaries on every encounter add up.

---

## Engine 8 — Quality + Feedback + Self-Learning 🔄

**Status:** Not active

Three sub-features bundled into one engine.

### Engine 8a — Quality Agent

**One-liner:** Cross-reviews ALL outputs from a session (CDI + WC + PA + orders + summary), assigns overall quality, flags critical issues, decides ready-to-submit.

**Reads:** All other engine outputs from this encounter

**Writes:** `{overall_score: 0-100, ready_to_submit: bool, critical_issues: [max 3], recommendations: [max 3], approval_status: {cdi, wc, pa: approved|needs_review|rejected}, summary_statement}`

**The defining question:** *"Looking at every output this encounter produced, is the package ready for the scribe to submit?"*

**Different from others:** Meta — reviews the reviews. The "linter for the linters."

### Engine 8b — Feedback Loop

**One-liner:** Records scribe actions on each engine output (accept / edit / reject), calculates edit % via word diff, tracks autonomy rate over time.

**Reads:** Scribe action + original output + final output

**Writes:** Persistent log entry per engine output with edit %, autonomy calculation, per-engine acceptance rates

**Different from others:** No medical content. Pure metrics + storage.

### Engine 8c — Level 1 Self-Learning

**One-liner:** Uses past accepted outputs as few-shot examples in future system prompts — the model "learns" facility style without fine-tuning.

**Reads:** The feedback log (filtered to accepted/lightly-edited outputs only)

**Writes:** A few-shot prefix prepended to system prompts on future calls

**Mechanism:** Retrieve 3 most recent accepted outputs WHERE engine=X AND specialty=Y AND edit%<15 → inject as "FACILITY LEARNING — match the style shown in these examples." into the system prompt.

**Different from others:** No medical content. A prompt-engineering trick that compounds over sessions.

---

## Auto-Pilot Orchestrator 🎮

**Status:** Not active (probably never built as a separate engine — see note)

**One-liner:** Decides which engines to run for a given encounter, based on visit type, specialty, and clinical context.

**Reads:** SOAP note + visit context (visit_type, specialty, patient)

**Writes:** JSON manifest of which engines to fire, with parameters:

```json
{
  "run_soap_validation": true,
  "run_specificity_check": true,
  "run_em_mdm": true,
  "run_cdi": true,
  "run_wc": false,
  "run_pa": false,
  "run_orders": true,
  "run_patient_summary": false,
  "patient_language": "english",
  "clinical_context": "...",
  "priority_flags": [...]
}
```

**Different from others:** Not an engine — a dispatcher. Doesn't produce clinical content; only decides which engines fire.

**Implementation note:** In our app this might be a JS rules-based dispatcher in main.js, not a Claude call. The decision logic is mostly deterministic ("if visit_type is workers_comp → run WC engine"). Fahd uses Claude for this because his deployment is chat-driven; our pipeline can be code-driven and skip the LLM round-trip.

---

## Summary table (one-line each)

| # | Engine | One-liner |
|---|---|---|
| 1 | CDI Co-Pilot | "What ICD-10 specificity gaps exist?" |
| 2 | SOAP Note Validator | "Does the note have all structural elements a payer expects?" |
| 3a | Specificity Dictionary | "Are the common vague diagnoses sufficiently modified?" *(subset of CDI)* |
| 3b | E/M MDM Scorer | "What E/M level does this note support, and what's the gap to the next?" |
| 4 | Workers Comp Reports | "Generate the PR-1/PR-2/PR-4 narrative." *(report generation, not review)* |
| 5 | Prior Authorization | "Draft the PA letter for this procedure." *(payer-facing letter)* |
| 6 | Clinical Order Generation | "Generate the orders this plan implies." *(EHR orders)* |
| 7 | Patient Summary Generator | "Explain this visit to the patient in plain language." *(patient-facing)* |
| 8a | Quality Agent | "Cross-review all engine outputs and decide ready-to-submit." *(meta)* |
| 8b | Feedback Loop | "Record scribe actions; compute autonomy %." *(metrics)* |
| 8c | Level 1 Self-Learning | "Inject past accepted outputs as few-shot examples." *(prompt engineering)* |
| — | Auto-Pilot Orchestrator | "Decide which engines to fire." *(dispatcher, may be code not LLM)* |

**Three rough categories:**
- **Review engines** (1, 2, 3a, 3b, 8a) — read the note, flag issues
- **Generation engines** (4, 5, 6, 7) — produce new artifacts
- **Meta engines** (8b, 8c, Auto-Pilot) — workflow/learning/dispatch

---

## Maintenance notes

- When an engine becomes the active deliverable, expand its **Sub-features (deliverables)** section the way Engine 1 is structured.
- Update status markers (⚪ → 🟢 / 🟡 / 🔵 / ❌) as scope decisions are made.
- When a sub-feature ships, change to ✅ with the date and a link to the merged plan in `docs/plans/`.
- When deferring, note *why* (e.g. "needs SQLite for persistence; revisit after Engine 1 v1 ships").

This document is the single source of truth for "what we're building under the PA umbrella." Architecture, UI, and orchestration considerations live in separate docs alongside `03-architecture-observations.md` and forthcoming follow-ups.

# AHIMA / ACDIS — Query Compliance & CDI Conduct Rules

**Standards version:** 2026
**Last reviewed:** 2026-05-19
**Source:** AHIMA / ACDIS *Guidelines for Achieving a Compliant Query Practice* (2022 update, reaffirmed for 2026) and ACDIS *Code of Ethics for the Clinical Documentation Specialist*.
**Used by:** CDI Co-Pilot (`cdi-review` skill); a future Provider Query Generator engine will use the same rules.

These rules govern **how a CDI flag is framed** and **when a documentation query is appropriate**. The CDI engine surfaces gaps; a downstream provider query (v1.1) phrases the gap as a question the clinician must answer.

---

## 1. When a query is appropriate

A query may be generated when documentation:

- **Is illegible, incomplete, or contradictory** (e.g., HPI says "right knee" but Plan says "left knee").
- **Lacks specificity** required to code at the most accurate level (laterality, acuity, severity, type, anatomic site, stage, complication, manifestation).
- **Contains clinical indicators** suggesting a diagnosis the provider has not stated (≥ 2 indicators threshold below).
- **Names a Dx without sufficient clinical indicators** to support it (clinical-validation query — over-coding defense).
- **Conflicts with itself across sections** (HPI ↔ exam, exam ↔ assessment, assessment ↔ plan).

**Two-indicator threshold (AHIMA 2026):** before raising a query that proposes a *new* diagnosis (rather than asking to clarify an existing one), the note must contain at least **two clinical indicators** supporting the proposed condition — symptoms, exam findings, labs, imaging, medications, or active monitoring. One indicator alone is insufficient.

**Flag-side implication:** when the CDI engine asserts that a Dx should be added, the `evidence_found` array must list ≥ 2 supporting indicators. Otherwise downgrade the flag from `critical` → `suggestion` or omit it.

---

## 2. Non-leading format

Queries must be **non-leading**. They state the clinical facts and ask the provider to clarify. They do **not** suggest the answer.

**Leading (non-compliant):**
> "The patient has BNP 1200 and EF 30%. Please document acute systolic heart failure."

**Non-leading (compliant):**
> "The patient has BNP 1200, EF 30%, bilateral lower-extremity edema, and is receiving IV furosemide. Please clarify the type and acuity of heart failure, if any:
> (a) Acute systolic / HFrEF
> (b) Chronic systolic / HFrEF
> (c) Acute-on-chronic systolic / HFrEF
> (d) Other
> (e) Clinically undetermined"

The clinical indicators come from the note **verbatim or as close as possible**. The choices are mutually exclusive. "Clinically undetermined" is always available.

**Engine-side implication:** when a CDI flag has a body, it should:
- Quote the indicators from the note (`evidence_found`), not paraphrase.
- Suggest multiple compliant code options in `suggested_codes`, not just the one the engine prefers.
- Avoid imperative language like "Document X" — use "Documentation of X would support code Y."

---

## 3. Multi-choice option requirement

When a query offers options, it must:
- Provide **multiple clinically reasonable options** (typically 3–5).
- Include "Clinically undetermined" or equivalent as one option (so the provider can decline without explanation).
- Not present a single option (that is leading by construction).
- Order options in **no particular clinical preference** (alphabetical or by code order).

When the CDI engine suggests codes, the `suggested_codes` array should reflect this — multiple alternatives where genuinely viable, not a single forced choice.

---

## 4. Repeat-query rule (per-patient)

The same query on the **same topic** should not be sent more than once per patient encounter without a clinically significant change. Repeating a query the provider has already declined to answer is non-compliant and constitutes pressure.

**App-side implication (v1.1, not v1):** the app maintains a per-patient query log keyed by topic. The CDI engine in v1 does not have access to that log; the app's downstream provider-query feature will read it.

**v1 behavior:** the engine raises flags; the deduplication happens downstream. The flag itself should still be raised on every run — the engine is stateless across invocations.

---

## 5. Query types

| Type | When | Notes |
|---|---|---|
| **Concurrent** | During the encounter, before the note is finalized | Highest yield; preferred when available. |
| **Retrospective** | After the encounter is signed but before claim submission | Standard for our pipeline (notes are post-visit). |
| **Verbal** | In-person or by phone with the provider | Must be documented in the chart with the same elements as a written query: subject, indicators, question, options, response, provider signature. |

The CDI engine output itself is the **input** to a future provider-query feature; it is not a query.

---

## 6. Required elements of a written provider query

When the CDI engine's output is later transformed into a provider query (v1.1), the query record must contain:

1. **Subject** — short label of the clinical issue (e.g., "Type and acuity of heart failure").
2. **Clinical context** — verbatim or near-verbatim indicators from the note.
3. **Question** — one specific clinical question.
4. **Response options** — ≥ 3 options, mutually exclusive, with "clinically undetermined" available.
5. **Provider signature line** — for the provider's reply / acknowledgment.
6. **Date / timestamp** — when the query was sent.
7. **Patient identifier and encounter date** — for the query log.

The CDI engine in v1 produces JSON that supplies elements 1–4 implicitly (title, evidence_found, body, suggested_codes). Elements 5–7 are added downstream.

---

## 7. Clinical validation queries (over-coding defense)

The most-overlooked compliant query type. When the note **asserts a diagnosis** without the clinical indicators that condition typically requires, the proper response is a clinical-validation query asking the provider to confirm or remove the diagnosis.

Examples:
- "Sepsis" stated in Assessment but no SIRS criteria, no source, no organism, no antibiotics documented → clinical-validation query.
- "Heart failure" stated but no BNP / echo / edema / dyspnea / diuretic — clinical-validation query.
- "Acute kidney injury" stated but no baseline creatinine, no current creatinine change, no urine-output documentation → clinical-validation query.

The engine surfaces these as **`Completeness` category** flags. The downstream query asks: "Please confirm the diagnosis of X, given the clinical indicators of Y. If X is not clinically substantiated, please remove from Assessment."

Auto-elevate to **critical** when the note's stated Dx is HCC-relevant — over-coding HCCs is a fraud-risk exposure.

---

## 8. Conduct rules (ACDIS Code of Ethics — abridged)

The CDI engine should reflect these in its tone and choices:
- **Code accurately and ethically.** Never imply a Dx that isn't clinically supported, even if it would yield a higher-paying code.
- **Be transparent about uncertainty.** Use confidence scores honestly; do not suppress low-confidence findings just because they're hard to defend.
- **Respect provider autonomy.** The engine surfaces; the provider decides. No imperative language ("you must"). Use "consider," "documentation of X would permit Y," "the note does not currently support…"
- **Protect patient privacy.** Do not include PHI elements outside what's already in the note.

---

## 9. What the engine does NOT do

- Does **not** assign ICD-10 codes (it surfaces gaps and suggests options).
- Does **not** send queries to providers directly (a future feature handles delivery).
- Does **not** override provider clinical judgment (it informs).
- Does **not** apply inpatient query / coding rules (uncertain Dx, principal Dx, POA) to outpatient notes.
- Does **not** repeat the same query on a topic the provider has already responded to (v1.1 enforcement; v1 is stateless).

---

**Document authority:** AHIMA / ACDIS *Guidelines for Achieving a Compliant Query Practice* (most recent edition) and ACDIS *Code of Ethics for the Clinical Documentation Specialist* (current revision).

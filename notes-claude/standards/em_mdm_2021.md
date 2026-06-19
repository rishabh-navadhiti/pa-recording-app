# E/M Medical Decision Making (2021) — Office / Outpatient Level Framework

**Standards version:** em_mdm 2021 v1
**Last reviewed:** 2026-06-11
**Source:** AMA *CPT 2021 Evaluation and Management (E/M) Office or Other Outpatient Services* guidelines (effective 2021-01-01) + CMS MLN/E/M documentation guidance.
**Used by:** E/M Scorer engine (`em-score` skill); the `cdi-review` skill loads this pack (Step 2) to attach E/M reimbursement signals to documentation flags.

> **Connector-free pack.** Everything here is **CPT / AMA** rules. The ICD-10 MCP connector is ICD-only and **cannot validate CPT codes, descriptors, or time thresholds** — do **not** call it for anything in this file. The CPT codes, descriptors, and time ranges below are source-checked against the AMA CPT 2021 E/M guidelines; cite the framework, not the connector. (If a worked example ever references an ICD-10 code, that code — and only that code — must be connector-validated per the De Quervain rule; the examples here intentionally name none.)

This pack scores **office / outpatient E/M only** (CPT 99202–99215). It does **not** apply to inpatient, ED, observation, or other E/M families, which have their own 2023 MDM tables.

---

## How a level is chosen (2021 rule)

Since 2021, an office/outpatient E/M level is selected by **either**:

1. **Medical Decision Making (MDM)** — the level met by **at least 2 of the 3 MDM elements** (the *2-of-3 rule*), **or**
2. **Total practitioner time** on the date of the encounter (the time alternative below).

Use **whichever supports the higher level.** History and exam are no longer scored for level selection (they are performed "as medically appropriate" but don't drive the code). The encounter must still be medically necessary.

---

## The three MDM elements

The overall MDM level is the level reached by **≥ 2 of these 3 elements**. Score each element on its own 4-level scale, then apply the 2-of-3 rule.

### Element 1 — Number & Complexity of Problems Addressed

A problem is "addressed" when it is evaluated/treated at the encounter (a problem merely noted/referred without management does not count at full weight).

| Level | Criteria (any one qualifies) |
|---|---|
| **Straightforward** | 1 self-limited or minor problem. |
| **Low** | 2+ self-limited/minor problems; **or** 1 stable chronic illness; **or** 1 acute uncomplicated illness/injury. |
| **Moderate** | 1+ chronic illness with **exacerbation/progression or side effects** of treatment; **or** 2+ stable chronic illnesses; **or** 1 undiagnosed new problem with **uncertain prognosis**; **or** 1 acute illness with **systemic symptoms**; **or** 1 acute complicated injury. |
| **High** | 1+ chronic illness with **severe exacerbation/progression or side effects**; **or** 1 acute/chronic illness or injury that **poses a threat to life or bodily function**. |

### Element 2 — Amount & Complexity of Data to be Reviewed & Analyzed

Data is scored across **three categories**. The number of *categories* met sets the level (not raw item count).

- **Category 1 — Tests, documents, independent historian.** Each counts as one item: reviewing the result of each unique test; ordering each unique test; reviewing prior external note(s) from each unique source; obtaining history from an **independent historian** (someone other than the patient — e.g., parent, caregiver). *Ordering and reviewing the same test is not double-counted.*
- **Category 2 — Independent interpretation** of a test performed by another physician/QHP (and **not** separately reported by you).
- **Category 3 — Discussion** of management or test interpretation with an **external** physician/QHP/appropriate source (not in your group, not the patient/family).

| Level | Criteria |
|---|---|
| **Straightforward** | Minimal or no data reviewed/analyzed. |
| **Low** | **Limited** — meet the requirements of **one** of: Category 1 (any **combination of 2** items), **or** Category 2 (independent interpretation of one test). |
| **Moderate** | **Moderate** — meet the requirements of **one** of: Category 1 (any combination of **3** items); **or** Category 2 (one independent interpretation); **or** Category 3 (one external discussion). |
| **High** | **Extensive** — meet the requirements of **two of the three** categories. |

### Element 3 — Risk of Complications and/or Morbidity/Mortality of Patient Management

Risk is the risk of the **management decided at this encounter** (including the decision *not* to treat) — not the abstract risk of the disease.

| Level | Criteria (representative) |
|---|---|
| **Straightforward** | **Minimal** risk from additional diagnostic testing or treatment. |
| **Low** | **Low** risk — e.g., OTC drugs, minor procedure low risk. |
| **Moderate** | **Moderate** risk — e.g., **prescription drug management**; decision re: minor surgery with risk factors, or elective major surgery without risk factors; diagnosis/treatment significantly limited by **social determinants of health**. |
| **High** | **High** risk — e.g., decision re: **emergency major surgery**; drug therapy requiring **intensive monitoring for toxicity**; decision re: **hospitalization**; decision to **de-escalate care due to poor prognosis (DNR/comfort care)**; parenteral controlled substances. |

> **Prescription drug management** is the most common Moderate-risk driver — it pulls the Risk element to Moderate on its own, which is frequently the hinge between a 99213 and a 99214.

---

## The 2-of-3 rule (worked)

Score Problems, Data, and Risk each at SF / Low / Moderate / High. The **overall MDM level is the level met by at least 2 of the 3 elements.**

- Problems **Moderate**, Data **Low**, Risk **Moderate** → 2 of 3 at Moderate → **Moderate MDM** (99214 / 99204).
- Problems **Moderate**, Data **Straightforward**, Risk **Low** → only 1 element at Moderate → falls to **Low MDM** (99213 / 99203).
- Problems **High**, Data **Moderate**, Risk **High** → 2 of 3 at High → **High MDM** (99215 / 99205).

When elements disagree, the **second-highest** element wins (you need two at a level to claim it).

---

## Level ↔ CPT mapping

| MDM level | New patient | Established patient |
|---|---|---|
| Straightforward | **99202** | **99212** |
| Low | **99203** | **99213** |
| Moderate | **99204** | **99214** |
| High | **99205** | **99215** |

Notes:
- **99202 spans Straightforward / Low MDM.** In 2021 the lowest scored new-patient code is 99202 (it requires SF *or* low MDM, or 15–29 min). There is no separate "minimal" new-patient code.
- **99201 was deleted effective 2021-01-01** — do not emit it.
- **99211** (established) is a **nurse/incident-to visit that may not require a physician/QHP** and has **no MDM and no required time**; it is not selected by this framework. Do not down-code a physician encounter to 99211.
- New-patient codes apply when the patient has **not** been seen by the practitioner (or another of the same specialty/group) within **3 years**; otherwise the patient is **established**.

---

## Time-based alternative (2021)

Instead of MDM, the level may be set by **total time the practitioner personally spends on the date of the encounter** — face-to-face **and** non-face-to-face (chart review, ordering, documentation, care coordination, counseling), **not** staff time, **not** time on a separately reported service. Time must be **documented** (a stated total, ideally with what it included). Counseling/coordination no longer needs to be > 50% of the visit — total time is what counts.

| CPT | Patient type | 2021 total-time range (minutes, date of encounter) |
|---|---|---|
| 99202 | New | **15–29** |
| 99203 | New | **30–44** |
| 99204 | New | **45–59** |
| 99205 | New | **60–74** |
| 99212 | Established | **10–19** |
| 99213 | Established | **20–29** |
| 99214 | Established | **30–39** |
| 99215 | Established | **40–54** |

(Ranges are the AMA-published 2021 thresholds; the *minimum* of the range is the threshold to reach that code. Time at/over the top of 99205/99215 uses prolonged-services add-on codes — out of scope for this pack.)

**Time OR MDM, whichever is higher.** If documented time supports a higher code than the 2-of-3 MDM result, bill on time (and vice versa). The scorer should compute both and report the higher, naming which path it used.

---

## Worked examples (one per level)

**Straightforward → 99212 (established).** Established patient, single minor problem (uncomplicated insect bite, no systemic symptoms). No data ordered/reviewed. Reassurance + OTC topical advised; no prescription. Problems SF, Data SF, Risk SF → 3 of 3 SF → **99212**. Time, if documented at ~12 min, also supports 99212.

**Low → 99213 (established).** Established patient, one stable chronic illness (well-controlled hypertension) reviewed; one prior lab result reviewed (Category 1 = 1 item, still Low data). Continue current OTC/lifestyle, no medication change. Problems Low, Data Low, Risk Low → ≥2 at Low → **99213**.

**Moderate → 99214 (established).** Established patient with a chronic illness with mild exacerbation (worsening asthma symptoms). Reviews a prior pulmonary function result and orders a new lab (Category 1 = 2 items → Low data). **Starts/adjusts a prescription** (Risk = Moderate via prescription drug management). Problems Moderate, Data Low, Risk Moderate → **2 of 3 Moderate** → **99214**. This is the classic 99214: Problems + Risk carry it even though Data is only Low.

**High → 99205 (new).** New patient with an acute illness **posing a threat to bodily function** (suspected acute limb ischemia). Independent interpretation of an outside imaging study **and** discussion with the vascular surgeon (Category 2 + Category 3 → **two categories → Extensive/High data**). Decision for **emergency surgery / hospitalization** (Risk High). Problems High, Data High, Risk High → 3 of 3 High → **99205**.

---

## Common down-code drivers (why the documented level fails)

The scorer's job is to find the gap between the **claimed** level and what the note **substantiates**, and name the fix.

- **Problems over-stated without matching Data or Risk.** Listing several chronic conditions in the assessment does not reach Moderate unless they were *addressed* (managed) and the note shows it. "Stable chronic ×3 mentioned" without management → still Low.
- **Risk asserted without the management decision that creates it.** Risk scores the *decision made*, not the diagnosis. "High-risk patient" prose earns nothing; the Moderate/High driver must be documented — the **prescription written**, the **surgery/hospitalization decision**, the **monitoring for toxicity** ordered. No prescription/procedure/admission decision in the note ⇒ no elevated Risk.
- **Data claimed without independent interpretation documented.** Category 2 requires that *you* independently interpreted a test another physician performed *and did not separately report* — the note must say so. "Reviewed MRI" without a documented independent read is a Category 1 *review* item (one data point), not Category 2. Ordering and reviewing the **same** test is one item, not two.
- **Time billed without a documented total.** A time-based code with no stated total minutes on the date of encounter is unsupported — fall back to MDM.
- **Counting referred-out problems.** A problem mentioned and referred elsewhere without evaluation/treatment at this visit is not "addressed" at full weight.

For each gap, give the **specific fix** — e.g., *"Risk is Low as documented (no prescription, no procedure decision); to support the claimed 99214, document the medication started/changed and the management rationale, which raises Risk to Moderate and meets 2-of-3."*

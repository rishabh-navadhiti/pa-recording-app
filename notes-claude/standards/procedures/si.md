# Sacroiliac Joint Injections — Medical-Necessity Rubric

**Procedure family:** Sacroiliac joint injection (SIJI) — intra-articular joint injection and lateral-branch nerve block; SI denervation (RFA) is **non-covered**.
**Governing coverage:** Medicare LCD **L39462**, Billing & Coding Article **A59244** (MAC: Noridian, J-E).
**Source:** Cedars-Sinai CRI "Sacroiliac Joint Interventions for Pain Management" checklist (updated 2025-05-14) + CRI educational deck.
**Standards version:** procedures/si v1 (2026-06-05)

---

## Detection cues (is an SI joint procedure in play?)

Performed or requested/recommended:

- "sacroiliac joint injection", "SI joint injection", "SIJI", "SIJ injection"
- "sacroiliac joint", "SI joint" in a procedural/recommendation context
- "lateral branch block", "sacral nerve block" innervating the SI joint
- a request line naming an SI joint procedure (e.g. "left sacroiliac joint injection")

*Costigan reality:* several sample notes have SI **fusion** history (Cedillos: left SI fusion + revision). A surgical *fusion* is not an SIJI — don't confuse the two. The procedure-in-play is an *injection* being performed or requested.

---

## CPT codes

**Group 1 — covered** (with image guidance, fluoroscopy or CT):

| CPT | Description |
|---|---|
| 27096 | Injection, **sacroiliac joint**, anesthetic/steroid, with image guidance (fluoroscopy or CT), including arthrography when performed |
| 64451 | Injection, **nerve(s) innervating the sacroiliac joint**, with image guidance (fluoroscopy or CT) — **imaging is included; do not separately report imaging** |

**Group 2 — NON-COVERED:**

| CPT | Description |
|---|---|
| 64625 | **Radiofrequency ablation, nerves innervating the SI joint** — SI denervation/RFA is NOT covered |

**Special case — no fluoroscopy available:**
- For SI joint injection performed **without** CT/fluoroscopic guidance in a patient who is **not pregnant and has no contrast allergy**: **do not** bill 27096, 20610, or 20611. Use **CPT 20552, one unit**, for unilateral or bilateral SI injection(s) — and code the diagnosis **M79.18** (see ICD note below).

**Modifiers / laterality:**
- Bilateral SIJI (27096 or 64451) → modifier **-50**.
- If a unilateral 27096 is done on one side and a unilateral 64451 on the **contralateral** side, do **not** report -50 with either.
- Do **not** report 27096 (joint injection) and 64451 (nerve block) for the **same side** per policy.
- **KX modifier** applies to the **diagnostic** SI injections (parallels facet: KX on the initial diagnostic block(s); repeat diagnostic injections beyond the first one or two are not reasonable and necessary).

---

## Covered ICD-10 (closed list — published by the Article)

For 27096, 64451, and HCPCS G0260 (SI injection facility code). All connector-validated billable:

| Code | Description | Billable |
|---|---|---|
| M43.28 | Fusion of spine, sacral and sacrococcygeal region | ✓ |
| M46.1 | Sacroiliitis, not elsewhere classified | ✓ |
| M47.818 | Spondylosis without myelopathy or radiculopathy, sacral and sacrococcygeal region | ✓ |
| M53.3 | Sacrococcygeal disorders, not elsewhere classified | ✓ |

**Special case ICD — no-imaging SI injection (CPT 20552):**

| Code | Description | Billable |
|---|---|---|
| M79.18 | Myalgia, other site | ✓ |

> Per the deck: **M79.18** may be used to code an SI joint injection performed **without imaging, or with ultrasound imaging**, in a patient who is **not pregnant and has no contrast allergy** — paired with **CPT 20552**.

### Coding-correctness traps for SI

- The closed covered set is small (M43.28, M46.1, M47.818, M53.3). A documented SI Dx outside this set is a coverage-mapping gap to surface.
- **M79.18 is only correct for the no-imaging 20552 path** — not for a standard fluoro-guided 27096/64451. Pairing M79.18 with 27096 (which *includes* imaging) is a mismatch.
- All four primary codes are already billable as written — none needs a more-specific child. **Do not raise a specificity flag** on them (connector confirms M46.1, M53.3 are billable terminal codes despite being short; M43.28 and M47.818 are the region-specific members).

---

## Checklist — Coverage indications (all six required)

**SI-1. Pain over the SI joint.** Moderate-to-severe low back pain **primarily over the SI joints** (between the upper iliac crests and the gluteal fold).

**SI-2. Duration ≥ 3 months.** Low back pain present **≥ 3 months**.

**SI-3. Below L5, no radiculopathy.** Low back pain **below L5 without radiculopathy.**
- *Disqualifier check:* a radicular pattern argues against SI as the generator (and toward ESI). Flag the conflict.

**SI-4. No other obvious cause.** Clinical findings/imaging do **not** suggest another cause of the lumbosacral pain (central stenosis with neurogenic claudication/myelopathy, foraminal stenosis or disc herniation with concordant radiculopathy, infection, tumor, fracture, pseudoarthrosis, or pain related to spinal instrumentation).

**SI-5. ≥ 3 positive provocative maneuvers.** **At least three positive findings** on provocative maneuvers from: **FABER, Gaenslen, Thigh Thrust (Posterior Shear), SI Compression, SI Distraction, Yeoman.**
- *This is the signature SI requirement.* Count the documented positive provocative tests. The Costigan exam block lists FABER / Fortin's / Gaenslen's etc. — count how many of the **named six** are positive. Two positives ≠ met; need **three**. (Fortin's finger test is supportive but is not one of the six named provocative maneuvers — don't count it toward the three.)

**SI-6. Conservative therapy ≥ 4 weeks.** Low back pain persists despite **≥ 4 weeks** of conservative therapies.

---

## Checklist — Diagnostic SIJI

**SI-D1.** Meets the six coverage indications (SI-1..6), AND
**SI-D2.** Performed under **CT/fluoroscopy with contrast** (ultrasound only with documented contrast allergy/pregnancy), AND
**SI-D3.** **Not** performed with other musculoskeletal injections in the lumbosacral spine, AND
**SI-D4.** Documentation shows **direct causal benefit** from the SI injection (not from other injections/treatments), AND
**SI-D5.** **≥ 75% relief** of index pain (positive diagnostic response = **≥ 75%** sustained/constant relief for the duration of the local anesthetic **and** ≥ 75% for the duration of the steroid), measured on the **same scale** at baseline. Pain measured **pre-injection day-of, post-intervention day-of, and the days following.**
- *Note the threshold:* SI diagnostic is **≥ 75%** (facet diagnostic is ≥ 80% — don't cross them).

**Diagnostic cap:** ≤ **2 diagnostic** SI sessions (unilateral or bilateral) per rolling 12 months. (Two unilateral sessions on opposite sides at different sessions = two diagnostic sessions.)
A subsequent diagnostic SIJI is **not** reasonable if the initial diagnostic block did **not** produce ≥ 75% relief.

---

## Checklist — Therapeutic SIJI

**SI-T1.** Meets coverage indications, AND
**SI-T2.** A diagnostic SIJI gave **≥ 75% relief** (same definition + same-scale + pre/post/following-day measurement as SI-D5), AND
**SI-T3.** Subsequent therapeutic SIJI at the **same anatomic site** produce **≥ 50% pain relief OR ≥ 50% improvement in painful movements/ADLs for ≥ 3 months** from the proximate therapeutic SIJI vs baseline on the **same scale**, AND
**SI-T4.** Performed under CT/fluoroscopy with contrast (ultrasound only with documented contraindication).

**Therapeutic cap:** ≤ **4 therapeutic** SIJI sessions (unilateral or bilateral) per rolling 12 months. (A session on one side then the other at a different session = two sessions.)
A subsequent therapeutic SIJI is **not** reasonable if the proximate one did not give ≥ 50% relief / ≥ 50% ADL improvement for ≥ 3 months.

**Beyond 12 months** — heightened bar (parallels ESI): significant functional/vocational disability; ≥ 50% sustained pain/functional improvement (same scale) for ≥ 3 months; documented continuation rationale; PCP notified.

---

## Documentation rules (auditor-facing)

- Image guidance with **contrast**; **radiographic films in ≥ 2 views** (pre- and post-contrast in AP and oblique) confirming intra-articular contrast + agent.
- Index pain measured **pre-injection** (beginning of session) and **post-procedure** (conclusion), on the **same named scale**.
- % relief documentation must state the duration is consistent/inconsistent with the agent and the **specific dates** measured on the **same scale** — a bare "% relief" or vague duration is **insufficient**.
- Functional/ADL improvement, if used to justify efficacy, needs an objective functional measure (not a vague statement).
- Performed in conjunction with conservative treatment; patient in an active rehab/HEP/functional-restoration program.

---

## Exclusions / non-covered (auto-fail)

- **SI denervation / RFA (CPT 64625) — NOT covered.** (Unlike facet, SI joint has no covered RFA path.)
- Injections **without radiographic image guidance** (except the documented-contraindication 20552 path).
- **Biologics** (PRP, stem cells, amniotic fluid).
- Multiple different blocks (ESI/sympathetic/facet/TPI) in the **same session** as the SIJI, including during the post-SIJI efficacy-assessment period.
- SIJI for **non-specific LBP, axial pain primarily above L5, CRPS, widespread/diffuse pain, chronic pain syndrome, neuropathy** — investigational.
- SIJI as part of a **series** of lumbar/musculoskeletal injections for nonspecific/chronic LBP.
- Moderate/deep sedation/MAC — rarely necessary.

---

## Verdict guidance

- **audit-ready** — the six indications met (SI pain location, ≥3mo, below-L5 no radiculopathy, no other cause, **≥3 positive provocative tests**, ≥4wk conservative care); image guidance + contrast + 2-view films; if diagnostic, ≥75% on the same scale with the pre/post/following-day measurements; if therapeutic, a prior ≥75% diagnostic + sustained ≥50%/3mo; within caps (2 diagnostic / 4 therapeutic per 12mo); covered Dx (M43.28/M46.1/M47.818/M53.3) or the correct 20552+M79.18 no-imaging pairing.
- **needs-edits** — covered indication, fixable gaps (e.g. only 2 provocative tests clearly positive; ≥75%/≥50% relief stated without dates; films-views not documented).
- **likely-denied** — a load-bearing criterion fails: **< 3 positive provocative maneuvers**, OR radicular pattern (SI-3 fail), OR another obvious cause documented (SI-4 fail), OR RFA/64625 requested (non-covered), OR no image guidance without the 20552 path, OR over a cap, OR therapeutic without a prior ≥75% diagnostic. State the specific denial reason and the fix.

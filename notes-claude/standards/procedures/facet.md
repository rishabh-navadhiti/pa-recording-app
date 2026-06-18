# Facet Joint Interventions — Medical-Necessity Rubric

**Procedure family:** Facet joint interventions — intra-articular (IA) injection, medial branch block (MBB), radiofrequency ablation (RFA / thermal denervation), facet cyst aspiration/rupture.
**Governing coverage:** Medicare LCD **L38801**, Billing & Coding Article **A58403** (MAC: Noridian, J-E).
**Source:** Cedars-Sinai CRI "Facet Joint Interventions for Pain Management" checklist (updated 2025-02-26) + CRI educational deck.
**Standards version:** procedures/facet v1 (2026-06-05)

---

## Detection cues (is a facet intervention in play?)

Performed or requested/recommended:

- "facet block", "facet joint injection", "intra-articular facet", "IA facet"
- "medial branch block", "MBB"
- "radiofrequency ablation", "RFA", "facet denervation", "rhizotomy", "neurotomy", "thermal denervation"
- "facet cyst aspiration", "synovial cyst rupture"
- a request line naming a facet procedure at levels/region (e.g. "lumbar facet block from L4 to S1")

The four sub-types follow an **escalation ladder**: diagnostic (IA or MBB) → therapeutic (IA or MBB) → RFA. Identify which rung the note is on — the criteria differ by rung.

---

## CPT codes

**Group 1 — covered** (diagnostic or therapeutic injection; and RFA), with image guidance (fluoroscopy or CT):

| CPT | Description |
|---|---|
| 64490 | Paravertebral facet injection (or nerves innervating that joint), cervical or thoracic; **single level** |
| +64491 | …cervical or thoracic; **second level** (add-on) |
| 64493 | Paravertebral facet injection, lumbar or sacral; **single level** |
| +64494 | …lumbar or sacral; **second level** (add-on) |
| 64633 | Destruction (neurolytic/RFA), facet joint nerve(s), cervical or thoracic; **single joint** |
| +64634 | …cervical or thoracic; **each additional** joint (add-on) |
| 64635 | Destruction (neurolytic/RFA), facet joint nerve(s), lumbar or sacral; **single joint** |
| +64636 | …lumbar or sacral; **each additional** joint (add-on) |

**Group 2 — NON-COVERED** (third-and-additional levels; only covered on appeal with sufficient documentation):

| CPT | Description |
|---|---|
| +64492 | Paravertebral facet injection, cervical or thoracic; **third and any additional** level(s) |
| +64495 | Paravertebral facet injection, lumbar or sacral; **third and any additional** level(s) |

**Level / laterality rules:**
- One or two levels, **unilateral or bilateral**, per session per region. **Three- or four-level procedures are not medically necessary** (→ Group 2, non-covered).
- A bilateral intervention at a level is still a **single-level** intervention — report with modifier **-50**.
- Each facet level = bilateral facet joints (one right, one left).
- For unilateral T12-L1 and L1-L2 levels (or nerves innervating that joint): use **64490 and 64494 once**.

**KX modifier (load-bearing — silent denial driver):**
- Append **KX to ALL diagnostic facet injection lines.** In most cases KX is used only for the **two initial diagnostic** injections.
- Example: unilateral L3-4 and L4-5 diagnostic MBB → bill `64493-KX` and `64494-KX`.
- **If KX is not appended, the injection is counted as one of the four *therapeutic* sessions** — silently eroding the therapeutic cap. This is exactly the kind of invisible coding error that surfaces in audit. The skill should flag a diagnostic facet procedure documented without any indication the KX modifier applies.
- Aberrant KX use may trigger focused review.

---

## Covered ICD-10 (closed list — published by the Article)

The Article publishes a **closed** covered-code set for 64490/64491/64493/64494/64633/64634/64635/64636. All connector-validated billable:

| Code range | Description | Members (all billable) |
|---|---|---|
| **M47.812 – M47.817** | Spondylosis without myelopathy or radiculopathy | .812 cervical, .813 cervicothoracic, .814 thoracic, .815 thoracolumbar, .816 lumbar, .817 lumbosacral |
| **M47.892 – M47.897** | Other spondylosis | .892 cervical, .893 cervicothoracic, .894 thoracic, .895 thoracolumbar, .896 lumbar, .897 lumbosacral |
| **M48.12 – M48.17** | Ankylosing hyperostosis [Forestier] | .12 cervical, .13 cervicothoracic, .14 thoracic, .15 thoracolumbar, .16 lumbar, .17 lumbosacral |
| **M53.82 – M53.87** | Other specified dorsopathies — **for facet cyst** | .82 cervical, .83 cervicothoracic, .84 thoracic, .85 thoracolumbar, .86 lumbar, .87 lumbosacral |

### Coding-correctness traps for facet

- The bare parents **`M47.81`, `M47.89`, `M48.1`, `M53.8`** exist but are **non-billable category headers** — never suggest them. Always resolve to the 5th-character region member that matches the documented level.
- **Facet coverage requires a *spondylosis / facet-pathology* diagnosis, NOT a radiculopathy code.** A documented untreated radiculopathy actually **disqualifies** facet coverage (see checklist FACET-3). Don't map a facet procedure to M54.1x radiculopathy.
- The M53.82–M53.87 row is specifically for the **facet cyst** sub-type; for routine facet IA/MBB/RFA the spondylosis ranges (M47.81x / M47.89x) are the usual fit.
- Match the region 5th character to the documented level (cervical vs lumbar, etc.).

---

## Checklist — Indications (all four required for ANY facet intervention)

**FACET-1. Axial pain + functional deficit on a named scale.** Moderate-to-severe chronic neck or low back pain, **predominantly axial**, causing functional deficit measured on a pain or disability scale.
- *Look for:* "axial", "predominantly axial low back pain", a named scale with a number. (Contrast with ESI, which requires a *radicular* indication — facet is the *axial* one.)

**FACET-2. Duration ≥ 3 months + conservative-care failure.** Pain present **≥ 3 months** with documented failure to respond to noninvasive conservative management (as tolerated).

**FACET-3. No untreated radiculopathy / neurogenic claudication.** Absence of untreated radiculopathy or neurogenic claudication — **except** radiculopathy caused by a facet joint synovial cyst.
- *This is a disqualifier check:* a documented radicular deficit with no facet-cyst explanation argues *against* facet coverage (and toward ESI). Flag the conflict.

**FACET-4. No non-facet pathology explains the pain.** No non-facet pathology (fracture, tumor, infection, significant deformity) per clinical assessment or radiology that could explain the pain source.

*Documentation note:* pain assessment performed and documented at **baseline** and **after each diagnostic procedure** using the **same** pain scale; a **disability scale** also obtained at baseline for functional assessment if the patient qualifies for treatment.

---

## Checklist — Diagnostic facet procedures (IA or MBB)

**FACET-D1. First diagnostic.** Patient meets the four indication criteria (FACET-1..4).

**FACET-D2. Second (confirmatory) diagnostic.** Patient meets the first-diagnostic criteria AND, after the first diagnostic, a **consistent ≥ 80% relief of primary (index) pain** (with duration consistent with the agent used). The second diagnostic procedure may only be performed **≥ 2 weeks after** the first.
- *Look for:* the ≥ 80% relief figure tied to the **specific scale and dates**.

**Diagnostic frequency cap:** ≤ **4 diagnostic** facet sessions per covered spinal region per rolling 12 months.

---

## Checklist — Therapeutic facet procedures (IA or MBB)

**FACET-T1. Two qualifying diagnostics.** The patient has had **two** medically-necessary diagnostic facet procedures, **each** with a consistent **≥ 80% relief** of index pain (duration consistent with the agent).

**FACET-T2. Sustained therapeutic benefit.** Subsequent therapeutic procedures at the same anatomic site produce **≥ 50% pain relief for ≥ 3 months** from the prior therapeutic procedure, OR **≥ 50% improvement in previously painful movements/ADLs** vs baseline on the **same scale**.

**FACET-T3. Why not RFA.** Documentation of **why the patient is not a candidate for RFA** (e.g. established spinal pseudarthrosis, implanted electrical device). *This is mandatory for therapeutic facet injections* — the deck states therapeutic facet injections are not covered unless the chart justifies why RFA cannot be performed.

**Therapeutic frequency cap:** ≤ **4 therapeutic** facet sessions per covered spinal region per rolling 12 months.

---

## Checklist — Facet joint RFA / thermal denervation

**FACET-RFA1. Two diagnostic MBBs at ≥ 80%.** At least **two** medically-necessary diagnostic **MBBs**, each with consistent **≥ 80% sustained relief** of index pain (duration consistent with the agent).

**FACET-RFA2. Repeat RFA benefit.** Repeat thermal RFA at the same site requires **≥ 50% improvement in pain for ≥ 6 months** (note: **6 months**, not 3) OR **≥ 50% improvement in painful movements/ADLs** vs baseline on the same scale.

**FACET-RFA3. Thermal + image-guided.** Performed at **> 80 °C** (non-thermal / low-grade-thermal / chemical / laser / cryo are non-covered), under fluoroscopy or CT.

**FACET-RFA4. Re-diagnose if stale.** If a prior RFA was **> 2 years** ago and/or the pain source is in question, diagnostic procedures **must be repeated** before the RFA.

**RFA frequency cap:** ≤ **2 RFA** sessions per covered spinal region per rolling 12 months.

> Sedation for RFA: moderate sedation/MAC may be considered if medical necessity for sedation is clearly documented (unlike the injections, where sedation is rarely necessary).

---

## Checklist — Facet cyst aspiration / rupture

**FACET-C1.** Advanced imaging (MRI/CT/myelogram) confirms compression/displacement of the corresponding nerve root by a facet **synovial cyst**, AND **FACET-C2.** clinical/physical symptoms related to the synovial facet cyst are documented.
**Cap:** repeatable **once** per individual cyst, only if **≥ 50% improvement for ≥ 3 months**. Code with **M53.82–M53.87**.

---

## Exclusions / non-covered (auto-fail)

- Intra-/extra-articular facet **prolotherapy**.
- **Non-thermal** denervation (chemical, low-grade thermal < 80 °C, laser neurolysis, cryoablation).
- **Intra-facet implants.**
- Facet procedure performed **after ALIF** (anterior lumbar interbody fusion).
- Definitive findings pointing to a **specific diagnosis other than facet syndrome.**
- Diagnostic injection or MBB at the **same level as a previously successful RFA.**
- Facet interventions **without** CT/fluoroscopic guidance (no guidance, ultrasound, or MRI guidance).
- Three-/four-level procedures (→ Group 2 CPT, non-covered).
- Multiple different blocks the same day as facet (could lead to improper/lack of diagnosis).

---

## Verdict guidance

- **audit-ready** — the four indications (FACET-1..4) met (axial pain, ≥3mo + conservative-care failure, no untreated radiculopathy, no non-facet cause); the rung-specific criteria met (diagnostic: meets indications + ≥2-week gap for the 2nd; therapeutic: two ≥80% diagnostics + sustained ≥50%/3mo + documented why-not-RFA; RFA: two ≥80% MBBs + thermal + re-diagnose-if-stale); within the rung's cap; KX correctly applied to diagnostics; covered spondylosis Dx (not radiculopathy).
- **needs-edits** — covered indication, fixable gaps (e.g. ≥80% relief stated without dates; therapeutic injection missing the why-not-RFA statement; KX not evident on a diagnostic line).
- **likely-denied** — a load-bearing criterion fails: untreated radiculopathy present without facet-cyst basis (FACET-3 fail → wrong procedure), OR therapeutic/RFA without the required prior ≥80% diagnostic blocks, OR three-/four-level (Group 2), OR over the rung cap, OR no image guidance, OR the only Dx is a radiculopathy code rather than spondylosis. State the specific denial reason and the fix.

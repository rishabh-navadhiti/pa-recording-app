# Epidural Steroid Injection (ESI) — Medical-Necessity Rubric

**Procedure family:** Epidural steroid injection — transforaminal (TFESI), caudal (CESI), interlaminar (ILESI).
**Governing coverage:** Medicare LCD **L39240**, Billing & Coding Article **A58993** (MAC: Noridian, J-E).
**Source:** Cedars-Sinai CRI "Epidural Steroid Joint Injections for Pain Management" checklist (updated 2025-04-04) + LEI Educational deck.
**Audit context:** This is the procedure behind the TPE audit — **CPT 64483** (single-level lumbar/sacral TFESI), 30 claims pre-payment reviewed, 23.3% error rate. Make this rubric the sharpest of the five.
**Standards version:** procedures/esi v1 (2026-06-05)

---

## Detection cues (is an ESI in play?)

An ESI is in play when the note **performs or requests/recommends** any epidural steroid injection. Look across HPI, Assessment/Plan, and any "request for authorization" block:

- "epidural steroid injection", "ESI", "LESI" (lumbar ESI), "CESI" (caudal), "ILESI" (interlaminar)
- "transforaminal", "TFESI", "transforaminal epidural"
- "selective nerve root block" performed as an epidural steroid injection
- a request/authorization line naming an epidural injection at a level/region (e.g. "epidural steroid injection at L4-L5")

**Not** an ESI: facet/medial-branch block, SI joint injection, trigger point injection (those have their own packs). A note may have several procedures in play — evaluate each against its own pack.

**Pre-auth reality:** in these notes the ESI is usually *recommended / requested*, not yet performed. A recommendation counts as "in play" — the medical-necessity documentation is exactly what the auditor checks before the procedure is approved.

---

## CPT codes

The epidural family (the deck references these narratively; 64483 is the audited code):

| CPT | Description | Level rule |
|---|---|---|
| 64479 | TFESI, cervical or thoracic; single level | TFESI ≤ 2 levels per region |
| +64480 | TFESI, cervical or thoracic; each additional level (add-on) | second level only |
| **64483** | **TFESI, lumbar or sacral; single level** | the audited code |
| +64484 | TFESI, lumbar or sacral; each additional level (add-on) | second level only |
| 62321 | ILESI, cervical or thoracic, with imaging | ILESI ≤ 1 level |
| 62323 | ILESI, lumbar or sacral, with imaging | ILESI ≤ 1 level |
| 62322 | ILESI/caudal, cervical/thoracic, without imaging | image guidance required → see exclusions |
| 62324 | CESI/ILESI, lumbar/sacral, without imaging | image guidance required → see exclusions |

> CPT validation is **not** the ICD-10 connector's job (it carries ICD-10-CM/PCS only). These CPT codes are from the CRI deck. The skill's coding-correctness check focuses on **ICD-10 ↔ procedure mapping**, level/laterality limits, and modifiers — not CPT existence.

**Modifiers / level limits:**
- **TFESI:** maximum **2 levels** in one spinal region per session. Bilateral TFESI only when clinically indicated (and documented as such).
- **CESI / ILESI:** maximum **1 level**. **Bilateral CESI/ILESI is never medically necessary.**
- Only **one spinal region** may be injected per session.

---

## Covered ICD-10 — NO closed list published

**Important asymmetry:** unlike the facet/TPI/SI/PVA decks, the ESI LCD/Article publishes **no closed ICD-10 table**. Coverage is defined *narratively* by indication. So this pack does **not** assert a closed covered-code set. Instead it gives connector-validated **representative** codes per covered indication; the skill checks the documented diagnosis against the LCD's narrative indication and uses these as anchors, **not** as an exhaustive allow-list.

The three covered indication buckets (from checklist item 1):

**(a) Radiculopathy / radicular pain / neurogenic claudication due to disc herniation, osteophyte/osteophyte complex, severe DDD producing foraminal or central spinal stenosis.** Representative connector-validated codes:

| Code | Description | Billable |
|---|---|---|
| M54.12 | Radiculopathy, cervical region | ✓ |
| M54.16 | Radiculopathy, lumbar region | ✓ |
| M54.17 | Radiculopathy, lumbosacral region | ✓ |
| M51.16 | Intervertebral disc disorders with radiculopathy, lumbar region | ✓ |
| M48.062 | Spinal stenosis, lumbar region, with neurogenic claudication | ✓ |
| M48.061 | Spinal stenosis, lumbar region, without neurogenic claudication | ✓ |

(The radiculopathy axis M54.1x is region-specific: .12 cervical, .13 cervicothoracic, .14 thoracic, .15 thoracolumbar, .16 lumbar, .17 lumbosacral, .18 sacral. Match the documented region.)

**(b) Post-laminectomy syndrome:**

| Code | Description | Billable |
|---|---|---|
| M96.1 | Postlaminectomy syndrome, not elsewhere classified | ✓ |

**(c) Acute herpes zoster–associated pain:** zoster / postherpetic neuralgia family (e.g. **B02.29** "Other postherpetic nervous system involvement", validated billable). Acute zoster radiculitis maps to the B02.2x family — validate the specific code against the connector for the documented presentation.

### Coding-correctness traps for ESI

- **`M51.36`** ("Other intervertebral disc degeneration, lumbar region") **exists but is a non-billable category header** — never suggest it. More importantly, **DDD *without* radiculopathy is not an ESI-covered indication** at all (see exclusions: non-specific LBP / axial pain are non-covered). If the only documented diagnosis is axial DDD/spondylosis without radicular findings, that is a medical-necessity gap, not a code-specificity gap.
- A documented **radiculopathy** diagnosis must be concordant with **image findings** (item 1) — radiculopathy coded without a concordant MRI/CT finding is an audit-defense gap.
- Match **laterality and region** of the code to the documented side/level.

---

## Checklist — Initial ESI

The CRI checklist requires **all three** top-level requirements. Evaluate each as met / not-met / unclear with a verbatim evidence quote.

**ESI-1. Concordant diagnosis + imaging.** History, physical exam, **and concordant radiological image-based diagnostic testing** support ONE of: (a) radiculopathy/radicular pain/neurogenic claudication due to disc herniation, osteophyte, or severe DDD producing foraminal/central stenosis; (b) post-laminectomy syndrome; (c) acute herpes zoster pain.
- *Look for:* a named MRI/CT with findings that match the symptomatic level/side. "Concordant" is the operative word — the imaging finding must explain the radicular pattern.

**ESI-2. Severity + named baseline scale.** The radiculopathy/radicular pain/claudication is severe enough to greatly impact quality of life or function, **and an objective pain scale or functional assessment is performed at baseline (prior to interventions)**, with **the same scale repeated at each follow-up.**
- *Look for:* a named scale with a number at baseline (NRS/VAS/PDAS/ODI/OSW/QUE/Roland-Morris/BPFS/PROMIS). A bare "pain is severe" without a named scale = not-met. **The same-scale follow-up is the most commonly missing element** — flag its absence explicitly.

**ESI-3. Duration ≥ 4 weeks + conservative-care failure.** Pain present **≥ 4 weeks** AND inability to tolerate, or documented failure of, **≥ 4 weeks** of noninvasive conservative care. (Acute herpes zoster refractory to conservative management does not require the 4-week wait.)
- *Look for:* enumerated conservative measures (NSAIDs, PT, activity modification, etc.) **with duration**, and an outcome. Conservative care named without duration = unclear; absent = not-met.

**ESI-4. Image guidance + contrast.** The ESI must be performed under **CT or fluoroscopy with contrast**, unless a documented allergy to low-molecular-weight nonionic contrast (or pregnancy) — in which case ultrasound without contrast may be considered.
- *Look for:* "under fluoroscopic guidance", "with contrast", "epidurogram". An initial contrast injection is required to confirm epidural placement (item 7) unless contraindicated.

**ESI-5. Level limits respected.** TFESI ≤ 2 levels per region; CESI/ILESI ≤ 1 level; one region per session; TFESI bilateral only when clinically indicated; CESI/ILESI never bilateral.

**ESI-6. Conservative-care + active rehab concurrency.** ESI performed in conjunction with conservative treatment; patient is in an active rehab / home-exercise / functional-restoration program.

---

## Checklist — Repeat ESI (the longitudinal core)

A repeat ESI is medically necessary only when the **first injection directly and significantly improved** the treated condition, documented as **at least:**

**ESI-R1. ≥ 50% sustained relief for ≥ 3 months on the SAME scale.** The record documents **≥ 50% sustained improvement** in pain relief and/or function, **measured from baseline using the SAME scale, for at least three months.**
- *Look for:* a relief percentage tied to **specific dates** on the **same named scale** used at baseline. The CRI rule (and TPI/SI parallels) is explicit: a bare "% relief" or a vague duration statement is **insufficient** — it must state the duration is consistent/inconsistent with the agent used and the **specific dates** the measurements were taken.
- *Costigan reality:* prior ESI **dates** are usually well documented (HPI prose + Past Surgical History table), but the **relief % and same-scale follow-up are usually absent.** When you see prior ESIs listed with dates but no relief data, that is the single highest-value gap to surface — it is exactly what fails the repeat-ESI necessity test.

**ESI-R2. Failed-initial alternative path.** If the patient failed to respond to the initial ESI, a repeat after **14 days** may be performed using a **different approach/level/medication**, with the rationale and medical necessity documented.

**ESI-R3. Beyond 12 months — heightened bar.** Treatment beyond 12 months may trigger focused review and requires: significant functional/vocational disability; ESI provides ≥ 50% sustained pain and/or functional improvement (same scale); documented rationale for continuation (high surgical risk / patient declines surgery / recurrence relieved ≥ 3 months); **PCP notified** of continued/prolonged steroid use.

---

## Frequency caps (rolling 12 months)

- **Maximum 4 ESI sessions per spinal region per rolling 12-month period.**
- Not medically necessary to inject **more than one spinal region** in the same session.
- Not medically necessary: TFESI at **> 2 nerve-root levels** per session; CESI/ILESI at **> 1 level** per session.
- Do **not** prescribe a predetermined series of ESIs.
- *Skill behavior:* count the prior ESI **dates** for the same region within the trailing 12 months from this note's date of service. If a 5th in 12 months for one region is being requested, flag the cap. If dates are listed without region, note the ambiguity.

---

## Documentation rules (auditor-facing)

- **Named scale** documented in the record at **baseline** and the **same scale** at every follow-up. Acceptable scales (non-exhaustive): verbal rating scale, NRS, VAS (pain); PDAS, ODI, OSW (Oswestry), QUE (Quebec), Roland-Morris, BPFS, PROMIS (function).
- Procedural report documents indications + medical necessity **and the pre- and post-injection % pain relief** measured immediately post-injection.
- **Films (≥ 2 views)** documenting final needle position and contrast flow retained.
- Pre-procedural pain rating obtained on the **day of** the injection; post-procedural rating **immediately** post-injection.
- Steroid dosing the lowest effective amount (recommended ceilings: triamcinolone 80 mg / betamethasone 12 mg / dexamethasone 15 mg per session).

---

## Exclusions / non-covered (auto-fail if the note's indication is one of these)

- ESI for **non-specific low back pain, axial spine pain, complex regional pain syndrome, widespread/diffuse pain, neuropathy from other causes, or cervicogenic headache** — investigational, not covered. (This is the most common ESI denial driver — axial/mechanical pain without a radicular, image-concordant indication.)
- Injection **without image guidance** or by **ultrasound**, except documented contrast contraindication (allergy, pregnancy).
- **Biologics** (PRP, stem cells, amniotic fluid) — investigational.
- Multiple different blocks (ESI + sympathetic + facet + TPI) in the **same session** (exception: facet synovial cyst + ESI same session).
- Moderate/deep sedation, general anesthesia, or MAC — rarely necessary; needs specific documented justification.
- Contraindications: suspected/active localized spinal infection, significant systemic infection, compressive cord/conus/cauda lesions, suspicion or major risk factors for cancer.

---

## Verdict guidance

Roll the item results into a per-procedure verdict:

- **audit-ready** — ESI-1 through ESI-4 all met (concordant Dx+imaging, named baseline scale, ≥4wk duration + conservative-care failure, image guidance+contrast); level limits respected; if a repeat, ESI-R1 met (≥50%/≥3mo same scale, with dates); within the 4/region/12-mo cap; indication is not on the exclusion list.
- **needs-edits** — the indication is covered and most criteria are met, but fixable gaps exist (e.g. baseline scale present but no same-scale follow-up; conservative care named without duration; relief % stated without dates).
- **likely-denied** — a load-bearing criterion fails: indication is axial/non-specific (exclusion), OR no concordant imaging, OR repeat ESI with no documented prior relief, OR over the frequency cap, OR no image guidance without a documented contrast contraindication. State the specific denial reason.

For each not-met / unclear item, give the **specific fix** ("Document the % relief and the dates of the prior 06/07/2023 LESI on the same VAS used at baseline").

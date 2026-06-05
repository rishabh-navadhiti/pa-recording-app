# Percutaneous Vertebral Augmentation (PVA) for VCF — Medical-Necessity Rubric

**Procedure family:** Percutaneous vertebral augmentation for vertebral compression fracture (VCF) — vertebroplasty (PVP) and kyphoplasty (PKP).
**Governing coverage:** Medicare LCD **L34228**, Billing & Coding Article **A56572** (MAC: Noridian, J-E).
**Source:** Cedars-Sinai CRI "PVA for VCF / Kyphoplasty" checklist (updated 2025-05-31 / deck 2026-05-31) + CRI educational deck (distilled from the image-only raw LCD scan).
**Standards version:** procedures/pva v1 (2026-06-05)

---

## The odd one out

PVA is **not** like the four injection packs. It is a **one-time augmentation** procedure judged on **inclusion / exclusion criteria** for an **acute/subacute fracture** — there are **no repeat-relief thresholds, no diagnostic→therapeutic ladder, and no rolling-12-month session cap.** The model: does this specific fracture, right now, meet the inclusion criteria and clear the exclusions? Evaluate it that way, not as a repeat-injection necessity test.

---

## Detection cues (is a PVA in play?)

Performed or requested/recommended:

- "vertebroplasty", "kyphoplasty", "vertebral augmentation", "PVA", "PVP", "PKP"
- "cement augmentation", "balloon kyphoplasty"
- "compression fracture" in a context where augmentation is being performed/recommended (vs merely noting a remote/healed fracture)
- a request line naming augmentation at a vertebral level (e.g. "kyphoplasty at L1")

*Costigan reality:* ≈6 of 89 sample notes mention compression fracture / kyphoplasty. Distinguish an **acute/subacute symptomatic VCF being augmented** from an incidental/old fracture mention — only the former puts PVA "in play."

---

## CPT codes (all include imaging guidance)

**Group 1 — covered:**

| CPT | Description |
|---|---|
| 22510 | Percutaneous **vertebroplasty**, 1 vertebral body; **cervicothoracic** |
| 22511 | Percutaneous **vertebroplasty**, 1 vertebral body; **lumbosacral** |
| +22512 | Vertebroplasty; **each additional** cervicothoracic or lumbosacral body (add-on) |
| 22513 | Percutaneous **vertebral augmentation (kyphoplasty)**, 1 body; **thoracic** |
| 22514 | Percutaneous **vertebral augmentation (kyphoplasty)**, 1 body; **lumbar** |
| +22515 | Vertebral augmentation (kyphoplasty); **each additional** thoracic or lumbar body (add-on) |

Bone biopsy is included when performed; all imaging guidance is inclusive.

---

## Covered ICD-10 (two-tier closed list — published by the Article)

**Group 1 — osteoporotic fractures.** All connector-validated billable:

| Code | Description | Billable |
|---|---|---|
| M80.08XA | Age-related osteoporosis with current pathological fracture, vertebra(e), **initial encounter** | ✓ |
| M80.08XS | Age-related osteoporosis with current pathological fracture, vertebra(e), **sequela** | ✓ |
| M80.88XA | Other osteoporosis with current pathological fracture, vertebra(e), **initial encounter** | ✓ |
| M80.88XS | Other osteoporosis with current pathological fracture, vertebra(e), **sequela** | ✓ |

**Group 2 — malignant fractures (REQUIRES TWO CODES).** All connector-validated billable:

| Code | Description | Billable |
|---|---|---|
| C41.2 | Malignant neoplasm of vertebral column | ✓ |
| C79.51 | Secondary malignant neoplasm of bone | ✓ |
| C79.52 | Secondary malignant neoplasm of bone marrow | ✓ |
| C90.00 | Multiple myeloma not having achieved remission | ✓ |
| C90.01 | Multiple myeloma in remission | ✓ |
| C90.02 | Multiple myeloma in relapse | ✓ |
| M84.58XA | Pathological fracture in neoplastic disease, other site, **initial encounter** | ✓ |
| M84.58XS | Pathological fracture in neoplastic disease, other site, **sequela** | ✓ |

> **Group 2 two-code rule:** for malignant fractures, **M84.58XA or M84.58XS MUST be reported in addition to one of the CXX.XX neoplasm codes** (C41.2 / C79.51 / C79.52 / C90.00 / C90.01 / C90.02). A Group-2 PVA documented with only the fracture code or only the neoplasm code is a coding gap → flag it.

### Coding-correctness traps for PVA

- The XA/XS 7th character encodes encounter type: **XA = initial encounter for fracture, XS = sequela.** An *acute/subacute* augmentation is an **initial-encounter** scenario (XA); a sequela code (XS) on an acute augmentation is a mismatch with the acuity the inclusion criteria require.
- Group 1 (osteoporotic) is a **single** code; Group 2 (malignant) needs the **two-code pair**. Don't mix tiers.
- These are the only covered Dx families — a VCF augmentation mapped to a generic dorsalgia/fracture code outside M80.08/M80.88 (osteoporotic) or the Group-2 set (malignant) is a coverage mismatch.

---

## Checklist — Inclusion criteria (ALL required)

**PVA-1. Acute/subacute osteoporotic VCF, T1–L5, imaging-confirmed.** **Acute (< 6 weeks)** or **subacute (6–12 weeks)** osteoporotic VCF in the **T1–L5** range, based on symptom onset, **documented by advanced imaging** showing **bone marrow edema on MRI** or **uptake on bone-scan/SPECT/CT.**
- *Look for:* the fracture **age** (acute vs subacute, tied to symptom onset), the **level** (must be T1–L5), and the **edema/uptake** imaging finding. A chronic/old fracture, or one without marrow edema/uptake, fails this.

**PVA-2. Symptomatic (ONE of the two paths):**
- **(i) Hospitalized** with severe pain: **NRS or VAS ≥ 8**, OR
- **(ii) Non-hospitalized** with moderate-to-severe pain **NRS or VAS ≥ 5 despite optimal non-surgical management (NSM)**, AND one of:
  1. **Worsening pain**, OR
  2. **Stable-to-improved pain (but NRS/VAS still ≥ 5)** WITH **≥ 2 of:** progression of vertebral body height loss; **> 25% vertebral body height reduction**; kyphotic deformity; **severe impact on daily functioning (RDQ > 17).**
- *Look for:* a **named scale** (NRS/VAS) with the threshold number, the hospitalized-vs-not status, and — for the non-hospitalized stable path — the **≥2 secondary criteria** (height loss progression / >25% reduction / kyphosis / RDQ>17).

**PVA-3. Continuum of care (BOTH):**
- (i) Referred for **BMD evaluation + osteoporosis education** for subsequent treatment, AND
- (ii) Instructed to take part in an **osteoporosis prevention/treatment program.**
- *Look for:* an osteoporosis referral / BMD work-up / treatment-program instruction. This is frequently the missing element on otherwise-qualifying notes.

---

## Checklist — Exclusion criteria (ANY present → not covered)

**Absolute contraindications (auto-fail):**
- **PVA-X1.** Current back pain **not primarily due to** the identified acute/subacute VCF. *(This is also the linchpin: the pain being treated must be attributable to the target fracture.)*
- **PVA-X2.** Osteomyelitis, discitis, or active systemic / surgical-site infection.
- **PVA-X3.** Pregnancy.

**Relative contraindications (flag; documentation must address):**
- **PVA-X4.** **> 3 vertebral fractures per procedure.**
- **PVA-X5.** Allergy to bone cement or opacification agents.
- **PVA-X6.** Uncorrected coagulopathy.
- **PVA-X7.** Spinal instability.
- **PVA-X8.** Myelopathy from the fracture.
- **PVA-X9.** Neurologic deficit.
- **PVA-X10.** Neural impingement.
- **PVA-X11.** Fracture retropulsion / canal compromise.

---

## Documentation rules (auditor-facing)

- The **fracture acuity** (acute < 6 wk / subacute 6–12 wk) tied to **symptom onset**, and the **level** (T1–L5).
- The **advanced-imaging** finding establishing acuity: **bone marrow edema on MRI** or bone-scan/SPECT/CT uptake (a plain-film compression deformity alone does not establish acuity).
- A **named pain scale** (NRS/VAS) with the threshold number for the chosen symptomatic path.
- For the non-hospitalized stable-pain path: the **≥ 2 secondary criteria**, with **RDQ score** if RDQ is the one used (> 17).
- The **osteoporosis continuum-of-care** referral + program instruction.
- That the **treated pain is attributable to the target fracture** (the exclusion-X1 linchpin).

---

## Verdict guidance

- **audit-ready** — all inclusion criteria met (PVA-1: acute/subacute T1–L5 VCF with marrow edema/uptake; PVA-2: a satisfied symptomatic path with a named scale at threshold, plus the ≥2 secondary criteria if on the stable-pain path; PVA-3: osteoporosis referral + program), **no** absolute exclusion present, relative exclusions addressed; Dx correctly coded (Group 1 single osteoporotic code, or Group 2 neoplasm-code-**plus**-M84.58Xx pair) with the correct **XA** acuity.
- **needs-edits** — qualifying fracture, fixable gaps (e.g. acuity/edema not explicitly documented; continuum-of-care referral missing; stable-pain path missing one of its ≥2 secondary criteria; Group-2 missing the second code).
- **likely-denied** — an absolute exclusion present (pain not from the VCF, active infection, pregnancy), OR the fracture is chronic / not T1–L5 / lacks acuity imaging, OR neither symptomatic path is met (pain below threshold without the secondary criteria), OR Dx outside the covered tiers. State the specific denial reason and the fix.

> Because PVA is one-time, the verdict turns on **inclusion-vs-exclusion at this encounter**, not on prior-procedure relief history — do not look for repeat-relief thresholds or session caps here.

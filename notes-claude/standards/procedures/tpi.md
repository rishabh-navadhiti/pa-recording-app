# Trigger Point Injection (TPI) — Medical-Necessity Rubric

**Procedure family:** Trigger point injection for myofascial pain.
**Governing coverage:** Medicare LCD **L34211**, Billing & Coding Article **A57701** (MAC: Noridian, J-E).
**Source:** Cedars-Sinai CRI "Trigger Point Injection" checklist (updated 2025-05-14) + CRI educational deck.
**Standards version:** procedures/tpi v1 (2026-06-05)

---

## Detection cues (is a TPI in play?)

Performed or requested/recommended:

- "trigger point injection", "TPI"
- "trigger point" in a procedural/recommendation context
- a request line naming trigger point injection of named muscle(s)

*Costigan reality:* TPI is **rare** in this physician's practice (≈1 of 89 sample notes mentions it). When it does appear, the ICD restriction below is the dominant audit risk.

---

## CPT codes

| CPT | Description |
|---|---|
| 20552 | Injection(s); single or multiple trigger point(s), **1 or 2 muscle(s)** |
| 20553 | Injection(s); single or multiple trigger point(s), **3 or more muscles** |

**Coding rules:**
- The code is by **number of muscles**, not number of injections: all injections into a muscle group are bundled into the one code. 20552 = 1–2 muscles; 20553 = 3+ muscles.
- The **drug** must be on the **same claim** as the trigger point administration (reported with a HCPCS J-code or revenue code; unclassified drugs J3490/J3590/J9999/C9399 also need drug name + dosage in Box 19).
- **No anesthesia codes** should be billed with 20552/20553.
- *Note the overlap with SI:* CPT **20552** is also the code for a no-imaging SI joint injection (see `si.md`) — disambiguate by the documented anatomy/indication (myofascial trigger point vs sacroiliac joint).

---

## Covered ICD-10 (closed list — ONLY these, the tightest of all five packs)

The new LCD covers **only** tension-type headache (G44.201–G44.229) and myalgia (M79.10–M79.18). All connector-validated billable:

| Code | Description | Billable |
|---|---|---|
| G44.201 | Tension-type headache, unspecified, intractable | ✓ |
| G44.209 | Tension-type headache, unspecified, not intractable | ✓ |
| G44.211 | Episodic tension-type headache, intractable | ✓ |
| G44.219 | Episodic tension-type headache, not intractable | ✓ |
| G44.221 | Chronic tension-type headache, intractable | ✓ |
| G44.229 | Chronic tension-type headache, not intractable | ✓ |
| M79.10 | Myalgia, unspecified site | ✓ |
| M79.11 | Myalgia of mastication muscle | ✓ |
| M79.12 | Myalgia of auxiliary muscles, head and neck | ✓ |
| M79.18 | Myalgia, other site | ✓ |

### Coding-correctness traps for TPI (the dominant TPI audit risk)

- **The covered list is closed and narrow.** A TPI documented for **low back pain, neck pain, fibromyalgia, chronic pain syndrome, lumbosacral stenosis, CRPS, whiplash, or neuropathic pain is NOT covered** — even though those are common dictation phrases. If a TPI is being done for low-back/neck myofascial pain, the only covered mapping is the **myalgia** family (M79.1x) **with documented trigger points** — not a spine/dorsopathy code. A spine code (M54.x, M47.x) on a TPI line is a coverage mismatch → likely denial.
- The bare parents **`G44.20`, `G44.21`, `G44.22`, `M79.1`** exist but are **non-billable headers** — never suggest them; resolve to the 5th-character member.
- TPI "in the absence of actual trigger points" is explicitly non-covered (see exclusions) — the covered myalgia code still requires the documented trigger-point findings of TPI-2/TPI-3.

---

## Checklist — Initial TPI (all four required)

**TPI-1. Focal muscle pain.** A focal area of pain in the **skeletal muscle.**

**TPI-2. Trigger point with ≥ 2 findings.** Clinical evidence of a trigger point = pain in a skeletal muscle associated with **≥ 2 of:** a hyperirritable spot and/or taut band identified by palpation, and possible referred pain.

**TPI-3. Palpable nodule / taut band on exam.** The physical exam identifies a **focal hypersensitive bundle or nodule of muscle fiber harder than normal consistency**, with or without a local twitch response and referred pain.

**TPI-4. Conservative care / functional rationale.** Noninvasive conservative therapy unsuccessful as first-line, OR joint/limb movement is limited or blocked, OR the TPI is needed for diagnostic confirmation.

---

## Checklist — Subsequent (repeat) TPI (all three required)

**TPI-R1. ≥ 50% relief from the most recent TPI** on the **SAME pain scale** at baseline and post-injection (consistent minimum 50% relief of index pain).

**TPI-R2. Relief lasted ≥ 6 weeks** from the most recent prior TPI.
- *Note the duration:* TPI repeat threshold is **≥ 6 weeks** (not the 3-month figure used by ESI/SI/facet-therapeutic). Don't cross them.

**TPI-R3. Recurrence with measured functional limitation** — the myofascial pain recurred and causes objective functional limitations measured by a **functional scale** at baseline and after TPI showing **≥ 50% improvement** from the previous TPI.

---

## Frequency cap (rolling 12 months)

- **Maximum 3 TPI sessions per rolling 12-month period**, regardless of the code billed.
- **One anatomical group per session** — not reasonable to inject **multiple muscle groups in different anatomical regions** in the same session.
- Not reasonable to perform multiple different blocks (ESI/sympathetic/facet) in the same session as a TPI.

---

## Documentation rules (auditor-facing)

- Patient in an ongoing conservative treatment program (rehab/HEP/functional restoration), documented.
- **Index pain measured before** the injection (start of session) and **post-procedure on the SAME scale** at the conclusion.
- % relief documentation must state the duration is consistent/inconsistent with the agent used and the **specific dates** measured on the **same scale** — a bare "% relief" or vague duration is **insufficient**.
- ADL/functional improvement, if used to justify efficacy, needs an objective measurable functional assessment (not a vague statement).
- The procedural report must document the **location of trigger points treated, the muscles injected, the medication and amount used, the pre/post % relief**, and the post-procedure plan.

---

## Exclusions / non-covered (auto-fail)

- **Local anesthetic only** — TPI does **not** include biologics (PRP, stem cells, amniotic fluid) or other injectates.
- **Image guidance makes a TPI non-covered:** **fluoroscopy or MRI guidance is not reasonable/necessary; ultrasound guidance is investigational.** (This is the *opposite* of ESI/facet/SI, which *require* image guidance — a TPI documented "under fluoroscopy" is a red flag.)
- **TPI in the absence of actual trigger points**, or for: diffuse muscle pain, chronic pain syndrome, lumbosacral canal stenosis, **fibromyalgia**, non-malignant multifocal musculoskeletal pain, CRPS, sexual dysfunction/pelvic pain, whiplash, neuropathic pain, hemiplegic shoulder pain — all investigational.
- Multiple muscle groups in different anatomical regions in the same session.
- Routine/periodic/continuous TPI for chronic non-malignant pain syndromes.

---

## Verdict guidance

- **audit-ready** — initial: focal muscle pain + trigger point with ≥2 findings + palpable nodule/taut band on exam + conservative-care/functional rationale (TPI-1..4); repeat: ≥50% relief on the same scale + lasted ≥6 weeks + measured functional recurrence (TPI-R1..3); within the 3/12-mo cap; one anatomical group; covered Dx (tension headache G44.2xx or myalgia M79.1x) **with documented trigger points**; **no** image guidance; local anesthetic only.
- **needs-edits** — covered indication, fixable gaps (e.g. only one trigger-point finding documented; relief % without dates; functional improvement stated without a scale).
- **likely-denied** — a load-bearing criterion fails: **Dx is a non-covered condition** (fibromyalgia, spine code, CRPS, neuropathic, etc.), OR no documented trigger points/taut band, OR **image guidance used**, OR biologic injectate, OR over the 3/12-mo cap, OR multiple anatomical regions in one session. State the specific denial reason and the fix.

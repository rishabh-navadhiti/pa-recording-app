# Orthopedics — CDI Rules

**Specialty pack version:** orthopedics v1 (2026-05-19)
**Layered on:** `icd10_fy2026.md` + `ahima_acdis_2026.md` (universal rules above are required reading first)
**Applies to:** Outpatient orthopedic clinic encounters — hand surgery, sports medicine, joint replacement, spine, foot & ankle, trauma follow-up.

These rules are **additional** to the universal ICD-10 rules — not a replacement. The CDI engine loads the universals first, then this file. Conflicts: defer to the universal file (CMS guidelines win over specialty conventions).

---

## 1. The single most important decision — Chapter 13 vs. Chapter 19

**Sec I.C.13.b.**

- **Chapter 19 (S00–T88)** = current acute traumatic injury. Requires a 7th character.
- **Chapter 13 (M00–M99)** = chronic, recurrent, residual, or degenerative musculoskeletal condition.

| Clinical description | Chapter |
|---|---|
| "Twisted knee yesterday, swelling, pain" | 19 |
| "Chronic knee pain, old ACL tear, no acute event" | 13 |
| "Medial-compartment OA on X-ray" | 13 |
| "Fell this morning, wrist fracture on X-ray" | 19 |
| "Rotator cuff tear, chronic, no inciting event" | 13 |
| "Rotator cuff tear after fall" | 19 |
| "Stress fracture, activity-related, no acute trauma" | 19 (query if pathologic is suspected) |
| "Post-op follow-up at week 6, routine healing" | Z47.x (status code) + injury code with 7th-character D where applicable |

If documentation is genuinely ambiguous about acuity → **query trigger** (do not infer). Auto-elevate to critical if the wrong chapter is suggested.

**Flag:** acute-injury language coded from Chapter 13; chronic / recurrent condition coded from Chapter 19.

---

## 2. Site specificity — the anatomy hierarchy

Orthopedic notes routinely contain imaging and procedure detail that supports maximum site specificity. **Never accept a general anatomic term when the note documents a specific structure.**

### Knee
- Compartment: medial / lateral / patellofemoral / tricompartmental
- Meniscus: medial vs. lateral; body / anterior horn / posterior horn; tear type (bucket-handle, radial, flap, complex)
- Ligament: ACL / PCL / MCL / LCL; complete vs. partial

### Shoulder
- Rotator cuff: supraspinatus / infraspinatus / teres minor / subscapularis; complete vs. partial; acute vs. chronic
- Labrum: anterior / posterior / superior (SLAP type)
- Biceps tendon: long head vs. short head; proximal vs. distal
- Joint: glenohumeral vs. AC vs. sternoclavicular

### Hip
- Fracture site: femoral head / femoral neck / intertrochanteric / subtrochanteric (drives code selection)
- Labrum: anterior / posterior / superior

### Spine
- Level: cervical (C1–C7) / thoracic (T1–T12) / lumbar (L1–L5) / sacral
- Disc pathology: level-specific; displacement vs. degeneration vs. herniation
- Radiculopathy: level **and** laterality
- Stenosis: level-specific; with / without neurogenic claudication

### Hand & wrist
- Specific digit (thumb / index / long / ring / small) and side
- Specific tendon (FDS / FDP / EPL / EPB / APL / extensor digitorum) for trigger / tenosynovitis
- Carpal bones (scaphoid, lunate, etc.) by name for fracture
- Joint level: CMC / MCP / PIP / DIP

### Foot & ankle
- Ankle ligament: lateral (ATFL / CFL / PTFL) vs. medial (deltoid)
- Specific metatarsal (1st–5th) and toe
- Calcaneal vs. talar vs. navicular fracture

**Flag:** any diagnosis coded at a general anatomic level when the note provides sufficient detail for a more specific code.

---

## 3. Fracture coding — complete requirements

Every fracture code needs **all** of:

1. **Site** (specific bone, segment, articular involvement).
2. **Laterality** (right / left / unspecified — unspecified should be rare).
3. **Displaced vs. non-displaced** (default to non-displaced only if the documentation is genuinely silent — but ask why imaging didn't comment).
4. **Open vs. closed** (default to closed if silent; Gustilo grade if open is documented).
5. **Traumatic (Chapter 19) vs. pathologic (M80 / M84)** — see §4 below.
6. **7th character** (see Universal §11; A / D / G / K / P / S).

### 7th character — interpretation rule (worth restating)

**The 7th character reflects whether active treatment is occurring**, NOT whether this is the patient's first visit with this provider.

- New patient referred to a surgeon for a fracture still being treated → **A**.
- Existing patient at week 6 with hardware in place and healing well → **D**.
- Existing patient at week 12 with x-ray showing no callus → **G** (delayed healing).
- Existing patient with confirmed nonunion → **K**.
- Existing patient with malunion → **P**.
- Patient seen for sequela / late effect of the healed fracture → **S**.

**Flags:**
- Fracture code missing the 7th character entirely (invalid code — auto-critical).
- A used for a healing-phase follow-up where active treatment has concluded.
- D used during ongoing active treatment.
- Displacement, open/closed, or specific site not coded when documented.

---

## 4. Pathologic vs. traumatic fracture (Sec I.C.13.c, I.C.13.d)

| Situation | Code family |
|---|---|
| Known osteoporosis + fracture from minor trauma that would not break a normal bone | **M80** (pathologic, age-related or other) — **not** Chapter 19 |
| Fracture through a metastatic lesion | M84.5x + neoplasm code |
| Stress / fatigue fracture | M84.3x (by site) |
| Fracture through Paget disease | M84.58x |
| Osteoporosis, no current fracture | M81.0 (age-related) or M81.8 (other) |
| Osteoporosis with history of healed fragility fracture, no current fracture | Z87.310 alongside M81 |

**Critical rule:** even if the patient fell, if the trauma was minor and the patient has known osteoporosis, use **M80** — not a traumatic-fracture code.

**Flags:**
- Low-energy mechanism in an osteoporosis patient coded from Chapter 19 (auto-critical — coder-coupling failure).
- M81 used when a current fracture is present (should be M80).
- Z87.310 missing when prior osteoporosis fracture is in history.

---

## 5. Degenerative / structural conditions — specificity

### Osteoarthritis
- Primary (idiopathic) vs. secondary (post-traumatic, post-surgical) — different code families.
- Specific joint + laterality.
- Knee OA: compartment-level (medial / lateral / patellofemoral / multiple / tricompartmental).

### CMC arthritis (thumb basal joint)
- Eaton stage (I / II / III / IV) — drives surgical decision-making and is payer-relevant.
- Laterality required.

### Spinal degenerative conditions

| Condition | Level required | Additional dimensions |
|---|---|---|
| Cervical disc disorder (M50.x) | C4–C5, C5–C6, C6–C7, other | With / without myelopathy; with / without radiculopathy |
| Thoracolumbar disc disorder (M51.x) | Thoracic / thoracolumbar / lumbar / lumbosacral | With / without myelopathy; with / without radiculopathy |
| Spondylosis (M47.x) | Region | With / without myelopathy; with / without radiculopathy |
| Spinal stenosis (M48.0x) | Region | With / without neurogenic claudication |
| Dorsalgia (M54.x) | Region (cervicalgia / thoracic / lumbar) | With / without radiculopathy; specific level if documented |

**Flag:** "back pain" coded as M54.5 unspecified when the note documents a specific level or radiculopathy; disc herniation coded without level when MRI gives one; radiculopathy without nerve level + laterality.

---

## 6. Tendon and soft-tissue conditions

Every tendon condition needs: specific tendon + laterality + acute vs. chronic (chapter selection).

| Common condition | Required specificity |
|---|---|
| Rotator cuff tear | Specific tendon (supraspinatus / infraspinatus / subscapularis / teres minor); complete vs. partial; acute vs. chronic; laterality |
| Achilles | Rupture (acute → Ch 19) vs. tendinopathy / tendinitis (chronic → Ch 13); laterality |
| Patellar tendon | Rupture vs. tendinitis; laterality |
| Biceps tendon | Proximal vs. distal; long vs. short head; rupture vs. tendinitis; laterality |
| Lateral / medial epicondylitis | Laterality |
| De Quervain tenosynovitis | Laterality |
| Trigger finger | **Which digit** (thumb / index / long / ring / small); laterality; acute vs. chronic |

**Flag:** rotator cuff pathology without tendon when MRI / op report has one; acute tendon rupture coded from Chapter 13; tendon condition without laterality.

---

## 7. Post-surgical encounters

| Situation | Code |
|---|---|
| Routine post-joint-replacement follow-up | Z47.1 |
| Routine post-other-orthopedic-surgery follow-up | Z47.89 |
| Healing-phase follow-up for an injury | Injury code + 7th character D |
| Post-op aftercare on musculoskeletal system | Z48.815 |
| Implant complication (mechanical) | T84.0x–T84.4x by device + type |
| Implant infection | T84.5x–T84.7x + organism code |
| Periprosthetic fracture around implant | M97.x |
| Status: presence of joint implant | Z96.6x (e.g., Z96.651 right knee, Z96.652 left knee) |

**Flag:** original-condition code (knee OA) used for a routine post-TKA follow-up; injury code with 7th character A used for a routine healing-phase follow-up; implant pain / loosening / infection documented in Plan without T84.x coding; periprosthetic fracture without M97.x.

---

## 8. Pain coding — G89

**Sec I.C.6.b.** G89 is appropriate **only** when pain management is the **reason for the encounter** — not when the visit is for the underlying condition itself.

| Reason for encounter | G89? | Sequencing |
|---|---|---|
| Treatment of the underlying ortho condition | No | Underlying first; omit G89 |
| Pre-op eval for joint replacement | No | Underlying first |
| Routine post-op follow-up | No | Z47.x |
| Pain control / pain management explicitly stated | Yes | G89.x first; underlying second |
| Acute pain due to trauma, pain-management visit | G89.11 | G89.11 first |
| Chronic pain management (explicitly documented as such) | G89.2x | G89.2x first |
| Unexpected / above-routine post-op pain | G89.18 or G89.28 | Per documentation |

**No time threshold defines chronic pain.** Only provider documentation of "chronic pain" enables G89.2x. G89.4 (chronic pain syndrome) requires explicit provider documentation of that specific syndrome — do not infer.

**Flag:** G89 applied when the visit is for the condition itself (pre-op, standard surgical follow-up); G89 omitted when the note explicitly states the reason for the visit is pain control; G89.4 used without explicit provider documentation of chronic pain syndrome.

---

## 9. Workers comp — external cause coding

**Sec I.C.20.** Work-relatedness must be documented by the provider — not inferred from billing. When confirmed, four external-cause elements are required:

| Element | Code family | Example |
|---|---|---|
| Mechanism | W00–X58 | W19.x fall; W20.x struck by object; X50.x overexertion |
| Place | Y92.x | Industrial / construction / warehouse / office |
| Activity | Y93.x | Activity-specific |
| Work status | **Y99.0** | Civilian activity done for income or pay |

**Flag:** work injury noted without external-cause codes; mechanism present but Y99.0 missing; chronic non-injury condition with external-cause codes applied; work-relatedness implied but not provider-confirmed.

---

## 10. Conservative therapy and surgical decision-making

This section is the highest-value documentation-defense check for outpatient ortho.

Most payers (especially Medicare, BCBS, Aetna, Cigna) require **documented failed conservative therapy** before authorizing many elective ortho procedures — joint replacement, CTR, trigger release, rotator cuff repair, spine surgery, arthroscopy, etc.

The note should document, **before any surgical recommendation in the Plan**:

1. **Symptom duration** (weeks / months / years).
2. **Functional impact** — ADLs, work, sleep — quantified where possible.
3. **What conservative therapy was tried** — specifically named modalities:
   - NSAIDs / analgesics (with dose and duration)
   - Activity modification / bracing / splinting (with type and duration)
   - Physical therapy (with sessions and outcomes)
   - Corticosteroid injection(s) (with date, response duration, number of injections)
   - Home exercise program adherence
4. **The outcome of each modality** — failed / partial / temporary / not tolerated — not just "tried."
5. **Imaging findings interpreted** — specific findings supporting the surgical decision, not just "MRI reviewed."

**Flag:**
- Surgical procedure in Plan with no enumerated conservative-therapy history (auto-critical when conventionally required for that procedure).
- Conservative therapy listed by name but without outcomes ("tried PT" without "completed 6 weeks, no improvement").
- Imaging mentioned but not interpreted in the note ("MRI reviewed" without specific findings tied to the diagnosis).
- Pre-authorization-requiring procedure without symptom duration or functional-impact documentation.

---

## 11. Functional impairment quantification

When the chief complaint is **mobility, function, or pain**, the note should quantify:

- **ROM in degrees** — not "limited," "restricted," "decreased." Specific numbers per joint.
- **Strength in MRC 0–5** — not "weak," "good."
- **Sensory deficit by dermatome** — not "decreased sensation."
- **Functional measures** — DASH, Quick-DASH, KOOS, HOOS, ODI, NPS — score if used.
- **Specific ADL deficits** — "cannot lift > 5 lb," "cannot open jars," "cannot climb stairs" — not "difficulty with ADLs."

**Flag:** subjective complaint of limited motion / weakness / numbness without quantified objective findings.

---

## 12. Named orthopedic tests — positive / negative results explicit

Payer-facing rule (from "What Insurers Actually Grade"): orthopedic notes are expected to include named provocative tests with explicit results. Vague phrases like "exam consistent with…" do not defend the diagnosis.

Common named tests by region:

| Region | Tests to expect |
|---|---|
| Wrist / hand | Phalen's, Tinel's (at wrist / cubital tunnel / Guyon's), Finkelstein's, Watson's, scaphoid shift, grind test (CMC) |
| Elbow | Cozen's, Mill's, Tinel's (cubital tunnel), valgus / varus stress |
| Shoulder | Hawkins-Kennedy, Neer, empty can / Jobe, drop arm, lift-off, belly press, Speed's, O'Brien's, apprehension / relocation |
| Knee | McMurray's, Lachman's, anterior / posterior drawer, valgus / varus stress, Apley's, Thessaly, patellar grind, Ober's |
| Hip | FABER, FADIR, Stinchfield, Thomas, Trendelenburg, log roll |
| Spine | Spurling's, Lhermitte's, straight-leg raise, slump, FABER, Hoover's |
| Foot / ankle | Anterior drawer, talar tilt, Thompson, Mulder click, calcaneal squeeze |

**Flag:** chief complaint identifies a region in which a named test would defend the diagnosis (e.g., knee meniscal tear) but no named test is documented with explicit positive / negative result.

---

## 13. Common ortho specificity traps (curated examples)

These are the highest-frequency specificity failures we see in our doctors' notes. The engine should surface a flag against any of these when the trap is present:

| Note language | Why it's a trap | Better-defended code(s) |
|---|---|---|
| "Trigger finger" without specifying digit | Each digit has its own code | M65.331 (right index), M65.341 (right ring), M65.342 (left ring), etc. |
| "Carpal tunnel syndrome" without laterality | G56.00 unspecified is denied by many payers | G56.01 (right), G56.02 (left), G56.03 (bilateral) |
| "Fracture" without 7th character | Invalid code | Add A / D / G / K / P / S per care phase |
| "CMC arthritis" without Eaton stage | Stage drives surgical decision-making | Document stage II / III / IV; M18.x by laterality |
| "Knee OA" without compartment | Tri-compartmental vs. unicompartmental affects code and surgical option | M17.11 (right primary), M17.12 (left primary) — note compartment in narrative |
| "Rotator cuff tear" without specific tendon | M75.10x family has tendon-specific subcategories | M75.111 (right supraspinatus), M75.121 (right infraspinatus), etc. |
| "Lumbar radiculopathy" without level + side | M54.16 unspecified vs. level-specific | M54.16 may be acceptable if MRI doesn't localize; otherwise M54.16 is under-coded |
| "Tendinitis" without specifying tendon and laterality | Generic M77.9 is denied | M77.0x epicondylitis, M77.1x lateral, etc. with laterality |
| "Lateral epicondylitis" without laterality | M77.10 unspecified vs. M77.11 right vs. M77.12 left | Always document side |
| "Post-op visit" without procedure or original Dx | Sec IV.A violation — first-listed Dx missing | Z47.x + original ICD or post-op aftercare Z48.815 |

---

## 14. Doctor-style observations (from our onboarded ortho doctors)

These reflect documentation patterns seen in Spencer / Sabbag / Dietrick / Harris / Ryan / Tsai notes. The CDI engine should pattern-match against these when present:

### Spencer (hand surgery, short-form dictation)
- Often dictates post-op follow-ups without restating the original Dx or procedure.
- Tends to omit laterality even when only one side was treated.
- Plan items frequently implied ("consider hand therapy") rather than ordered.
- **Engine should flag:** missing primary Dx; missing laterality; implied vs. explicit orders; patient education absent.

### Sabbag (upper-extremity / nerve)
- EMG / imaging often names multiple conditions but Assessment lists only one.
- PMH / PSH frequently blank — affects HCC capture and surgical clearance.
- Surgical recommendations sometimes appear without enumerated conservative therapy.
- **Engine should flag:** EMG / imaging conditions documented but missing from Assessment (auto-critical — coexisting Dx); blank PMH / PSH in surgical-planning context; surgery without conservative-therapy enumeration.

### Dietrick (joint replacement)
- Z96.6x status codes on long-term follow-up sometimes omitted.
- Periprosthetic findings sometimes coded as native-joint OA instead of M97.x.
- **Engine should flag:** missing arthroplasty status codes; OA codes used in post-arthroplasty context.

---

## 15. CDI flag-generation checklist for orthopedic notes

When reviewing an outpatient orthopedic note, the engine should mentally walk this checklist before producing flags. This is the basis for the two-pass extraction in the skill's Step 3.

**Pass 1 — extract every diagnosis** mentioned in **HPI + transcript + objective + assessment + plan**, not just the Assessment section. Many gaps are visible only when you read the whole document.

**Pass 2 — for each musculoskeletal diagnosis, verify:**

- [ ] Laterality documented and coded
- [ ] Chapter 13 vs. 19 correct for acuity
- [ ] Most granular anatomic site the note supports
- [ ] Primary vs. secondary OA where applicable
- [ ] Acute vs. chronic specified

**Fractures specifically:**
- [ ] 7th character present and valid
- [ ] 7th character reflects current care phase
- [ ] Displaced vs. non-displaced documented
- [ ] Open vs. closed documented
- [ ] Pathologic vs. traumatic — osteoporosis + low energy → M80

**Pain coding:**
- [ ] G89 only when pain management is the reason
- [ ] G89 omitted when visit is for the underlying condition

**Workers comp (if applicable):**
- [ ] Mechanism (W / X)
- [ ] Place (Y92)
- [ ] Activity (Y93)
- [ ] Work status (Y99.0)
- [ ] Provider-confirmed work-relatedness

**Post-surgical:**
- [ ] Z47.x for routine post-op follow-up
- [ ] T84.x for implant complications
- [ ] Correct 7th character (D) for injury healing-phase
- [ ] Z96.6x status code on long-term arthroplasty follow-up

**Documentation defense:**
- [ ] Conservative therapy enumerated before surgical recommendation
- [ ] Symptom duration and functional impact quantified
- [ ] Imaging findings interpreted in the note
- [ ] Named orthopedic tests documented with explicit results
- [ ] ROM in degrees, strength in MRC, sensation by dermatome

**Plan-to-Assessment trace:**
- For every Plan item (injection, imaging, brace, PT, surgery, medication, return-visit), confirm a corresponding Assessment Dx exists.

---

**Document authority:** ICD-10-CM Official Guidelines for Coding and Reporting, FY 2026; AHIMA / ACDIS 2026 query rules; payer-facing standards summarised from major U.S. commercial and Medicare audit positions current as of 2026.

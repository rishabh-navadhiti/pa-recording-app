# Procedure rubric packs (interventional pain — Costigan checklist engine)

These packs are the structured medical-necessity rubrics consumed by the **`cdi-costigan`** skill. Each file encodes one interventional-pain procedure family's coverage criteria as a checklist the skill evaluates a complete note against, item by item.

They are distinct from the general CDI standards one directory up (`../icd10_fy2026.md`, `../ahima_acdis_2026.md`, `../specialties/`), which the `cdi-review` skill uses. Same `standards/` tree, different consumer.

## Provenance

Every pack is derived from two layers of source, both authored by the Cedars-Sinai **Compliance & Revenue Integrity (CRI)** team and grounded in the governing Medicare **Local Coverage Determination (LCD)** + **Billing & Coding Article** for the MAC **Noridian** (jurisdiction J-E, California):

1. The **CRI per-procedure checklist** — the verbatim clinical-necessity criteria a reviewer checks. Item wording in these packs mirrors the checklist so the skill's output maps 1:1 to what an auditor checks.
2. The **CRI educational deck** — adds the CPT codes, covered ICD-10 lists, billing modifiers, frequency caps, and the audit backstory.

Each pack names its LCD + Article number in its header.

## Pack shape (every file follows this)

- **Header** — procedure name, governing LCD + Article, CRI checklist date, standards version.
- **Detection cues** — the phrases in a note that mean *this procedure is in play* (performed **or** requested/recommended — the notes are usually pre-authorization consults, so a *recommendation* counts).
- **CPT codes** — covered (Group 1) and non-covered (Group 2), with the level/laterality rules and modifiers (KX, -50).
- **Covered ICD-10** — the diagnoses that support medical necessity for this procedure's CPT. **Every code here has been validated against the ICD-10 MCP connector** (existence + billable-for-HIPAA). Where the LCD publishes a closed list (facet, TPI, SI, PVA) the pack carries it verbatim; where it does not (ESI), the pack says so and lists connector-validated *representative* codes by indication rather than asserting a closed set.
- **Checklist** — the medical-necessity criteria as evaluable items, split into:
  - *Initial / diagnostic* criteria,
  - *Repeat / therapeutic* criteria (the longitudinal thresholds: % relief, duration, prior-block counts),
  - *Frequency caps* per rolling 12 months,
  - *Documentation rules* (named scale at baseline + same scale at follow-up; functional index; specific dates; image guidance + contrast; 2-view films),
  - *Exclusions / non-covered indications*.
- **Verdict guidance** — how to roll the item results into an audit-readiness verdict for this procedure.

## The connector is ground truth

When this pack and the live ICD-10 connector disagree about whether a code exists or what specificity is available, **the connector wins** and the pack is the thing that is wrong — file an update. The packs are heuristics layered on the connector; they are the most error-prone part of the system. (This is the same discipline `cdi-review` and the ortho pack follow.)

A code that exists but is a **non-billable category header** (e.g. `M51.36`) must never be emitted as a suggested code — the connector's `valid_for_hipaa_transactions: false` is the signal.

## Update policy

- Sourced from CRI checklists + decks. When CRI revises a checklist (the decks carry a "Date Updated"), update the matching pack and bump its `**Standards version:**`.
- Re-validate any added or changed ICD code against the connector before committing it.
- Coverage rules are MAC-specific (Noridian / J-E). If the practice's MAC changes, the LCDs change — these packs would need re-sourcing.
- Keep item wording aligned to the CRI checklist text; auditors check against that wording.

## Files

| Pack | Procedure family | Governing LCD / Article |
|---|---|---|
| `esi.md` | Epidural steroid injection (TFESI / CESI / ILESI) | LCD L39240 · Article A58993 |
| `facet.md` | Facet joint interventions (IA / MBB / RFA / cyst) | LCD L38801 · Article A58403 |
| `tpi.md` | Trigger point injection | LCD L34211 · Article A57701 |
| `si.md` | Sacroiliac joint injection / denervation | LCD L39462 · Article A59244 |
| `pva.md` | Percutaneous vertebral augmentation for VCF | LCD L34228 · Article A56572 |

ESI is the most fully developed (the audited procedure + the physician's highest-volume one).

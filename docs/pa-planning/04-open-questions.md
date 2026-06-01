# Open questions

Things that need answering before a concrete plan can be written. Grouped by who has the answer.

**Answer round 1 — rish, 2026-05-15.** Inline below each question. Unanswered ones are flagged with **STILL OPEN**.

**Answer round 2 — rish, 2026-05-15.** Tagged inline as **[Round 2]**. Some questions explicitly deferred — rish wants to understand Fahd's MCP, the ICD-10 + AHIMA docs, and the full feature overview *first* before deciding scope. Decisions to follow in subsequent messages.

---

## For rish (product / business context)

1. **Is "Physician Assist" a separate product or the next phase of the recording-app?**
   This shapes everything. If it's the next phase → absorb into our app (Option A in [03-architecture-observations.md](03-architecture-observations.md)). If it's a sibling product Fahd will distribute separately → we produce notes + standardized handoff, he runs the rest.

   **Answer (2026-05-15):** **Option A in spirit** — absorb into the recording-app as new skills. Potentially Option B (sibling app) or a mix of both in the future. **Important caveat:** don't narrow the vision down to *just skills*. Claude also has agents, managed agents, plugins. Other AI-based or agentic workflows are worth exploring later. We may also need open self-hosted models for some cases. For now, to ship a good deterministic prototype, we stick with skills.

2. **Who's actually paying / what's the deliverable to Fahd?**
   - The recording-app (which his scribes already use)?
   - Recording-app + CDI features?
   - A full clinical-ops platform replacing his Vercel/MCP exploration?
   Different answers, different timelines.

   **Answer (2026-05-15):** Build out the *platform*. The current scribes (Fahd's) work with the doctors we've onboarded (Harris, Sabbag, Spencer, Park, Ryan, Tsai, Dietrick, and a few more coming). Fahd also has potential clients for other specialties. So the deliverable is broader than the recording-app alone — it's the platform.

3. **Phase 2 demo timeline / target?**
   Does Fahd want a demo "soon" (weeks) or is this Q3-26 work? Influences scope cuts.

   **Answer (2026-05-15):** **CDI by next week** — that's the immediate ask Jayanth gave. Plan and ship *some version* of CDI soon. The rest of the engines need more conversation and understanding before we can scope them.

4. **Specialty mix.**
   Current doctors (Harris, Sabbag, Spencer, Park, Ryan, Tsai, Dietrick) — are they all orthopedic/hand surgery? If yes, we can start CDI with **one specialty ruleset** and add others later. If mixed, we need the specialty selector up-front.

   **Answer (2026-05-15):** Mixed — confirmed: **Park is a gynecologist** (HRT / menopause / well-women). The others appear to be orthopedic/upper extremity. **For now focus on ortho** because we have the most data (Sabbag, Spencer profiles + ~170 sample notes each), can test easily, and rish can talk to the scribe. But we do need an understanding of everything in Fahd's vision because he has potential clients across other specialties. **Build the platform with specialty as a first-class concept; ship ortho ruleset first.**

5. **Workers Comp scope.**
   Is WC a real ask for our deliverable, or Fahd's broader vision? PR-4 is medical-legal and the riskiest thing in the whole platform — if it's not a near-term need, defer hard.

   **Answer (2026-05-15):** **PENDING — important.** Hold on this; we'll discuss shortly.

6. **Patient summaries.**
   Real ask or future? Generating a patient-facing pocket card in Spanish/Mandarin/Tagalog for every visit is real engineering work *and* real token cost.

   **Answer (2026-05-15):** **STILL OPEN.** Not addressed in this round.

7. **Has Fahd seen our app yet?**
   You mentioned a demo is pending. A lot of his architectural assumptions would dissolve once he sees what's already built. Worth doing this demo before committing to a plan.

   **Answer (2026-05-15):** Done. Demo has been shown to Fahd. Shouldn't change the immediate planning — he'll keep what he saw in mind for future conversations. **Start planning now.**

8. **Provider queries — what happens to them?**
   Currently the scribe is the only audience. CDI provider queries are meant for the doctor. Does Fahd's workflow have a delivery mechanism (email / EMR message / printed)? Or do they just live as text in the case folder?

   **Answer (2026-05-15):** **STILL OPEN.** Not addressed in this round.

9. **HIPAA / BAA.**
   Fahd's docs note "demo mode only — de-identified data". Is anyone actually de-identifying notes today before they hit Anthropic? If real patient names are flowing, we have a compliance problem to flag explicitly regardless of feature plans.

   **Answer (2026-05-15):** Right now Anthropic gets everything. Notes may or may not contain patient names — depends case by case. **Plan:** move to the direct Anthropic API later and execute the HIPAA / BAA process with Anthropic. Not a blocker for prototyping.

---

## For Fahd (via Jayanth)

10. **What's the priority order for the 8 engines?**
    If we can only ship 2 in the first cut, which 2? My guess: CDI Co-Pilot + E/M MDM scorer. But confirm.

    **Answer (2026-05-15, partial):** **CDI is the immediate ask** (per Jayanth, next-week target). The priority order for the rest is still being discussed.

11. **Where do the outputs live for the scribe?**
    A unified panel (his diagram) implies new UI. Inline with the SOAP note implies less UI. What does his scribe team prefer?

    **Answer (2026-05-15):** **Separate file** in the case folder for now. A new UI surface is useful and probably inevitable — but for now, plan it as an extension of the existing recording-app with **smart yet simple UI screens**. Once the core skills and workflow are sorted, the UI can evolve (could be web, could be a separate app, could be in the same app).

12. **What's "Auto-Pilot" actually solving?**
    Is it about *speed* (parallel execution) or *zero-touch* (no scribe intervention)? They imply different architectures.

    **Answer (2026-05-15):** Per Fahd's PDF, Auto-Pilot is a **mode to be enabled**. For our context: **run all engines automatically after every recording finishes and the SOAP note is generated.** A scribe processing ~30 files in one session can't trigger engines manually — auto-fire is the only realistic UX. This is a prototype-stage decision; we can change it anytime.

13. **Feedback loop — is the 85% target a real KPI?**
    Or is it aspirational marketing language? Affects how seriously we instrument it from day 1.

    **Answer (2026-05-15):** **STILL OPEN.** Not addressed in this round.

14. **The Vercel CDI app — what happens to it?**
    Kept as Fahd's demo surface? Decommissioned once production lands? Two products forever?

    **Answer (2026-05-15):** **STILL OPEN.** Not addressed in this round.

---

## Technical questions to resolve internally (rish + us)

15. **How do we serialize doctor specialty?**
    Add `specialty` field to each doctor in `settings.json` doctors[]. What's the closed enum?
    *Suggested:* Hospitalist, Orthopedics, Cardiology, ENT, OB/GYN, Oncology, Pulmonology, Emergency Medicine, Pain Management/Spine — same list Fahd uses.

16. **Where does CDI output land in a case folder?**
    Candidates:
    - `<case>_soap_note.md` gets a new `## CDI Review` section
    - `<case>_cdi.md` separate file alongside soap_note
    - `<case>_cdi.json` structured, with a renderer for the UI

    My preference: structured JSON for the app to display + a human-readable section appended to the .docx for the chart record.

    **Answer (2026-05-15):** **Separate file** for now. New UI is useful and probably inevitable — but for now, plan as an extension of the existing recording-app with smart simple UI screens. Once core skills and workflow are sorted, UI can evolve.

17. **How do we feature-flag this rollout?**
    Doctors who don't want CDI shouldn't pay the latency / token cost. A per-doctor `enableCdi: bool` in settings.json gates the pipeline step.

18. **Do we add a new tab, or extend Pre-chart?**
    Pre-chart is "edit a note with attachments". A CDI review is "show me what the AI thinks is missing from this note". Similar shape but different content. Could be:
    - A new tab "Review" alongside the three existing ones
    - A new mode inside Pre-chart
    - A floating panel attached to the Cases list

    Needs UX sketch before committing.

    **Answer (2026-05-15):** Plan as an **extension of the existing recording-app** with smart yet simple UI screens. Final form TBD — once the core skills and workflow are sorted, the UI can be anything (web app, in-app, separate app). For prototyping: in-app new screens.

    **Scribe-loop note (rish, 2026-05-15):** Engines will run on the **AI-generated note** itself (not the scribe-edited version), at least for the prototype. A scribe processing ~30 files in a session can't trigger engines manually after each edit. This is a prototype decision and can change anytime.

19. **Token / latency budget.**
    Each new engine = another `claude -p` call = another ~5–30s of latency + tokens. If we fire 5 engines per case, that's 25–150s of background work and 5x token cost. Need to (a) measure actual runtimes, (b) decide if engines are sequential or parallel, (c) decide which are always-on vs opt-in. Fahd's "20–24s" autonomous runtime is for *his* parallel-promise architecture — ours is currently sequential.

20. **Quality agent — does it block, or just annotate?**
    Fahd's design has the Quality Agent generate a "ready-to-submit" boolean. If false, what? Does the scribe see a warning? Is the .docx withheld? Probably annotation-only is the right call for v1 — blocking introduces error paths we don't need yet.

21. **Provider query repeat-blocking — where's the per-patient query log?**
    Fahd has `.pa_feedback_log.json`. We'd put it in `<NOTES_DIR>/.cdi_query_log.json`. Per-patient, per-topic, with a TTL (so old queries can re-fire after some time).

---

## Things to NOT decide yet

- Whether to use Anthropic fine-tuning (Fahd's Level 2). Too early.
- EHR integration (Fahd's Phase 3). Too early.
- Analytics dashboards (Fahd's Phase 4). Too early.
- Custom CDI rule editor (admin UI). Adds infra, no demo value.

Get the first vertical slice (CDI + E/M for one specialty, end-to-end) working before touching any of these.

---

## Round 2 — CDI-specific follow-ups (2026-05-15)

Asked after Round 1 to scope the CDI-by-next-week deliverable.

A. **CDI ruleset content source.** Use Fahd's `specificity_v2026.json` + yaml packs *as-is*, or re-derive the ortho subset from the official FY2026 ICD-10-CM PDF + AHIMA/ACDIS docs?

**Answer (2026-05-15):** **Pending.** Rish wants to understand Fahd's MCP files, the ICD-10-CM PDF, and the AHIMA/ACDIS content first before deciding. Discussion to follow in subsequent messages.

**Note (Claude, 2026-05-15):** Jayanth has also produced 4 CDI skill files at `~/Downloads/`:
- `CDI_SKILL_ORTHOPEDICS.md` (~18.7 KB)
- `CDI_SKILL_CARDIOLOGY.md` (~21 KB)
- `CDI_SKILL_FAMILY_MEDICINE.md` (~23 KB)
- `CDI_SKILL_WORKER_COMP.md` (~28 KB — explicitly chains AFTER CDI; takes both SOAP and CDI-edited note as inputs)

These are derived directly from the FY2026 official guidelines, cite specific guideline sections (Sec I.B.2, Sec I.C.13.b, etc.), and are structured as agent instructions. They appear more rigorous and closer to ship-ready than Fahd's packs. **Need to evaluate Jayanth's files alongside Fahd's content before deciding the source.**

B. **What goes into the CDI output file for v1?** Flags / confidence / DRG impact / HCC capture / evidence found+missing / queries / quality score?

**Answer (2026-05-15):** **Pending.** Rish wants full CDI understanding (Fahd's PDF + rule content) before deciding what's in v1.

C. **Operating modes.** Compliance / Balanced / Aggressive — one default or expose the toggle from day 1?

**Answer (2026-05-15):** **Pending.** Same reasoning — needs full CDI understanding first.

D. **Per-doctor enable/disable.** Auto-fire for every doctor, or `enableCdi: true` per-doctor in settings?

**Answer (2026-05-15):** **Yes, need an enable/disable setting.** Default **disabled** for now, until there's a way to determine and store doctor specialty (which drives which CDI ruleset to apply). CDI doesn't auto-fire until: (1) doctor has a specialty, and (2) CDI is explicitly enabled.

E. **Provider queries in v1, yes or no?**

**Answer (2026-05-15):** **Assume no — defer for v1.** Rish wants to understand all of CDI first. Provider queries become a v1.1 follow-up once gap-flagging is working.

F. **CDI on existing cases.** Newly-recorded only, or runnable on existing cases via Pre-chart-like trigger?

**Answer (2026-05-15):** **Newly-created only for now.** Add a UI option later to manually select previous patient case folders and run CDI on them.

G. **Specialty field on the doctor.** Closed enum matching Fahd's 9 specialties, or freeform string?

**Answer (2026-05-15):** **Stick to Fahd's list** (closed enum). Rish will clarify the exact list with Fahd, and confirm whether more specialties are anticipated soon. **Action item for Jayanth conversation:** confirm the closed enum of specialties.

---

## Decisions deferred pending CDI deep-dive (2026-05-15)

Rish wants to go deep on three things *before* finalizing CDI scope:
1. **What Fahd's MCP files actually do** — `pa_agents.py`, `pa_standards.py`, the standards packs.
2. **What the ICD-10-CM FY2026 guidelines + AHIMA/ACDIS rules cover** at the level we'd build against.
3. **What Fahd's full feature overview describes** — the 8 engines + Auto-Pilot + ambient integration + learning loop.

Then decide scope for CDI v1. Each of (1)/(2)/(3) is its own conversation in upcoming messages.

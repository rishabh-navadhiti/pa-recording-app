# Heavy / multi-agent / research tasks — run queue

Big runs that aren't part of normal day-to-day work: multi-agent (ultracode/Workflow) audits,
`/goal`-driven builds, deep-research sweeps, bake-offs, analytics passes. They burn a lot of tokens,
so **rish runs them deliberately (nights / weekends)**, not mid-day.

**Convention:** add a task under *Queued* with enough detail to run it cold. When it's done, move it to
*Done* with a one-line outcome + date. Keep entries self-contained.

---

## Queued

### 1. CDI + engines deep review (connector-validated, multi-lens)
- **What / why:** independent audit of the CDI skill + cdi-costigan + all standards packs + the engine
  framework, to confirm the "sources of truth" are correct and surface improvement opportunities. We care
  most about coding correctness (a hallucinated code reaching a chart is the nightmare — cf. the De Quervain bug).
- **How to run:** the Workflow already exists. 5 review lenses (coding / clinical / prompt / architecture /
  fresh-on-Fable) → adversarial verify each finding → ranked report. Re-launch:
  `Workflow({scriptPath: "/Users/rish/.claude/projects/-Users-rish-Development-recording-app/e72bf46e-6763-4ace-90a3-44b172723595/workflows/scripts/cdi-engine-review-wf_68f5e2f8-9d3.js"})`
  (Resume-with-cache is same-session only, so a fresh night run re-runs all 5 lenses — fine.)
- **Inputs:** none beyond the repo (it reads notes-claude/skills + standards + src/engines). Needs the
  ICD-10 connector available for the coding lens.
- **Output:** ranked, verified findings (severity + evidence + fix) + a per-lens "near-optimal vs improvable" take.
- **Est. cost:** ~15 agents, ~750k tokens, ~3–5 min. **Night job.**
- **Partial run done 2026-06-11** (hit session limit; only `prompt` + `architecture` lenses completed). Leads already surfaced (re-verify on the full run):
  - `render()` is dead code — `runEngine` never calls it; plan doc says "resolved" while CLAUDE.md §7 says "open." Reconcile.
  - CDI quality scores are deterministic formulas but computed by the LLM by hand → drift risk; move to the Python renderer.
  - `reimbursement_impact` is free-text → unaggregatable as a billing field right before Engine 3 starts populating it.
  - Full output saved: `/private/tmp/claude-501/-Users-rish/e72bf46e-6763-4ace-90a3-44b172723595/tasks/w63cc6za5.output`
- **Status:** Queued (partial leads captured above).

### 2. Eval-framework calibration run
- **What / why:** the eval framework (`/Users/rish/Development/PA/Evaluation`) is **unvalidated until calibrated** —
  every verdict is untrustworthy until the bar is proven. Prerequisite for #3.
- **How to run:** README §8 — (a) gold-ceiling (human-final charts must score high), (b) mutation probes
  (degrade a gold note, confirm the right dimension drops / the gate fires), (c) flip-rate (eval the same
  note N times, `score.py --aggregate`, reword flippy items), (d) divergence demo (terse-correct note →
  payer-low/doctor-high). Tune the provisional knobs (§9) only after.
- **Inputs:** a few gold human-final charts (+ transcripts where available).
- **Output:** confidence that the rubric/score thresholds are right; tuned `base_rubric.md` / `score.py` knobs.
- **Est. cost:** moderate (a handful of `evaluate-note` runs + repeats). **Night/weekend.**
- **Status:** Queued (rish running first tests soon).

### 3. Model bake-off — Fable 5 vs current scribe model
- **What / why:** decide whether Fable (or any candidate) should power the live note-writer, **proven against
  human-final charts** rather than vibes. The principled answer to "is Fable worth switching to."
- **How to run:** eval framework §6 — Phase 1: regenerate notes from N transcripts with each candidate
  (`generate-note --model fable` vs current). Phase 2: `evaluate-note` each candidate vs the human reference,
  all 4 layers, **one fixed judge model**, N≥3 reps. Then `score.py --aggregate` → `leaderboard.md` + `flip_report.md`.
- **Inputs:** transcript + human-final-chart **pairs** (data request to scribes; span terse↔verbose doctors).
- **Output:** leaderboard (per-model composite + per-layer + gate counts) → switch / don't-switch decision.
- **Prereq:** #2 (calibration). **Est. cost:** high (N cases × M models × ≥3 reps). **Weekend.**
- **Status:** Queued (blocked on calibration + gold-pair data).

### 4. Deep DB / cost analytics pass
- **What / why:** understand real usage + spend — cost & tokens per engine, per doctor, per case; latency;
  outliers; which steps dominate. Informs model choices and where to optimize.
- **How to run:** multi-agent analysis over `<NOTES_DIR>/app.db` (`processing_events`, `cases`) + `app.log`
  token/cost lines. Fan out by dimension (per-engine cost, per-doctor volume, failure/skip rates, time trends) → report.
- **Inputs:** a representative `app.db` + `app.log` (dev or a consenting install).
- **Output:** a cost/usage report + concrete optimization targets.
- **Est. cost:** moderate. **Weekend.**
- **Status:** Queued.

### 5. New-models / opportunities research
- **What / why:** stay current — Fable 5 capabilities/pricing/benchmarks, new ICD/coding or medical-NLP tools,
  competitor CDI/scribe products, relevant regulatory shifts (FY2027 ICD-10, E/M changes).
- **How to run:** `deep-research` skill (fan-out web + adversarial verify + cited report), one focused question per run.
- **Output:** a cited briefing → feeds roadmap / model decisions.
- **Est. cost:** moderate. **Weekend.**
- **Status:** Queued.

---

## Done

### Full codebase analysis → refactor plan
- `/goal` + ultracode, multiple agents inspecting all aspects of the codebase, producing the modularization /
  engine-framework refactor plan. Delivered the Phase 0–5 refactor program (`docs/refactor/`), now merged to `develop`.
- **Outcome:** shipped (refactor Phase 0–5 merged via PR #80). ✅

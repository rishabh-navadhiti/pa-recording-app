# Plan — Multi-Patient Note Generation via the API (Phase 1 / M2)

**Date:** 2026-06-18
**Builds on:** [single-call note-generation plan](2026-06-18-single-call-note-generation.md) (Phase 1 / M1) and the [condensed note-gen prompt](../notes/2026-06-18-condensed-notegen-prompt.md) (now multi-patient-aware).
**Scope:** add multi-patient handling to the **API** note-gen path only. The agentic CLI path keeps its existing native multi-patient behaviour. Single-patient API is M1; this is M2.

---

## 0. The approach (decided)

One API request = one response, so we **don't** cram N notes into one reply. Instead: **detect → bail → fan out**, where every note is produced by the **proven single-patient call**.

```
generateSoapViaApi(case)                      ← normal (non-targeted) call
  └─ manifest.multi_patient === false  → write 1 note → runCaseChain   (M1, unchanged)
  └─ manifest.multi_patient === true   → DETECTION (no note); fan out:
        for each cases[i].patient_name:
            generateSoapViaApi(case, target = cases[i].patient_name)   ← TARGETED single-patient call
            → write <recording_folder>/<slug>_soap_note.md
        build a synthetic generate-note manifest (multi_patient:true, cases[].soap_note_md = files just written)
        → runMultiPatientChain(ctx, { …, manifest })                   ← EXISTING, unchanged
```

Single-patient stays **one call** (detection is folded into the normal call — Rule 6 early-bail). Multi-patient = **1 detection + N targeted calls**, each the reliable single-patient unit. Downstream (`runMultiPatientChain`) is untouched.

---

## 1. Current contract to honour (`src/pipeline/chain.js`)
`runMultiPatientChain(ctx, opts)` (chain.js:67) today consumes the `generate-note` manifest: `planChildCases(manifest)` → for each `ok`/`partial` case it **creates a child folder** (`<slug>_<YYYY-MM-DD>/`), **copies the parent MP3 + transcript.md + transcript.docx** in, **copies the SOAP `.md` in renamed** to `<folder>_soap_note.md`, inserts a child `cases` row (`dbCases.createCase`), then runs `runCaseChain` per child. It reads the per-case `.md` from the paths in `manifest.cases[].soap_note_md`, which the **skill used to write into the recording folder**.

**So the only thing that changes:** in the API path, **the app** writes those per-patient `.md` files into the recording folder (the skill no longer does), then hands `runMultiPatientChain` a manifest whose `cases[].soap_note_md` point at them. Everything `runMultiPatientChain` does after that is identical.

---

## 2. Changes (all in the API note-gen path; additive)

### 2.1 `generateSoapViaApi` gains a `targetPatient` arg + a fan-out branch
Signature: `generateSoapViaApi(ctx, { transcriptAbsPath, soapNoteMdPath, recordingFolder, caseTag, templatePath, caseId, doctor, targetPatient = null })`.
1. Build inputs (M1) — `buildSingleCallNoteGen(...)`. **If `targetPatient`**, add the targeted line to the user message's INJECTED FACTS (`Target patient (multi-patient fan-out — generate ONLY this patient…): <targetPatient>`) and inject `Patient Name: <targetPatient>`.
2. `ctx.api.runSingleCall(...)` → `splitNoteAndManifest(text)`.
3. **Branch on the manifest:**
   - `multi_patient === false` (single or targeted) → write `noteBody` to the app's path, return `{ mode:'note', manifest }` (M1 behaviour).
   - `multi_patient === true` **and `targetPatient` is null** → this is a **detection**; return `{ mode:'detected', cases: manifest.cases }` (no file written).
   - `multi_patient === true` **and `targetPatient` set** → unexpected (a targeted call should never bail); **do not recurse** — mark that patient failed + `[DEV-ALERT]`, return `{ mode:'error' }`.

### 2.2 The orchestrator (in `spawnSoapGeneration`, API mode)
After the first (non-targeted) `generateSoapViaApi`:
- `mode:'note'` → feed the manifest to the **same** post-skill logic → `runCaseChain` (M1, done).
- `mode:'detected'` → **fan out**:
  1. For each `c` in `cases` (skip entries with no usable `patient_name` → flag): derive `slug` from `c.patient_name` using the **same sanitisation rule the skill used** (lowercase, ws→`_`, strip non-`[a-z0-9_-]`, collapse `_`, `unknown_<n>` fallback). Target path = `<recordingFolder>/<slug>_soap_note.md`.
  2. `generateSoapViaApi(..., soapNoteMdPath = targetPath, targetPatient = c.patient_name)` → writes the note (sequential is fine and reuses the warm template cache; small concurrency optional — N is usually 2–3).
  3. Collect successes into a **synthetic `generate-note` manifest**: `{ schema_version:1, skill:'generate-note', status, multi_patient:true, recording_folder, cases: [ { patient_name, doctor_lastname, visit_type, chief_complaint, soap_note_md: targetPath, status } … ] }` — exactly the shape `planChildCases`/`runMultiPatientChain` already expect.
  4. `runMultiPatientChain(ctx, { …, manifest: syntheticManifest })` — **unchanged**; it makes the child folders, copies MP3/transcript, inserts child rows, runs `runCaseChain` per child.

### 2.3 Where the patient names come from
For multi-patient, the **detection manifest** supplies the names (the patient-name form only carries one name per recording). The targeted calls inject those detected names. (Single-patient still uses the form name — M1.)

### 2.4 Usage / cost
Each call logs its own normalized `processing_events` row (M1's writer): multi-patient = **1 detection row + N note rows**, all `job_kind='soap'`. The detection row is cheap (no note output). No schema change.

### 2.5 Failure / safety
- A failed targeted call fails **only that patient** (mark `partial`/`failed` in the synthetic manifest; the others still run); `[DEV-ALERT]` + scribe `service-warning`.
- Never recurse a targeted call (§2.1 guard) — no infinite loops.
- If detection returns zero usable names, fall back to single-note behaviour on the whole transcript + flag (don't silently drop the case).
- All additive: CLI multi-patient path and `runMultiPatientChain` internals unchanged; no DB migration.

---

## 3. Tests
- **Fake `ctx.api`** scripted: first (non-targeted) call → a `multi_patient:true` detection manifest with 2 names; subsequent **targeted** calls → single-patient notes. Assert: 2 `.md` files written into the recording folder with correct slugs, a synthetic manifest built, `runMultiPatientChain` invoked, 2 child folders + child `cases` rows created (with fake icd/cdi/docx).
- Unit: slug derivation matches the skill's rule; synthetic-manifest shape matches `planChildCases`'s expectations; the targeted user-message includes the target line.
- Edge: detection with a `null`/unclear name → `unknown_<n>` + flag; a targeted call that erroneously returns `multi_patient:true` → error-flag, no recursion.

---

## 4. Sequencing
This is **M2** — ship **after** M1 (single-patient API) is solid on staging. Tonight's M1 still **degrades-and-flags** multi-patient. M2 removes the degradation by adding the fan-out above. No prompt change needed beyond the already-updated [condensed prompt](../notes/2026-06-18-condensed-notegen-prompt.md) (Rules 6–7).

---

## 5. Open decisions for the implementer
- **Targeted calls: sequential (warm-cache, cheaper) vs small-concurrency (faster).** Default sequential; N is small. Revisit only if a doctor routinely has many patients per recording.
- **Visit-type / chief-complaint in the synthetic manifest:** take them from each targeted call's own returned manifest (preferred) rather than the detection pass.
- **Transcript isolation:** targeted calls get the **full transcript + the target name** (model self-segments — simplest, most robust). Do *not* pre-slice the transcript in the app.

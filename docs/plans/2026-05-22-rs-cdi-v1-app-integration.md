# CDI v1 — Part 2: App integration (+ ICD step re-implementation)

**Status:** Planned. Plan 2 of 2 in the CDI v1 effort (Plan 1 was the skill + standards files, already merged to `develop`).

**Scope of this plan:** Two phases delivered in one branch, one PR.

- **Phase 1 — ICD step re-implementation.** Rebuild the ICD-10 coding pipeline step natively on top of `develop`'s current architecture (SQLite, multi-patient child-folder split via `parseSkillManifest`, token logging). The original implementation on the `icd10-coding` branch is used as read-only reference material. See [⚠ Critical branch + implementation strategy](#-critical-branch--implementation-strategy--read-first) below for the reasoning.
- **Phase 2 — CDI integration.** Wire the `cdi-review` skill (already on develop from Plan 1) into the pipeline. Add the UI, DB, status reporting, settings, and ICD-awareness behavior the skill needs to ship as a real product feature. Build on top of the existing SQLite layer, the existing skills-sync mechanism, and the existing `spawnDocxConversion` pattern.

**Out of scope:**
- Provider query generation (Engine 1 sub-feature 1.43+, 🟡 v1.1)
- HCC scoring (1.33–1.35, 🟡 v1.1)
- Confidence-gated routing UI (1.40–1.42, 🟡 v1.1)
- Pre-AI rules-engine prefilter (1.48–1.50, 🟡 v1.1)
- Documentation Defense additions (1.54–1.60, 🟡 v1.1)
- Additional specialties beyond orthopedics (1.20–1.28, 🔵 Phase 2+)
- Upgrading `cdi-review` to emit the structured JSON manifest format the unification plan established for `generate-note`. Listed in that plan's "Future work" and remains a v1.1 follow-up — in v1, CDI uses its existing terminal-line contract (`CDI_OK:` / `CDI_FAIL:` / `CDI_SKIPPED:`).
- A separate CDI-specific docx converter (out of scope — we use the *existing* `python/md_to_docx.py` for all docx generation in this app, including CDI's `<case>_cdi.docx`. If the existing converter needs styling extensions to handle the CDI markdown well — severity-coloured cells, highlighted ICD code blocks, etc. — extend the existing script in-place. Do not create a parallel CDI converter.)

---

## ⚠ Critical branch + implementation strategy — read first

**Both phases land in a NEW branch off `develop`. The `icd10-coding` branch is kept as read-only reference and is NOT merged.**

### Why not merge `icd10-coding`?

`icd10-coding` and `develop` have diverged significantly since the merge base at `75f963f`:

- `develop` has +21 commits including the SQLite metadata store, the staging-branch infrastructure, the token-usage logging via `spawnClaude`, Plan 1's CDI skill + standards files, and (in-flight) the docx-unification rewrite of `generate-note` + multi-patient child-folder split. `main.js` changed by ~1138 lines.
- `icd10-coding` has +3 commits: the `add-icd-codes` skill, the MCP config, and the `spawnIcdCoding` function (~112 lines in `main.js`). All three were written against the *old* single-case pipeline.

Merging `icd10-coding` into the post-unification branch produces large conflicts in `main.js` (both branches rewrote the pipeline section in incompatible ways), `CLAUDE.md`, `docs/ARCHITECTURE.md`, and `python/md_to_docx.py`. More importantly, even if the merge succeeded, the ICD step would still be wired for the *old* single-case pipeline — it would need rewriting anyway to handle the new multi-patient per-child execution model that the unification plan introduced.

So: it's strictly less work to re-implement the ICD step from scratch against the new architecture, using `icd10-coding` as a read-only reference for *what to build*, than to do the conflict resolution + then rewrite.

### The strategy

```
develop (latest)  ──►  cdi-v1 (new branch, off develop)
                          ├─ Phase 1: re-implement ICD step natively
                          ├─ Phase 1 dev verification (rish, on real machine)
                          ├─ Phase 2: implement CDI integration (this plan, §A–§J)
                          ├─ Phase 2 dev verification (rish, on real machine)
                          └─ PR ──► develop

icd10-coding   ────────►  kept as read-only reference. NOT merged. NOT deleted yet.
                          After cdi-v1 lands on develop and the new ICD step is
                          verified working in production-shape conditions, the old
                          icd10-coding branch can be archived (locally deleted; the
                          remote tip optionally tagged for posterity).
```

### Mandatory pre-implementation sequence

```bash
# 1. Confirm develop is at the latest committed state (including the docx
#    unification work). The user (rish) commits + pushes that work before the
#    implementation session starts.
git checkout develop
git pull origin develop
git log -1 --oneline                      # confirm latest commit matches expectations

# 2. Create the new branch off develop.
git checkout -b cdi-v1                    # name is suggestive; rish can rename
                                          # to something else (e.g. physician-assist-engine-1)
                                          # if preferred — the plan is branch-name agnostic.

# 3. DO NOT merge icd10-coding in. It's reference-only from here on.
```

### Reading icd10-coding without checking it out

The implementation session reads `icd10-coding`'s ICD step source files via `git show` and `git diff` from inside the new `cdi-v1` branch:

```bash
# The skill itself
git show icd10-coding:notes-claude/skills/add-icd-codes/SKILL.md

# The MCP config the skill uses
git show icd10-coding:notes-claude/.mcp.json

# The spawnIcdCoding function and its caller. Look at the diff between develop
# and icd10-coding to scope what's new on icd10-coding:
git diff origin/develop..origin/icd10-coding -- main.js
git diff origin/develop..origin/icd10-coding -- python/md_to_docx.py    # any helpers added
git diff origin/develop..origin/icd10-coding -- renderer/status.css     # status UI hooks

# Plan history
git show icd10-coding:docs/plans/2026-05-13-rs-icd-coding.md
git log icd10-coding --oneline | head -10
```

### Phase order — strict

1. **Phase 1 first.** Re-implement the ICD step in `cdi-v1`. Verify with the Phase 1 dev checklist (rish runs it). Commit Phase 1 work as one or more commits with clear messages.
2. **Phase 2 second.** Implement the rest of this plan (§A onwards) on the same branch, on top of Phase 1's commits. Verify with the Phase 2 dev checklist (rish runs it).
3. **One PR back to develop** with both phases. The PR description includes both dev verification checklists.

Phase 1 and Phase 2 do NOT split into two PRs — they share the same branch and ship together, because Phase 2 depends on Phase 1 being in place (the CDI skill's ICD-aware behavior needs the codes to actually be in the SOAP note).

---

## Context to read

Read first to ground yourself. All paths are in repo root unless marked `(on icd10-coding)`.

**Always-relevant (current architecture):**

- `CLAUDE.md` — repo conventions, code map, IPC table, skill prompt signatures (Don't-Touch §4 documents the JSON manifest contract `generate-note` now emits and the `cdi-review` terminal-line contract this plan integrates against).
- `docs/ARCHITECTURE.md` — pipeline sequence diagram, IPC channels, file system layout (current includes multi-patient child-folder flow).
- `docs/DECISIONS.md` — recent entries on SQLite (2026-05-18), CDI v1 architecture (2026-05-19), the soft-target amendment (2026-05-22), and the docx unification entry (2026-05-22).
- `docs/plans/README.md` — current in-flight plan index.
- `docs/plans/2026-05-22-rs-unify-docx-generation.md` — the unification plan (now landed on develop). Lays out the JSON manifest schema, the `parseSkillManifest` helper, and the per-child execution model that Phase 2 must mirror.
- `parseSkillManifest.js` — the defensive manifest parser at repo root. Used by `main.js` in the SOAP close handler and ready to use for any other skill that adopts the JSON manifest format.
- `main.js` — read `spawnSoapGeneration`'s close handler end-to-end. It calls `parseSkillManifest`, branches on `multi_patient`, and orchestrates the per-child copy → docx → DB-insert flow. This is the pattern Phase 1 and Phase 2 both extend.
- The existing `spawnDocxConversion` function in `main.js` — the per-file invocation pattern.
- `db/cases.js` — read the multi-patient child-row insertion logic. CDI's per-row column updates mirror it.
- `docs/pa-planning/05-engines.md` — Engine 1 sub-features with status markers. Phase 2 implements the 🟢-marked items that are app-side (UI / DB / pipeline).

**Plan 1 (the CDI skill, already on develop):**

- `docs/plans/2026-05-19-rs-cdi-v1-skill.md` — Plan 1 (the skill spec). The contract Phase 2 integrates against.
- `notes-claude/skills/cdi-review/SKILL.md` — the skill itself. Read end-to-end. Pay attention to: argument parsing in Step 0a, specialty gate in Step 0b, mode behavior in Step 3, terminal-line contract in Step 9 (`CDI_OK:` / `CDI_FAIL:` / `CDI_SKIPPED:`).
- `notes-claude/skills/cdi-review/TESTS.md` — the standalone test scenarios used during Plan 1 validation. Useful reference for the kind of cases Phase 2 will pipe through.
- `notes-claude/standards/icd10_fy2026.md`, `notes-claude/standards/ahima_acdis_2026.md`, `notes-claude/standards/specialties/orthopedics.md` — the standards files the skill loads at runtime.

**Phase 1 reference (read via `git show`; do NOT check out):**

- `(on icd10-coding) notes-claude/skills/add-icd-codes/SKILL.md` — the ICD skill as previously written. Read it; you'll likely copy it to `cdi-v1` largely as-is.
- `(on icd10-coding) notes-claude/.mcp.json` — MCP server config for the ICD step.
- `(on icd10-coding) main.js` — `spawnIcdCoding` function. Read via `git diff origin/develop..origin/icd10-coding -- main.js`. **Do not copy the spawn function verbatim** — the call site needs to be rewritten for per-child execution against `develop`'s new SOAP close handler.
- `(on icd10-coding) docs/plans/2026-05-13-rs-icd-coding.md` — the original ICD plan. Useful for understanding the design intent (which connector to use, the appended-codes format, etc.).

---

## Deliverables — Phase 1: ICD step re-implementation

This phase rebuilds the ICD-10 coding pipeline step in `cdi-v1`, using `icd10-coding` as read-only reference. Three deliverables: the skill, the MCP config, the spawn function + pipeline wiring.

### 1.1 — `add-icd-codes` skill

Copy `notes-claude/skills/add-icd-codes/SKILL.md` from `icd10-coding` into `cdi-v1` at the same path:

```bash
git show icd10-coding:notes-claude/skills/add-icd-codes/SKILL.md > notes-claude/skills/add-icd-codes/SKILL.md
# (mkdir -p the directory first if needed)
```

Read the skill end-to-end after copying. The skill's prompt signature and SKILL.md content can transfer largely as-is — it operates on a single SOAP `.md` file at a time, which is already the per-child execution model we want. **If the skill's input contract assumes a single soap_note path, that's correct — main.js will invoke it once per case folder (parent in single-patient runs; each child in multi-patient runs).**

Per the original implementation, the skill:
- Reads the soap_note.md content
- Uses the claude.ai ICD-10 MCP connector to look up + validate codes
- Appends an ICD codes table to the soap_note.md (default format: markdown table with columns *Diagnosis | Code | Description* — see the `Example.png` reference Fahd shared)
- Emits a terminal line the app can grep for

**Verify after copy:** the skill's prompt signature matches whatever signature `spawnIcdCoding` in §1.3 below will use. The signature in CLAUDE.md "Don't touch" §4 should be updated to include the icd skill's signature in Phase 1.

### 1.2 — MCP config

Copy `notes-claude/.mcp.json` from `icd10-coding`:

```bash
git show icd10-coding:notes-claude/.mcp.json > notes-claude/.mcp.json
```

This is the claude.ai ICD-10 MCP connector configuration. It works as-is — no per-child changes needed at the MCP layer.

### 1.3 — `spawnIcdCoding` function in main.js

**Do NOT copy `spawnIcdCoding` verbatim from `icd10-coding`.** The original was wired into the *old* single-case pipeline. The current pipeline (post-unification) is manifest-driven and per-child for multi-patient. Re-write the spawn function natively against the current `main.js`:

```js
async function spawnIcdCoding({ soapNoteMdPath, doctor }) {
  // 1. Read the soap note path from arguments (not derived from caseDir — the caller
  //    passes it explicitly because in multi-patient runs there's one soap_note.md
  //    per child folder).
  // 2. Build the structured prompt per the skill's signature (see CLAUDE.md §4).
  // 3. Use the spawnClaude wrapper. Inherit token-logging + stream-json parsing for free.
  // 4. Capture stdout, grep for the skill's terminal line (e.g. ICD_OK: / ICD_FAIL: /
  //    ICD_SKIPPED:). Confirm the skill's actual terminal-line shape by reading
  //    its SKILL.md Step 9 (or equivalent).
  // 5. Record a processing_events row with job_kind='icd', case_id pointing to the
  //    case row (single-patient: the parent; multi-patient: the child case row that
  //    owns this soap_note.md).
  // 6. NON-BLOCKING. Failure (MCP auth issue, model error, network) is logged and
  //    surfaces via service-warning IPC, but does not throw — the pipeline falls
  //    through to CDI and docx anyway. A note without codes is still useful.
}
```

**Call sites in the SOAP close handler:**

The current close handler in `main.js` (post-unification) is structured as:

```js
// pseudocode of current shape
function onSoapClose(stdout, parentCaseRow) {
  const manifest = parseSkillManifest(stdout)
  if (!manifest || manifest.status === 'failed') { /* mark failed, stop */ return }

  if (!manifest.multi_patient) {
    // Single-patient path. Verify file exists, run docx, hide, update parent row.
    await spawnDocxConversion(manifest.cases[0].soap_note_md)
    // ... DB update ...
  } else {
    // Multi-patient path. For each ok/partial case:
    for (const c of manifest.cases) {
      if (c.status === 'failed') continue
      // create child folder, copy mp3/transcript, copy soap.md in, docx, insert row
      // ... already implemented per unification plan ...
    }
  }
}
```

**Phase 1 wires ICD INTO that flow.** Per-case, after the SOAP `.md` is in its final location but **before** docx conversion:

- Single-patient: after the file-exists check, before `spawnDocxConversion`, call `await spawnIcdCoding({ soapNoteMdPath: manifest.cases[0].soap_note_md, doctor })`. If it fails or is skipped, log + continue — docx still runs.
- Multi-patient: inside the per-child loop, after `copyFileSync` of the soap.md into the child folder, before `spawnDocxConversion`, call `await spawnIcdCoding({ soapNoteMdPath: <child folder>/<patient>_soap_note.md, doctor })`. Per-child failures are logged + skipped; the child's docx still runs.

Key correctness points:
- **The ICD step runs on the FINAL location of the soap.md, not the recording-folder version.** In multi-patient runs that means it runs on the child folder's copy, not the parent (audit) copy. The parent (audit) copies retain whatever the skill originally wrote — they are *not* ICD-coded.
- **Per-child, sequential within a child folder.** Across children, parallel-vs-sequential is a separate design question (see §1.4 below).
- **CDI runs AFTER ICD on the same soap_note.md.** Phase 2 §C describes the full SOAP → ICD → CDI → docx sequence per case.

### 1.4 — Parallelism within multi-patient runs (decide during Phase 1)

The per-child loop in the SOAP close handler today (per unification plan) is sequential. ICD adds a 10–30 second Claude call per child. For a 5-patient recording that's an extra ~75–150s wall-clock if sequential, ~30s if parallel.

**Default for Phase 1: keep the loop sequential.** Each child case runs ICD → CDI → docx serially, then the loop moves to the next child. Reasons:

- Sequential is what the unification plan landed.
- Token rate-limiting is per-account, so parallel children share the same Anthropic quota — parallelism gives less wall-clock speedup than naive math suggests.
- Sequential keeps log readability (per-case log blocks don't interleave).
- The user-facing wait is already async — the popup shows progress, the scribe can start the next recording — so wall-clock for the slowest case to finish matters less than reliability.

**Future option (not Phase 1):** parallelize across children using `Promise.all`. Defer until there's a measured-need.

### 1.5 — Documentation updates (Phase 1)

Update in the Phase 1 commits (don't wait until Phase 2):

- `CLAUDE.md` Code map: add `notes-claude/skills/add-icd-codes/` line.
- `CLAUDE.md` "Don't touch" §4: add the `add-icd-codes` skill prompt signature.
- `CLAUDE.md` "Recording pipeline" section: add the ICD step between SOAP-close and docx, both single-patient and multi-patient paths.
- `docs/ARCHITECTURE.md`: pipeline sequence diagram + state machine; add ICD step.
- `docs/DECISIONS.md`: append entry explaining the re-implementation strategy (rather than merging `icd10-coding`).

Phase 1 also archives the original ICD plan:
```bash
git mv docs/plans/2026-05-13-rs-icd-coding.md docs/archive/plans/
# Remove the row from docs/plans/README.md as part of the same commit
```

### 1.6 — Phase 1 dev verification checklist (rish runs this)

**The implementation session does NOT run these tests.** They go in the PR description; rish runs them on a real desktop session before signing off on Phase 1.

- [ ] **Single-patient case, ICD succeeds.** Record a short clip with a known orthopedic complaint. Verify: SOAP `.md` written, ICD codes appended as a markdown table (Diagnosis | Code | Description), then docx generated with the codes baked in. `processing_events` has a `job_kind='icd'` row attached to the case.
- [ ] **Single-patient case, ICD fails.** Temporarily break the MCP config (rename the connector). Record a case. Verify: SOAP `.md` is written, ICD step logs a failure and emits `service-warning` IPC, `processing_events` row records the failure, **docx still runs**, the case's `cases` row is `status='completed'` (because the SOAP is useful even without codes).
- [ ] **Multi-patient case.** Use the known Spencer 5-patient transcript (or any multi-patient fixture). Verify: parent (recording) folder retains the originals; each child folder has `.md` + ICD codes + `.docx`. **Crucially: the parent's audit `.md` files do NOT have ICD codes appended** (ICD runs on the child copy, not the audit original).
- [ ] **Multi-patient with mid-run failure.** Force ICD to fail on the 2nd child (e.g. by killing the claude CLI process at the right moment). Verify: child 2's `.md` has no codes appended (or partial), child 2 still gets a `.docx`, children 1/3/4/5 finish normally.
- [ ] **DB integrity.** After several test cases (mix of single + multi), query `SELECT COUNT(*) FROM processing_events WHERE job_kind='icd'`. Should match the number of ICD runs (one per case in single-patient; one per child in multi-patient).
- [ ] **Token logging.** `SELECT SUM(cost_usd) FROM processing_events WHERE job_kind='icd'` non-zero.
- [ ] **Existing SOAP / docx flow still works for runs where the ICD skill isn't even installed.** Temporarily delete `notes-claude/skills/add-icd-codes/`. The SOAP pipeline should still produce a SOAP `.md` and a `.docx`; ICD step should fail-fast with a clean log, no crash.

Only after Phase 1's checklist passes does the implementation session start Phase 2.

---

## Deliverables — Phase 2: CDI integration

### A. ICD-aware behavior in the CDI skill (works with or without codes)

**Context:** On `icd10-coding`, the ICD step runs *immediately after SOAP generation* and *appends ICD codes directly to the SOAP note file* before CDI runs. So in production, the CDI skill will normally see a SOAP note that *already has codes assigned*. Older test cases (and any case where the ICD step fails) will have notes *without* codes. **The skill must handle both seamlessly.**

This is what Fahd's audit framework suggests architecturally (PDF 2 §10 "Ambient AI Workflow": SOAP → ICD specificity review → CDI completeness review — each step builds on the prior).

**Default ICD format the skill will see** (on the `icd10-coding` branch): a markdown table appended to the SOAP note with columns *Diagnosis | Code | Description*. Future enhancement (planned separately): the ICD step can also place codes inline within the note's existing structure if the doctor's template accommodates it.

**Design principle:** the skill **does not need a bash-based detection step**. The LLM is already reading the entire SOAP note in Step 1 as part of the analysis. If codes are present anywhere in the note — in a table at the end, inline within sections, in a list, in prose — the model sees them. The validation behavior is driven by the *prompt instructions*, not by a separate detection routine.

**Changes to `notes-claude/skills/cdi-review/SKILL.md`:**

1. **Step 3 (Analysis Prompt)** — add a new sub-section after "Additional Engine 1 sub-features":

   > ### ICD code validation (when codes are present in the SOAP note)
   >
   > Before producing flags, scan the SOAP note for any ICD-10 codes the note already contains. They may be in a table at the end (default format: *Diagnosis | Code | Description*), inline within sections, in the Assessment list, or anywhere the doctor's template places them.
   >
   > **If you find ICD codes already in the note:** validate them as part of your analysis.
   >
   > 1. For each existing code, verify it's supported by the documentation.
   > 2. Flag any code that's not supported (over-coding risk) as a `critical` flag of category `Audit-defense` with `current_code` populated.
   > 3. Flag any documented diagnosis that *should* have a code but is not in the existing list (under-coding risk) as a `warning` of category `Specificity`.
   > 4. Flag any code that doesn't match the documented Dx language (e.g., G56.00 unspecified when laterality is documented) as a `warning` of category `Specificity` with `current_code` populated.
   > 5. Populate the optional `code_validation` block in the output JSON (schema below) summarising the codes you found, which are supported, and which are flagged.
   >
   > **If you find no ICD codes in the note:** omit the `code_validation` field entirely from the output JSON. Proceed with the standard CDI analysis. Your `suggested_codes` arrays on individual flags still propose codes that *should* be assigned — that's the existing behavior for code-less notes and stays the same.

2. **Step 4 (Output JSON Schema)** — add a new optional top-level field `code_validation`:

   ```json
   "code_validation": {
     "codes_in_note": ["G56.01", "M65.341", "Z47.89"],
     "supported": ["G56.01", "Z47.89"],
     "flagged": [
       {
         "code": "M65.341",
         "issue": "Diagnosis is documented as 'trigger finger' without specifying digit. M65.341 (right ring finger) requires explicit digit documentation.",
         "linked_flag_id": "flag-002"
       }
     ],
     "missing_codes": [
       {
         "documented_dx": "Heberden's nodes at finger DIP joints",
         "suggested_code": "M15.1",
         "linked_flag_id": "flag-005"
       }
     ]
   }
   ```

   Omitted entirely when no codes were found in the note. The presence vs. absence of this field is the signal to downstream code (rendering, main.js, the floating status window) that validation happened.

3. **Step 8 (Markdown rendering)** — when `code_validation` is present in the JSON, render a new section `## Code validation summary` in the markdown, before the per-severity flag sections. Lists the codes-in-note, supported codes, flagged codes (with their linked flag IDs), and missing-code suggestions.

4. **Step 9 (Terminal line)** — extend the `CDI_OK:` line when codes were validated:
   - Without codes (no `code_validation` in JSON): `CDI_OK: <path> · <N> flags · quality <X>/100`
   - With codes (`code_validation` populated): `CDI_OK: <path> · <N> flags · quality <X>/100 · ICD validated`

   main.js can grep for `· ICD validated` to know the CDI included a code-validation pass. The LLM decides which terminal-line variant to emit based on whether it populated `code_validation`.

**Behavior summary:**
- Test cases without codes (the older Mahendra/Kiran cases we already tested) → CDI works exactly as it does today. No `code_validation` field. No terminal-line suffix.
- Production cases with codes (after icd10-coding ships) → CDI sees the codes naturally during its analysis, validates them, adds the `code_validation` block, and emits the `· ICD validated` suffix.
- Doctor-template variants (the future enhancement where codes live inline rather than appended) → also handled automatically since detection is prompt-driven, not format-driven.

One skill, one invocation contract, no bash-side detection step, behavior driven by what the LLM sees in the note.

---

### B. `spawnCdiReview` in main.js

Mirror `spawnIcdCoding`'s shape (which Phase 1 will have just written). Lives in main.js, accepts `caseDir + doctorRecord + cdiMode`, returns a promise that resolves when the skill exits.

**v1 terminal-line contract.** Even though the unification plan established a JSON-manifest pattern for `generate-note` and `parseSkillManifest.js` is already available at repo root, **CDI in v1 keeps its existing terminal-line contract** (`CDI_OK:` / `CDI_FAIL:` / `CDI_SKIPPED:` per the skill's Step 9). Upgrading CDI to emit the full JSON manifest format is a v1.1 follow-up — call it out in the DECISIONS entry but do not implement here. Reasoning: the skill works as-is, the terminal-line grep is simple, and changing the contract while wiring it into the pipeline adds risk for no v1 benefit.

```js
async function spawnCdiReview({ caseDir, doctor, mode = 'balanced' }) {
  // 1. Resolve standards dir (synced into <NOTES_DIR>/.claude/standards)
  // 2. Build the structured prompt per the skill's contract
  // 3. spawn claude -p with --model <soapModel from settings>, CLAUDE_CODE_EFFORT_LEVEL=high
  // 4. Capture stdout, parse the final CDI_OK: / CDI_FAIL: / CDI_SKIPPED: line
  // 5. Record processing_events row (token usage from the spawnClaude wrapper)
  // 6. On CDI_OK: write to cdi_flags table, mark case in DB
  // 7. On failure: log, surface service-warning IPC, do NOT block the pipeline
}
```

Key properties:
- **Non-blocking.** Wraps in try/catch; failure logs + emits `service-warning` IPC but does not throw.
- **Uses `spawnClaude` wrapper.** Same wrapper as soap/docx/etc., so the token-usage parsing + stream-json handling come for free.
- **Cwd = `<NOTES_DIR>`.** Same as other skills; the CLI auto-discovers `.claude/skills/cdi-review/`.
- **Reads doctor settings.** `doctor.specialty`, `doctor.enable_cdi`, `doctor.cdi_mode` from the DB. If `enable_cdi = false` or `specialty IS NULL`, skip entirely (don't even spawn — `CDI_SKIPPED` would happen anyway but skipping the spawn saves tokens).

**Skill prompt assembly:**
```js
const settings = readSettings();
if (!settings.enableCdi) return;  // global toggle is off — skip the spawn entirely

const mode = settings.cdiMode || 'balanced';  // global default; per-doctor / per-encounter override is v1.1
const prompt = [
  'review cdi.',
  `Case: ${caseDir}.`,
  `Specialty: ${(doctor.specialty || '').toLowerCase()}.`,  // may be empty — skill's Step 0b handles
  `Mode: ${mode}.`,
  `Doctor: ${doctor.name}.`,
  `Standards: ${path.join(NOTES_DIR, '.claude', 'standards')}`
].join(' ');
```

Note: the global `enableCdi` gates spawning entirely (no CLI invocation if off — saves the latency + tokens). Per-doctor specialty is *not* a gate at this level — if specialty is NULL, the skill is still spawned and emits `CDI_SKIPPED` cleanly. That distinction matters: we want one place to enforce the global off-switch (here in main.js) and one place to enforce the specialty rule (the skill itself).

---

### C. Pipeline integration

**Pipeline after Phase 1 + Phase 2 land:**

```
audio.mp3
  ↓
transcript.md (+ transcript.docx in parallel)
  ↓
SOAP skill — emits JSON manifest declaring N cases
  ↓
parseSkillManifest → branch on multi_patient
  ↓
┌─ single-patient ────────────────────┐  ┌─ multi-patient ──────────────────────┐
│ for the one case:                    │  │ for each ok/partial child in cases[]:│
│   ICD on case folder's soap_note.md  │  │   (after copying soap.md into child) │
│   CDI on case folder's soap_note.md  │  │   ICD on child folder's soap_note.md │
│   docx on case folder's soap_note.md │  │   CDI on child folder's soap_note.md │
│   docx on case folder's cdi.md       │  │   docx on child folder's soap_note.md│
│   update parent cases row            │  │   docx on child folder's cdi.md      │
│                                      │  │   insert child cases row             │
│                                      │  │ then: update parent (audit) row      │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
```

The audit (parent) folder in multi-patient runs retains the originals the skill wrote — no ICD, no CDI, no docx for those originals. Everything ICD-coded, CDI-reviewed, and docx-converted lives in the child folders.

**Per-case sequence (single-patient OR per child in multi-patient):**

1. SOAP `.md` is in its final location (single-patient: the case folder; multi-patient: the child folder, copied from the audit folder per the unification plan)
2. `spawnIcdCoding` → appends codes to the soap_note.md (non-blocking on failure)
3. `spawnCdiReview` → produces `<case>_cdi.json` + `<case>_cdi.md` in the same folder (non-blocking on failure)
4. `spawnDocxConversion` × 2 — once on soap_note.md (now with codes appended), once on cdi.md
5. DB writes: update the relevant cases row's `cdi_*` columns; insert per-flag rows into `cdi_flags`

**Three design points:**

1. **CDI runs sequentially after ICD, not in parallel.** Reason: the ICD-aware behavior (§A) requires the codes to already be in the soap_note.md file. Running in parallel would mean CDI sometimes sees codes and sometimes doesn't. Sequential is correct.

2. **CDI failure does NOT block docx generation.** If `spawnCdiReview` fails or is skipped, `spawnDocxConversion` still runs on the soap_note.md. Per the existing best-effort ICD pattern — "if it fails, the pipeline falls through to docx anyway — a note without codes/CDI is still useful." CDI inherits this property.

3. **CDI runs per case folder, mirroring docx.** In single-patient runs that's once on the parent case folder. In multi-patient runs that's once per child case folder. **The parent (audit) folder in multi-patient runs never gets a CDI review** — its `.md` SOAP files are reference copies of what the skill wrote, untouched. This mirrors how docx is also never generated in the audit folder.

**Status states for the floating status popup** (mirroring the soap → icd → cdi → docx state machine):

```
recording → transcribing → soap → (per case: icd → cdi → docx) → done
```

In multi-patient runs the popup shows one block per child case, each with its own icd / cdi / docx indicators. The implementation may collapse this into one combined "post-processing" stage if per-child granularity is too noisy in the UI — see §F for the actual decision.

The CDI step's status indicator shows: `queued`, `running`, `completed`, `failed`, `skipped` (the last one when CDI is globally disabled or the doctor has no specialty set).

**Two open buttons in the status popup** (per case):
- "Open Note" — appears when SOAP docx is ready (existing behavior; do NOT delay this until CDI completes)
- "Open CDI Review" — appears when CDI docx is ready

SOAP completion → open button immediately. CDI is a separate indicator that updates as it progresses.

---

### D. DB integration

**New table: `cdi_flags`** (already noted as future-table in the SQLite plan; now we add it).

```sql
CREATE TABLE cdi_flags (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id             TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  cdi_run_id          INTEGER REFERENCES processing_events(id) ON DELETE SET NULL,
  flag_index          INTEGER NOT NULL,        -- order within the run (1, 2, 3, ...)
  type                TEXT NOT NULL,           -- 'critical' | 'warning' | 'suggestion' | 'opportunity'
  category            TEXT NOT NULL,           -- 'Specificity' | 'Linkage' | 'HCC' | 'Completeness' | 'Audit-defense'
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  guideline_reference TEXT,
  current_code        TEXT,
  suggested_codes     TEXT,                    -- JSON array
  confidence          INTEGER NOT NULL,        -- 0-100
  evidence_found      TEXT,                    -- JSON array
  evidence_missing    TEXT,                    -- JSON array
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_cdi_flags_case ON cdi_flags (case_id, created_at);
CREATE INDEX idx_cdi_flags_run  ON cdi_flags (cdi_run_id);
CREATE INDEX idx_cdi_flags_type ON cdi_flags (type);
```

**New columns on `cases` table** (extending the existing schema):

```sql
ALTER TABLE cases ADD COLUMN cdi_json_path TEXT;
ALTER TABLE cases ADD COLUMN cdi_md_path TEXT;
ALTER TABLE cases ADD COLUMN cdi_docx_path TEXT;
ALTER TABLE cases ADD COLUMN cdi_quality_score INTEGER;          -- 0-100 from the run; null if never ran
ALTER TABLE cases ADD COLUMN cdi_medical_necessity TEXT;         -- 'supported' | 'weak' | 'missing'
ALTER TABLE cases ADD COLUMN cdi_claim_defense_readiness TEXT;   -- 'ready' | 'needs_edits' | 'hold_for_review'
ALTER TABLE cases ADD COLUMN cdi_clinician_approval_required INTEGER DEFAULT 0;  -- 0/1
ALTER TABLE cases ADD COLUMN cdi_mode TEXT;                      -- 'balanced' | 'compliance' | 'aggressive'
ALTER TABLE cases ADD COLUMN cdi_status TEXT;                    -- 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
```

The `cdi_*` columns on `cases` give the floating status window everything it needs without a JOIN to `cdi_flags` for the at-a-glance view.

**Per-row behavior in multi-patient runs:** the `cdi_*` columns are populated **per case row**, mirroring how `soap_note_path` / `soap_docx_path` are populated. That means:

- Single-patient runs: the one `cases` row gets all `cdi_*` columns populated.
- Multi-patient parent (recording-folder, audit) rows: `cdi_*` columns stay **NULL**. Just like `soap_note_path` stays NULL on the parent. The parent row is an audit anchor; it doesn't own real chart data.
- Multi-patient child rows: each child row gets its own `cdi_*` columns populated independently — one child can be `cdi_status='completed'`, the next can be `cdi_status='failed'`, the next `cdi_status='skipped'`.

`cdi_flags` rows likewise attach to the case row that owns the SOAP they're flagging — parent (audit) rows never get `cdi_flags` rows.

**`doctors` table additions:**

No new columns. `doctors.specialty` is already in the schema (from the SQLite plan) — confirm by reading `db/migrations/`. CDI on/off and mode are **global app settings**, not per-doctor (revised 2026-05-22 — see §E).

The only doctor-level data that matters for CDI is `doctors.specialty`. If it's NULL, CDI is silently skipped for that doctor's cases regardless of the global on/off setting.

**Migration file:** `db/migrations/00X_add_cdi_tables.sql` (the X is whatever number is next on `icd10-coding` after the merge from develop). Single file containing the CREATE TABLE for `cdi_flags`, the 8 ALTER TABLE statements for `cases`, and the 2 ALTER TABLEs for `doctors`. Bumps `user_version` by 1.

**Token usage logging:**

`processing_events` already exists and `spawnClaude` already parses token usage from the stream-json output. Adding `spawnCdiReview` to the spawn-points list means CDI gets the same token/duration/cost tracking as soap, transcribe, docx, etc. The plan in `2026-05-18-rs-sqlite-state-store.md` already enumerates this — just add `'cdi'` to the `job_kind` enum's documented values (the column is TEXT so no migration needed).

Per-engine analytics ("how much does CDI cost per case on average?") falls out for free from `SELECT AVG(cost_usd) FROM processing_events WHERE job_kind = 'cdi'`.

---

### E. Settings UI — split between global Settings page and per-doctor Templates tab

The CDI configuration has two scopes, and the UI reflects them:

**Global (Settings page):** CDI on/off + default mode. These apply to the whole app — when off, CDI never runs regardless of which doctor or what case. When on, CDI runs for any case whose doctor has a specialty set.

**Per-doctor (Templates tab):** specialty. Drives which CDI ruleset (`standards/specialties/<specialty>.md`) the skill loads.

#### Settings page additions (global)

| Field | Type | Default | Notes |
|---|---|---|---|
| Enable CDI review | Checkbox | unchecked | Master switch. When off, the CDI pipeline step is skipped entirely for every case — no skill spawn, no DB writes for CDI, no UI elements for CDI in the status popup. |
| CDI mode | Dropdown — balanced / compliance / aggressive | balanced | Applies globally to all cases when CDI is enabled. Only shown when "Enable CDI review" is checked. |

Storage: both fields live in `<NOTES_DIR>/settings.json` alongside the existing keys (`autoRecord`, `manualDeviceSelection`, `soapModel`, `templateModel`, `templateEffort`). New keys:

```json
{
  "enableCdi": false,
  "cdiMode": "balanced"
}
```

Add to `DEFAULT_SETTINGS` in main.js so existing installs default to disabled on first launch of the new version.

IPC: extend `saveSettings(s)` and `getSettings()` — both already exist and take the full settings object; no new IPC methods needed.

#### Templates tab additions (per-doctor)

The Templates tab already has an "edit doctor" view (specialty isn't there yet — needs to be added). Specifically:

| Field | Type | Default | Notes |
|---|---|---|---|
| Specialty | Dropdown — closed enum | (unset) | Per Round 2 answers: Hospitalist / Orthopedics / Cardiology / ENT / OB-GYN / Oncology / Pulmonology / Emergency Medicine / Pain Management or Spine. UI lists these alphabetically. Shows a small inline note: "Required if CDI is enabled — drives which CDI ruleset applies for this doctor." |

Storage: `doctors.specialty` column in `app.db` (already in the SQLite schema from the develop branch). The Templates tab UI just needs the dropdown wired to `addDoctor` / `updateDoctor` IPC calls — both already exist and already accept the full doctor record.

The specialty selector appears in the existing flow when:
- Adding a new doctor (new "Add doctor" dialog)
- Editing an existing doctor (right-click → Edit, or pencil icon — whatever the existing UI affordance is)

If the user enables CDI globally but a doctor has no specialty set, the CDI step for that doctor's cases produces `CDI_SKIPPED: unsupported specialty` (the skill's existing Step 0b behavior). main.js logs a warning but doesn't block the pipeline.

#### Combined behavior matrix

| Global `enableCdi` | Doctor `specialty` | What happens for a case |
|---|---|---|
| false | (any) | No CDI step. No spawn. No DB rows. Status popup doesn't show a CDI stage. |
| true | NULL | CDI step is spawned, hits Step 0b, exits with `CDI_SKIPPED`. Status popup shows the CDI stage as "skipped — no specialty set." App.log carries a warning. |
| true | supported (e.g. `orthopedics`) | CDI runs end-to-end. |
| true | unsupported (e.g. `cardiology`) | CDI step is spawned, hits Step 0b, exits with `CDI_SKIPPED: unsupported specialty 'cardiology'`. Status popup shows skipped + reason. |

**No validation rule blocking the user from enabling CDI without setting specialties first** — the skill's Step 0b handles the missing-specialty case cleanly. We don't need UI-level enforcement; we'd just be enforcing what the skill already enforces.

**Backward-compat for existing doctors:** after the migration runs on first launch of the new version, all existing doctors will have `specialty = NULL`. Global `enableCdi` defaults to false. No CDI runs happen until the user explicitly enables CDI globally AND sets per-doctor specialties. This is correct — don't auto-enable anything.

---

### F. Floating status popup additions

The status popup (`renderer/status.js`) shows per-case progress. In single-patient runs there's one case row; in multi-patient runs there's a parent (audit) row + N children. CDI is a new stage between ICD and docx, **per case row that owns a SOAP note**.

**Single-patient layout (per case):**
```
Recording  ✓ done
Transcribing  ✓ done
SOAP note generation  ✓ done · Open Note
ICD coding  ✓ done                                     (Phase 1)
CDI review  🔄 running ... 12s                         (Phase 2)
DOCX export  ⏳ queued
```

When CDI completes:
```
CDI review  ✓ done · 6 flags · 78/100 · Open CDI Review
```

The CDI line shows the per-case `cdi_clinician_approval_required` flag visibly (small badge: "⚠ Review required" when true).

**Multi-patient layout:** the existing per-child row pattern (one collapsed row per child, expandable) carries the same per-stage indicators. Each child row gets its own icd / cdi / docx indicators. The parent (audit) row does NOT show icd / cdi / docx — those stages are conceptually "this row doesn't run them" since the parent retains audit copies only.

**Decision: keep per-child granularity, do not collapse.** Phase 2 surfaces each child's CDI status. The UI can expand/collapse children but each child is its own state machine.

**IPC channel changes:**

The existing `recording-status-update` channel carries the per-case status updates. Extend its payload schema:

```js
{
  caseId: '<uuid>',          // the case row this update is for — in multi-patient,
                              // this is the CHILD case id, not the parent
  stage: 'cdi',               // 'transcribe' | 'soap' | 'icd' | 'cdi' | 'docx'
  status: 'completed',        // 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  cdiFlagCount: 6,            // optional, only on cdi stage
  cdiQualityScore: 78,        // optional, only on cdi stage
  cdiClinicianApprovalRequired: false,
  cdiOpenPath: '/abs/path/to/cdi.docx',
}
```

`preload.js` and `status.js` updates follow. The status renderer must look up which case row each `caseId` belongs to (parent vs child) so it knows where to render the update — this is the existing pattern from the unification plan; no new lookup logic needed.

---

### G. Windows file hiding

The existing `hideExistingCaseMdFiles()` and `hideNotesDirInternals()` helpers walk case folders and hide `.md` files. After the unification work, these helpers run on **both** the audit (recording) folder and every child case folder.

- `*_cdi.md` — automatic, because the existing helper hides all `.md` files.
- `*_cdi.json` — verify whether the helper also hides `.json` files inside case folders. If not, extend the helper to hide `.json` files that sit directly inside a case folder (don't extend it to arbitrary `.json` files elsewhere in `<NOTES_DIR>` — the broader notes-dir hiding handles those).

`.docx` files stay visible to the user — they see only `mp3 + soap_note.docx + cdi.docx + transcript.docx` in each case folder. In multi-patient audit folders, the user sees only the `mp3` + `transcript.docx` (all the audit `.md` files are hidden; there are no audit `.docx` files for SOAPs or CDI).

---

### H. CLAUDE.md updates

Update in the same PR. The pipeline section was rewritten by the unification plan to describe the manifest-driven multi-patient flow — Phase 2's updates slot CDI into that current narrative (do not revert to the old single-case sequence).

- **Code map** — confirm `notes-claude/skills/cdi-review/` is listed (already added when Plan 1 landed). Confirm `notes-claude/skills/add-icd-codes/` is listed (added in Phase 1).
- **Recording pipeline section** — extend step 7's "per case" sub-flow to include ICD then CDI between the SOAP-close handler and the docx call. Phase 1 will have added the ICD step; Phase 2 inserts CDI after it.
- **Don't touch §4** — the CDI prompt signature is already documented in develop's CLAUDE.md. Verify it's still correct after the §A changes (terminal-line contract gains the `· ICD validated` suffix). Phase 1 also adds the `add-icd-codes` skill signature here.
- **Settings & config files table** — add `enableCdi` and `cdiMode` to the `<NOTES_DIR>/settings.json` row's listed keys. No new files at the filesystem level.
- **Quick references** — add a one-liner about the CDI feature (e.g. "CDI co-pilot review runs after ICD coding; toggled in Settings; specialty per doctor in Templates tab").

---

### I. ARCHITECTURE.md updates

- **Recording pipeline sequence diagram** — add the CDI step. Show that CDI runs *sequentially* after ICD, not in parallel.
- **IPC and event channels** — document the extended `recording-status-update` schema (the `cdi*` fields).
- **State machine details** — no changes needed; CDI is a pipeline stage, not a state-machine state.
- **File system layout (runtime)** — add `<case>_cdi.json`, `<case>_cdi.md`, `<case>_cdi.docx` to the case folder structure block.
- **Cross-cutting: error surfacing** — add CDI failure modes to the table (CDI skill non-zero exit, specialty mismatch, standards file missing, etc.). Most route to `service-warning` IPC.

---

### J. DECISIONS.md updates

Append two new entries, dated the day of PR merge — one for Phase 1, one for Phase 2.

**Phase 1 entry** (added when Phase 1 commits land on `cdi-v1`):

```markdown
## YYYY-MM-DD (rs) — ICD-10 coding step re-implemented natively on develop's architecture

**Context:** The original ICD-10 coding step (claude.ai ICD-10 MCP connector + `spawnIcdCoding` + the `add-icd-codes` skill) was implemented on the `icd10-coding` branch before `develop` landed the SQLite metadata store, the staging branch infrastructure, the token logging via `spawnClaude`, and the docx-unification rewrite (which introduced JSON manifests for `generate-note` and per-child execution for multi-patient runs).

**Decision:** Rather than merge `icd10-coding` into `develop` (which would have produced large conflicts in `main.js` and left the ICD step wired for the old single-case pipeline), the ICD step is re-implemented from scratch on a new `cdi-v1` branch off `develop`. `icd10-coding` is kept as a read-only reference branch; its `add-icd-codes/SKILL.md` and `.mcp.json` are transferred as-is, but the `spawnIcdCoding` function and its call sites are re-written natively to fit the manifest-driven, per-child execution model.

**Rejected:**
- Merging `icd10-coding` into the post-unification branch: produces large conflicts in `main.js` (1138-line rewrite collides with the ICD step's 112-line additions); even if resolved, the ICD step would still need rewriting for per-child execution. Less work to start fresh.
- Deleting `icd10-coding` entirely: kept as read-only reference until `cdi-v1` ships, then optionally archived.

**Implications:**
- ICD runs per case folder, not per recording. In single-patient runs that's once on the parent case folder; in multi-patient runs that's once per child case folder. The parent (audit) folder in multi-patient runs retains the originals the skill wrote — no ICD codes appended.
- ICD failure is non-blocking — the pipeline falls through to CDI and docx. A note without codes is still useful.
- After `cdi-v1` merges to develop and is verified stable, `icd10-coding` is archived (locally deleted; remote tip optionally tagged).
```

**Phase 2 entry** (added when Phase 2 commits land on `cdi-v1`):

```markdown
## YYYY-MM-DD (rs) — CDI v1 wired into the recording-app pipeline

**Context:** Plan 1 produced the cdi-review skill in isolation. Phase 2 of this plan ships it as a real product feature with UI, DB persistence, status reporting, and ICD-aware behavior. Builds on Phase 1's ICD step re-implementation.

**Decision:** CDI runs sequentially after the ICD coding step and before docx export, per case folder (parent in single-patient runs; each child in multi-patient runs). CDI's failure is non-blocking — docx still ships. New `cdi_flags` table plus 8 `cdi_*` cache columns on `cases` populated per row. **CDI on/off and mode are global app settings** (live in `<NOTES_DIR>/settings.json`), not per-doctor — the Settings page exposes both. **Specialty is per-doctor** (lives in `doctors.specialty` in `app.db`) and is set via the Templates tab. The skill itself emits `CDI_SKIPPED` when a per-doctor specialty isn't set; the global on/off gates spawning entirely. Status popup shows CDI as a separate stage per case with its own open button.

**Skill update:** the cdi-review skill becomes ICD-aware — when the SOAP note already contains appended ICD codes (the production case after Phase 1 ships), the skill validates them against the documentation and adds a `code_validation` block to the output JSON + a "Code validation summary" section in the markdown rendering. The skill keeps its existing `CDI_OK: / CDI_FAIL: / CDI_SKIPPED:` terminal-line contract in v1; upgrading to the JSON manifest format established for `generate-note` is a v1.1 follow-up.

**Rejected:**
- Running CDI in parallel with ICD coding: would make ICD-aware behavior non-deterministic. Sequential is correct.
- Upgrading the CDI skill to the JSON manifest format in v1: the terminal-line contract works, the change would add risk for no v1 benefit. Tracked as a v1.1 follow-up.
- Per-doctor CDI on/off and mode: the practice toggles the feature; specialty per-doctor drives which ruleset applies. Cleaner split.

**Implications:**
- All ICD-aware behavior assumes the appended-codes format Phase 1 produces (markdown table: Diagnosis | Code | Description). Future doctor-template-driven inline placement is automatically handled since detection is prompt-driven.
- The 8 `cdi_*` cache columns on `cases` denormalize what's in `cdi_flags` so the floating status window renders at-a-glance without a JOIN. Keep them honest on every CDI completion. In multi-patient runs the parent (audit) row's `cdi_*` columns stay NULL — the parent row is an audit anchor.
- The CDI configuration split (global on/off + mode in Settings; per-doctor specialty in Templates) is intentional. Future per-encounter or per-doctor mode overrides can be added in v1.1 without changing the v1 schema.
- The existing `python/md_to_docx.py` handles all docx generation including CDI. Extend it in-place if styling improvements are needed; do not create a parallel CDI-specific converter.
```

---

## Implementation order

Phase 1 fully complete (and Phase 1 dev verification signed off by rish) before Phase 2 starts.

**Phase 1 order:**
1. Create the `cdi-v1` branch off the latest `develop` per the branching strategy above.
2. Copy `add-icd-codes/SKILL.md` and `.mcp.json` from `icd10-coding` (§1.1, §1.2).
3. Write `spawnIcdCoding` in `main.js` against the current architecture (§1.3).
4. Wire ICD calls into the SOAP close handler (single-patient + per-child in multi-patient) (§1.3 call sites).
5. Update CLAUDE.md / ARCHITECTURE.md / DECISIONS.md for Phase 1 (§1.5).
6. Archive `docs/plans/2026-05-13-rs-icd-coding.md` to `docs/archive/plans/` and remove its row from `docs/plans/README.md` (§1.5).
7. Commit Phase 1 work with clear messages (suggest 2 commits: skill + MCP config in one; spawn + pipeline wiring + docs in another).
8. Stop. Wait for rish to run the Phase 1 dev verification checklist (§1.6).

**Phase 2 order (only after Phase 1 verified):**

1. DB migration (creates `cdi_flags`, adds `cdi_*` columns to `cases`). No new columns on `doctors` — confirmed in §D.
2. Settings page UI (global `enableCdi` checkbox + `cdiMode` dropdown). Testable in isolation by toggling and inspecting `settings.json`.
3. Templates tab UI (per-doctor Specialty dropdown). Testable in isolation by editing a doctor and inspecting `app.db`.
4. `spawnCdiReview` in main.js with the skill prompt assembly + token logging (§B). Mirror the Phase 1 `spawnIcdCoding` shape.
5. Pipeline integration (CDI between ICD and docx; per-case execution) (§C). Status popup updates.
6. ICD-aware behavior in the cdi-review skill (§A changes). The skill is already on develop; this just edits it.
7. Windows file hiding verification (§G).
8. CLAUDE.md / ARCHITECTURE.md / DECISIONS.md updates for Phase 2.
9. Stop. Wait for rish to run the Phase 2 dev verification checklist (below).
10. After Phase 2 verified: open PR back to develop with both phases.

---

## Phase 2 dev verification checklist (rish runs this)

**The implementation session does NOT run these tests.** This app is Electron with audio recording, Claude Code subprocess invocation, and a system tray — it cannot be tested in a headless agent environment. The implementer writes the code + docs and pastes this checklist into the PR description so rish can work through it on a real desktop session.

The implementer can statically verify things like: the migration file syntax, the SQL DDL applies cleanly to a fresh DB, the JS doesn't throw at parse time, the IPC channel changes compile. Anything that requires a real recording or a running Electron app is rish's job.

**Settings + Templates UI:**

- [ ] **Settings page UI** — open Settings, verify "Enable CDI review" checkbox + "CDI mode" dropdown exist. Toggle on, pick `balanced`, save. Inspect `<NOTES_DIR>/settings.json` — should contain `"enableCdi": true, "cdiMode": "balanced"`.
- [ ] **Templates tab UI** — open Templates tab, edit an existing doctor. Verify the Specialty dropdown exists with the closed enum of 9 specialties. Set it to "Orthopedics" and save. Inspect `app.db` — `doctors.specialty = 'Orthopedics'` for that record.

**Gating behavior (single-patient runs):**

- [ ] **CDI skipped — global off** — set `enableCdi = false` in settings. Record a test case. Verify: SOAP, ICD, docx generate normally; no CDI step spawn (no `processing_events` row for CDI); no `*_cdi.*` files appear; case row's `cdi_status` is NULL (not even `skipped` — the spawn was never attempted).
- [ ] **CDI skipped — no specialty (with global ON)** — set `enableCdi = true` globally, but set a doctor's `specialty` to NULL via `sqlite3 app.db`. Record a case with that doctor. Verify: CDI spawn DOES happen (so `processing_events` has a row), the skill emits `CDI_SKIPPED`, `cdi_status = 'skipped'`, status popup shows "skipped — no specialty set." Stub `_cdi.json` is written.
- [ ] **CDI skipped — unsupported specialty (with global ON)** — set a doctor's `specialty` to `cardiology` (no specialty file exists). Record a case. Verify: similar to above but with reason "unsupported specialty 'cardiology'."

**Happy paths:**

- [ ] **Single-patient happy path with ICD codes** — process a case end-to-end. Doctor is ortho, specialty set, CDI enabled. ICD step appends codes to soap_note.md. CDI then runs and sees the codes. Verify output JSON has `code_validation` field with `codes_in_note`, `supported`, `flagged`, `missing_codes` populated. Markdown has the "Code validation summary" section. Terminal line ends with `· ICD validated`. The case's `cdi_*` columns are populated. `cdi_flags` rows are written.
- [ ] **Single-patient happy path — ICD failed but CDI runs** — temporarily break ICD (rename the MCP connector). Record a case. SOAP `.md` is written, ICD logs failure, CDI still runs (it sees a note without codes). CDI output has NO `code_validation` field. Terminal line has no `· ICD validated` suffix. The case still gets a CDI `.docx`.
- [ ] **Multi-patient happy path** — use a known multi-patient transcript (Spencer 5-patient fixture). Verify:
  - Audit folder retains all SOAP `.md` files the skill wrote — none with ICD codes appended, no CDI files.
  - Each child folder has: ICD-coded `.md`, `_cdi.json`, `_cdi.md`, `soap.docx`, `cdi.docx`.
  - DB: parent row has `cdi_*` columns NULL. Each child row has its own `cdi_*` populated independently.
  - `cdi_flags` rows attached to child case ids only, never to the parent.

**Failure modes:**

- [ ] **CDI failure is non-blocking** — kill the claude CLI mid-CDI (via a debug hook or by temporarily breaking the skill). Verify the case still gets a docx; `cdi_status = 'failed'`; a `service-warning` IPC fires; the floating status window shows the CDI step as failed but doesn't block the Open Note button.
- [ ] **Multi-patient with one CDI failure** — force CDI to fail on the 2nd child only. Verify: child 2's `cdi_status='failed'`, child 2 still gets a SOAP docx, children 1/3/4/5 finish normally with CDI populated.

**Modes:**

- [ ] **All 3 modes work** — manually change the global `cdiMode` setting in `<NOTES_DIR>/settings.json` between balanced / compliance / aggressive. Record cases under each. Verify the mode argument is passed to the skill correctly and the output reflects the mode (different severity-tier flags surfaced; soft-target counts roughly hit).

**Live updates + UI:**

- [ ] **Status popup live updates (single-patient)** — open the floating status window while a case is processing. Watch the CDI stage transition through queued → running → completed (or failed). Verify the Open CDI Review button appears at the right moment.
- [ ] **Status popup live updates (multi-patient)** — open the status window during a multi-patient run. Verify each child case has its own progressing CDI indicator that runs independently.

**Data integrity:**

- [ ] **DB integrity** — after several test cases (mix of single + multi), verify: every CDI-eligible case has a row in `processing_events` with `job_kind = 'cdi'`; every successful CDI run has its flags as rows in `cdi_flags` attached to the right case row; the `cdi_*` columns on `cases` match the JSON output for each case; parent (audit) rows in multi-patient runs have NULL `cdi_*` columns and zero `cdi_flags` rows.
- [ ] **Token logging** — query `SELECT SUM(cost_usd) FROM processing_events WHERE job_kind = 'cdi'`. Verify it's non-zero and roughly matches the per-case token usage stream-json logged in `app.log`.

**Platform:**

- [ ] **Windows file hiding** — on a Windows install, verify `<case>_cdi.md` and `<case>_cdi.json` are hidden in both single-patient case folders and multi-patient child folders. `<case>_cdi.docx` is visible.

**No regressions:**

- [ ] **Existing pipeline still works when CDI globally disabled** — record a case with `enableCdi = false`. Verify SOAP / ICD / docx flow is identical to Phase 1's verified state — no changes.
- [ ] **Pre-chart on a CDI-enabled case** — pick a case that has a CDI review, run pre-chart, verify the SOAP is regenerated as normal. CDI is NOT re-run automatically (that's a v1.1 feature). The old `_cdi.json` / `.md` / `.docx` remain in place as stale artifacts; the user can manually delete or ignore.

---

## Risks + open items

1. **Migration ordering.** The CDI migration is added to a branch that's already at `develop`'s latest migration number. Read `db/migrations/` after creating `cdi-v1` and pick the next-available number for the CDI migration. If `develop` ships another migration while `cdi-v1` is in-flight, the back-merge to develop may need a renumber — handle at PR time.

2. **`code_validation` flag-linking.** The new field references `linked_flag_id` for each flagged/missing code. The linkage is fragile — flag IDs are assigned by the LLM at generation time and aren't stable across re-runs. **Mitigation:** keep the linkage as an LLM-generated soft reference; downstream code (UI) should tolerate the linked flag not existing (e.g., show the code_validation entry standalone if no linked flag is found).

3. **Per-child execution of ICD + CDI in multi-patient runs.** Both ICD and CDI run once per case folder. The unification plan established the per-child child-folder structure. Phase 1 re-implements ICD against that structure from day one. Phase 2's CDI integration follows the same pattern. **Risk if forgotten:** wiring ICD or CDI to run "once per recording" (the old single-case mental model) instead of "once per case folder" would mean parent (audit) folders get ICD-coded and CDI-reviewed, and children get nothing. This would break multi-patient cases silently. **Mitigation:** the implementer reads the unification plan's per-child loop in main.js end-to-end before writing the spawn-and-call code. The plan's §C diagram shows the correct shape.

4. **ICD step adapted to per-child execution.** The original `spawnIcdCoding` on `icd10-coding` was written for the old single-case pipeline. Phase 1 re-implements it natively. **Risk:** the implementation session may be tempted to copy the original verbatim. Explicitly forbidden — re-write the spawn function and rewire the call sites. The `add-icd-codes/SKILL.md` skill content itself can transfer as-is.

5. **Aggressive-mode HCC opportunities.** Aggressive mode is supposed to surface HCC capture hints (Engine 1 sub-feature 1.31), but full HCC scoring is deferred to v1.1. The skill currently surfaces these as `opportunity`-tier flags without actually computing HCC weights. That's fine for v1; just ensure the UI doesn't promise more than is delivered. **No change needed in Phase 2** — flagging for awareness only.

6. **DB schema changes on a feature branch.** The CDI migration on `cdi-v1` diverges the schema from `develop` until merge. The migration runner handles this on each user's app on auto-update — standard practice. Worth noting that anyone running `cdi-v1` locally during development needs to delete + rebuild `app.db` if they switch back to `develop` (the migration is forward-only).

7. **Single PR with two phases.** Phase 1 + Phase 2 ship together in one PR back to develop. **Risk:** if Phase 1 reveals an architectural issue that requires changes to develop's existing code (e.g., the SOAP close handler signature), Phase 2 may need replanning. **Mitigation:** Phase 1's verification step exists exactly to catch this before Phase 2 starts. If Phase 1 reveals deep issues, the implementation session pauses and reports to rish for a re-plan rather than barreling into Phase 2 with assumptions that may be wrong.

---

## Deliverables checklist

### Phase 1 deliverables

- [ ] Branch `cdi-v1` created off latest `develop`. `icd10-coding` is NOT merged in (it stays as a read-only reference branch).
- [ ] `notes-claude/skills/add-icd-codes/SKILL.md` copied from `icd10-coding` (transferred via `git show`, not by checking out the branch).
- [ ] `notes-claude/.mcp.json` copied from `icd10-coding`.
- [ ] `spawnIcdCoding` function in `main.js` re-written natively against `develop`'s current architecture (manifest-driven, per-child execution). Uses the `spawnClaude` wrapper for token logging.
- [ ] Pipeline wiring: ICD called after SOAP `.md` is in its final location, before docx. Single-patient: once on parent case folder's `soap_note.md`. Multi-patient: once per child case folder's `soap_note.md` (parent audit folder never sees ICD codes appended).
- [ ] ICD non-blocking — failure logs + emits `service-warning` IPC + records `processing_events` row with failure detail, but allows docx to run.
- [ ] CLAUDE.md updated: Code map adds `add-icd-codes/`; Don't-touch §4 adds the skill signature; recording pipeline section adds the ICD step in both single-patient and per-child flows.
- [ ] `docs/ARCHITECTURE.md` updated: pipeline sequence diagram and state machine include the ICD step.
- [ ] `docs/DECISIONS.md` appended: dated entry explaining the re-implementation strategy (Option B chosen over merging `icd10-coding`).
- [ ] `docs/plans/2026-05-13-rs-icd-coding.md` moved to `docs/archive/plans/`; its row removed from `docs/plans/README.md`.
- [ ] Phase 1 dev verification checklist (§1.6) included in the PR description for rish to run.

### Phase 2 deliverables

- [ ] Migration `db/migrations/00X_add_cdi_tables.sql` written. Adds `cdi_flags` table and the 8 `cdi_*` columns on `cases`. **No new columns on `doctors`** — `enableCdi` and `cdiMode` are global app settings, not per-doctor.
- [ ] Migration tested by syntax-check + DDL-applies-cleanly check on a fresh `app.db`. (Real-data verification is rish's job during the dev verification pass.)
- [ ] Settings page UI (global): "Enable CDI review" checkbox + "CDI mode" dropdown. Wired through existing `getSettings()` / `saveSettings()` IPC. Defaults to disabled.
- [ ] Templates tab UI (per-doctor): Specialty dropdown in the edit-doctor view. Closed enum of 9 specialties. Wired through existing `addDoctor` / `updateDoctor` IPC.
- [ ] `spawnCdiReview` function in `main.js` mirroring `spawnIcdCoding`'s shape (which Phase 1 just wrote). Uses `spawnClaude` wrapper.
- [ ] Pipeline order per case: SOAP → ICD → CDI → docx. CDI is non-blocking. Per-case (single-patient: once on parent; multi-patient: once per child).
- [ ] Status popup: CDI as a separate stage with its own open button; per-case state machine extended; multi-patient runs show per-child CDI status.
- [ ] IPC: `recording-status-update` payload extended with `cdi*` fields.
- [ ] DB writes: `processing_events` row per CDI run with `job_kind='cdi'`; `cdi_flags` rows per flag attached to the right case row (parent in single-patient; child in multi-patient — never parent in multi-patient); `cases.cdi_*` columns updated per row.
- [ ] CDI skill update (§A) — ICD-aware behavior in `notes-claude/skills/cdi-review/SKILL.md`: prompt directs the model to validate any codes it finds in the note, optional `code_validation` JSON block when codes are present, "Code validation summary" section in markdown, `· ICD validated` suffix on the terminal line when validation happened.
- [ ] Windows file hiding: `*_cdi.md` + `*_cdi.json` hidden in both case folders and child folders; `*_cdi.docx` visible.
- [ ] `CLAUDE.md` updated: pipeline section adds CDI between ICD and docx; Don't-touch §4 confirmed; settings & config files table mentions new keys; quick references add CDI one-liner.
- [ ] `docs/ARCHITECTURE.md` updated: pipeline sequence diagram, IPC channels, file system layout, error surfacing table.
- [ ] `docs/DECISIONS.md` entry appended with the rationale.
- [ ] Phase 2 dev verification checklist (the "Phase 2 dev verification checklist" section above) included in the PR description for rish to run.

### PR + archival (after both phases verified)

- [ ] PR description includes both Phase 1 + Phase 2 dev verification checklists, with empty checkboxes for rish to tick off as he tests.
- [ ] PR description calls out any items the implementation session could not statically verify (most items, given this is an Electron app).
- [ ] PR description lists any assumptions the implementation session had to make that aren't pinned in this plan.
- [ ] Plan 2 entry removed from `docs/plans/README.md` and the plan file moved to `docs/archive/plans/` after PR merge.
- [ ] After PR merges to develop: optionally archive `icd10-coding` (locally `git branch -D icd10-coding`; the remote tip can be tagged for posterity, e.g. `git tag archive/icd10-coding-original origin/icd10-coding`). Decision deferred to rish post-merge.

---

## After this plan ships

Once Phase 1 + Phase 2 are merged to `develop` (via the single PR back from `cdi-v1`):

1. **Branch promotion:** `develop → staging → main` per the standard flow documented in `CLAUDE.md`. Allow at least one auto-update cycle on a staging install before promoting to main.

2. **`icd10-coding` archival:** locally `git branch -D icd10-coding` once Phase 1 + Phase 2 are confirmed working in production-shape (i.e., installed staging build, real recordings). Optionally tag the remote tip first for posterity: `git tag archive/icd10-coding-original origin/icd10-coding && git push origin archive/icd10-coding-original`. The remote branch itself can be deleted once tagged. Decision: deferred to rish post-merge.

3. **Plan archival:**
   - `git mv docs/plans/2026-05-19-rs-cdi-v1-skill.md docs/archive/plans/` (Plan 1, after PR merge).
   - `git mv docs/plans/2026-05-22-rs-cdi-v1-app-integration.md docs/archive/plans/` (this plan, after PR merge).
   - `git mv docs/plans/2026-05-22-rs-unify-docx-generation.md docs/archive/plans/` if not already archived as part of the docx-unification PR.
   - Remove all archived rows from `docs/plans/README.md`.

4. **v1.1 follow-ups** (tracked in DECISIONS.md's "Known v1.1 follow-ups" subsection on the CDI v1 entry):
   - Upgrade `cdi-review` to emit the JSON manifest format established for `generate-note`. Use `parseSkillManifest.js`.
   - Upgrade `add-icd-codes` to emit the JSON manifest format. Same.
   - Move the CDI rendering Python script from SKILL.md into a sibling `python/cdi_render.py`.
   - Add `python/md_to_docx.py` styling extensions for severity-coloured cells.
   - Provider query generation (Engine 1 sub-features 1.43–1.47).
   - HCC capture full scoring (1.33–1.35).
   - Pre-AI rules-engine prefilter (1.48–1.50).
   - Documentation Defense additions (1.54–1.60).
   - Re-run CDI automatically when a SOAP note is edited via pre-chart (today it's left as a stale artifact).

5. **Eval framework** (separate engine, not in the CDI track): start its own planning thread once CDI is shipping reliably. The PDFs Fahd shared (`physician_assist_soap_only_audit_framework.pdf` and the 100-point SOAP rubric inside it) are the source material.

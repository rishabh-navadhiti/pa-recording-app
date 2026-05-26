# Decisions

Append-only log of non-obvious technical choices. Latest at top. Don't edit old entries — supersede them with a new one if your view changes. Format:

```
## YYYY-MM-DD (initials) — <short title>
**Context:** what we were facing.
**Decision:** what we chose.
**Rejected:** what we didn't choose, briefly why.
**Implications:** what future code/docs need to respect.
```

---

## 2026-05-22 (rs) — CDI v1 wired into the recording-app pipeline

**Context:** Plan 1 ([docs/archive/plans/2026-05-19-rs-cdi-v1-skill.md] when archived) shipped the `cdi-review` skill in isolation. Plan 2 ([docs/plans/2026-05-22-rs-cdi-v1-app-integration.md]) Phase 2 ships it as a real product feature with persistence, UI, status reporting, and ICD-aware behavior. Phase 1 of the same plan (ICD step re-implementation) is documented in the entry below; this entry covers Phase 2.

**Decision:** CDI runs sequentially after the ICD coding step and before docx export, per case folder (parent in single-patient runs; each child in multi-patient runs). CDI failure is non-blocking — docx still ships, the case still completes. New `cdi_flags` table plus 8 `cdi_*` cache columns on `cases` (migration 003) are populated per row; multi-patient parent (audit) rows stay NULL on all `cdi_*` and have zero `cdi_flags` entries. **CDI on/off and mode are global app settings** (`enableCdi` + `cdiMode` in `<NOTES_DIR>/settings.json`), not per-doctor — the Settings page exposes both. **Specialty is per-doctor** (`doctors.specialty` in `app.db`) and is set via the Templates tab. The skill emits `CDI_SKIPPED` when a per-doctor specialty isn't set; the global on/off gates spawning entirely (no Claude invocation when disabled).

**Skill update:** the `cdi-review` skill becomes ICD-aware — when the SOAP note already contains appended ICD codes (the production case after Phase 1), the skill validates them against the documentation and adds a `code_validation` block to the output JSON + a "Code validation summary" section in the markdown rendering. The skill keeps its existing `CDI_OK: / CDI_FAIL: / CDI_SKIPPED:` terminal-line contract in v1, with the addition of an optional ` · ICD validated` suffix on the `CDI_OK:` line signaling that `code_validation` was populated. Upgrading the skill to the full JSON manifest format established for `generate-note` is a v1.1 follow-up.

**Rejected:**
- Running CDI in parallel with ICD coding: would make the ICD-aware validation behavior non-deterministic (CDI would sometimes see codes, sometimes not). Sequential is correct.
- Upgrading the CDI skill to the JSON manifest format in v1: the terminal-line contract works, the change would add risk for no v1 benefit. Tracked as a v1.1 follow-up.
- Per-doctor CDI on/off and mode: the practice toggles the feature; per-doctor specialty drives which ruleset applies. Cleaner separation.
- A separate CDI-specific docx converter: we use the existing `python/md_to_docx.py` for all docx generation including CDI. `spawnDocxConversion` classifies the `.md` by looking up the case row's `*_path` columns (`soap_note_path` / `cdi_md_path` / `transcript_path`) and branches the close handler accordingly; falls back to filename heuristic when the DB doesn't disambiguate. Styling extensions (severity-coloured cells, etc.) belong in the existing script in-place if needed; not in this PR.
- Re-running CDI when pre-chart rewrites a SOAP note: the old `_cdi.{json,md,docx}` artifacts remain as stale. Tracked as a v1.1 follow-up. The ICD step DOES re-run in pre-chart (since diagnoses may have changed).
- Adding a CDI-specific IPC channel: extending the existing `recording-status-update` payload with `cdi*` fields on each recording/patient entry is simpler. `broadcastRecordingStatus` and `get-session-recordings` already spread the entry, so the fields flow through automatically.
- **Plan §B's "skill is the only specialty gate" guidance.** The plan suggested only gating `enableCdi` in main.js and letting the skill's Step 0b handle the specialty check end-to-end (single source of truth). In practice, paying ~10–15s of Claude latency + tokens just to learn `CDI_SKIPPED: unsupported specialty` is wasteful when the same check is a one-line file-existence test in main.js. Deviated from the plan: main.js now gates on (a) `enableCdi`, (b) `doctor.specialty` non-empty, and (c) `<standards>/specialties/<value>.md` exists. When any gate fails, main.js writes the same stub `_cdi.{json,md}` the skill would have written and records `cdi_status='skipped'` — the downstream shape is identical. The skill's Step 0b stays as a defensive backstop for direct `claude -p` invocations (testing, debugging).

**Implications:**
- All ICD-aware behavior in the skill assumes the appended-codes format Phase 1 produces (markdown table: *Diagnosis | Code | Description*). Doctor-template-driven inline placement is handled automatically since detection is prompt-driven, not format-driven.
- The 8 `cdi_*` cache columns on `cases` denormalize what's in `cdi_flags` so the floating status window renders at-a-glance without a JOIN. Keep them honest on every CDI completion. In multi-patient runs the parent (audit) row's `cdi_*` columns stay NULL — the parent row is an audit anchor.
- The CDI configuration split (global on/off + mode in Settings; per-doctor specialty in Templates) is intentional. Future per-encounter or per-doctor mode overrides can be added in v1.1 without changing the v1 schema.
- The existing `python/md_to_docx.py` handles all docx generation including CDI. Extend it in-place if styling improvements are needed; do not create a parallel CDI-specific converter.
- Pre-chart on a CDI-enabled case re-runs ICD but not CDI. The stale `_cdi.{json,md,docx}` artifacts can be manually deleted by the user; auto re-run is a v1.1 follow-up.
- `processing_events` gains `job_kind='cdi'` rows. `SELECT SUM(cost_usd) FROM processing_events WHERE job_kind='cdi'` gives per-engine cost for free.
- Windows file hiding extends to `<case>_cdi.json` (hidden inline by `spawnCdiReview` on `CDI_OK`; older cases get hidden on startup by `hideExistingCaseMdFiles` which now filters `.md` OR `*_cdi.json`). `<case>_cdi.md` is hidden by `spawnDocxConversion`'s existing `hideFileFromUser(mdPath)` on its success branch. `<case>_cdi.docx` stays visible.

**Addendum (2026-05-26) — CDI Step 9 replaced with a JSON manifest; filesystem fallback added; full stream-json logging.**

The Stephanie 2026-05-26 verification run revealed the magic-line terminal contract is unreliable for long CDI runs. The skill ran cleanly (5 flags, quality 73/100, $0.90, valid `_cdi.json` + `_cdi.md` on disk) but by turn 18 the model's attention had drifted and its final response was a conversational summary instead of the strict `CDI_OK:` line. main.js's grep-based parser logged `CDI_FAIL: no terminal line` and routed to the failure branch, leaving the DB row as failed despite the on-disk artifacts being perfect.

Three changes addressing the root cause:

- **(a) Step 9 of `cdi-review/SKILL.md` replaced with a single-line JSON manifest** matching `parseSkillManifest`'s expectations (`schema_version:1`, `skill:'cdi-review'`, `status:'ok'|'skipped'|'failed'`, plus `json_path`/`md_path`/`flag_count`/`flag_counts`/`quality_score`/`medical_necessity_status`/`claim_defense_readiness`/`clinician_approval_required`/`icd_validated`/`skipped_reason`/`error`). Same emission discipline as `generate-note` Step 7 (last line of final response, no fences, no prose after). Three worked examples embedded in Step 9. Explicit "do NOT write a closing summary" guidance baked in. The old `CDI_OK:` / `CDI_SKIPPED:` / `CDI_FAIL:` text-line spec is removed entirely.

- **(b) Filesystem fallback in `spawnCdiReview`** is the load-bearing reliability layer. When the manifest line is missing, malformed, or `status:'failed'`, main.js reads the on-disk `<case>_cdi.json` (which the skill writes in Step 8, before Step 9's emission), validates its shape (`summary` + `flags` present), and synthesizes a manifest from its content. The case is recovered to `cdi_status='completed'` as if the manifest had been emitted cleanly. `applyCdiSuccess(manifest)` is shared between the happy path and the fallback path so DB writes, flag inserts, file hiding, and popup updates are identical regardless of which route succeeded. The model can drop the manifest line entirely and we still recover. Only when both the manifest AND the on-disk JSON are unusable does main.js mark `cdi_status='failed'` and surface a `service-warning` IPC.

- **(c) Full stream-json logging** for all three Claude-driven skills. `logSkillStream(tag, kind, resultEvent)` writes one grep-able JSON line per run: `[soap][stream]`, `[icd][stream]`, `[cdi][stream]`. The stream wrapper already contains `result` (the model's final text) plus `usage`, `total_cost_usd`, `duration_api_ms`, `num_turns`, `permission_denials`, etc. — single source of truth. The earlier `[soap][response]` (just the result text, multi-line) is replaced. `[soap][manifest]` and `[cdi][manifest]` remain as the parsed-manifest log lines — semantically distinct from `[stream]` (the stream's `result` field is raw text; the manifest is the parsed structure driving DB + UI writes).

Net effect: the manifest is the fast happy path; the filesystem fallback is the safety net. Long CDI runs that drift on the closing line still complete successfully. The "upgrade CDI to manifest format" item below is **done** as of this addendum — moved into v1 from v1.1.

**Known v1.1 follow-ups (logged 2026-05-22):**

- ~~Upgrade `cdi-review` to emit the JSON manifest format established for `generate-note`. Use `parseSkillManifest.js`.~~ *Done 2026-05-26 — see addendum above.*
- Upgrade `add-icd-codes` to emit the JSON manifest format. Same.
- Move the CDI rendering Python script from SKILL.md into a sibling `python/cdi_render.py`.
- Add `python/md_to_docx.py` styling extensions for severity-coloured cells in the CDI docx.
- Provider query generation (Engine 1 sub-features 1.43–1.47).
- HCC capture full scoring (1.33–1.35).
- Pre-AI rules-engine prefilter (1.48–1.50).
- Documentation Defense additions (1.54–1.60).
- Re-run CDI automatically when a SOAP note is edited via pre-chart (today it's left as a stale artifact; the ICD step DOES re-run on pre-chart, so this asymmetry is a small wart).

---

## 2026-05-22 (rs) — ICD-10 coding step re-implemented natively on develop's architecture

**Context:** The original ICD-10 coding step (claude.ai ICD-10 MCP connector + `spawnIcdCoding` + the `add-icd-codes` skill) was implemented on the `icd10-coding` branch in May 2026, before `develop` landed the SQLite metadata store, the staging-branch infrastructure, the token logging via `spawnClaude`, Plan 1's CDI skill + standards files, and the docx-unification rewrite (which introduced JSON manifests for `generate-note` and per-child execution for multi-patient runs). `icd10-coding` and `develop` had diverged by ~1100 lines in `main.js` and the ICD step was wired for the old single-case pipeline that no longer exists on `develop`.

**Decision:** Rather than merge `icd10-coding` into `develop` (large unresolvable conflicts in `main.js`, plus the ICD step would still need rewriting for per-child execution after the merge), the ICD step is re-implemented from scratch on a new `cdi-v1` branch off `develop`. `icd10-coding` is kept as a read-only reference branch. The skill content (`notes-claude/skills/add-icd-codes/SKILL.md`) and the MCP config (`notes-claude/.mcp.json`) transfer verbatim via `git show` — those files are pipeline-agnostic. The `spawnIcdCoding` function in `main.js` is rewritten natively against develop's manifest-driven, per-child architecture and uses the shared `spawnClaude` wrapper for token logging (the original bypassed `spawnClaude` and missed token capture).

**Rejected:**
- Merging `icd10-coding` into the post-unification `develop`: produces large conflicts in `main.js`; even if resolved, the ICD step would still need rewriting for per-child execution. Less work to start fresh.
- Copying `spawnIcdCoding` verbatim from `icd10-coding`: the original used a raw `spawn()` call that skipped `spawnClaude`'s token-usage parsing and lacked `processing_events` integration. Rewriting natively was strictly cheaper than retrofitting.
- Adding an `icd_status` column to `cases` (as `icd10-coding` did): superseded by `processing_events.status` + the `recording-status-update` IPC. Schema additions in this branch are scoped to Phase 2 (the `cdi_*` columns + `cdi_flags` table).
- Deleting `icd10-coding` immediately: kept as a read-only reference until `cdi-v1` ships on develop and is verified stable on a staging install. Optional tag + delete post-merge.

**Implications:**
- ICD runs **per case folder, not per recording**. Single-patient: once on the parent case folder's `soap_note.md`. Multi-patient: once per child case folder's `soap_note.md`. The recording (audit) folder in multi-patient runs retains the SOAP `.md` files the skill wrote — never ICD-coded, never docx-converted.
- ICD failure is **non-blocking** — the pipeline always falls through to docx. `processing_events.status` captures the failure (`failed` / `rate_limited`) and a `service-warning` IPC fires on MCP-auth or rate-limit errors; the case still completes.
- Multi-patient runs execute ICD **sequentially across children** — `applyMultiPatientManifest` is now async and awaits each child's `spawnIcdCoding` before kicking off that child's docx. Parallel children would share the MCP connector and Anthropic quota and would interleave per-case log blocks; not worth it for the modest wall-clock savings.
- Pre-chart **re-runs ICD** after `edit-note` rewrites a SOAP `.md`. The skill strips any prior `## ICD-10-CM Codes` section before appending the new one (idempotent).
- `notes-claude/.mcp.json` is bundled in the repo and written to `<NOTES_DIR>/.mcp.json` by `ensureMcpConfig()` on every skills sync (initial whenReady, after-git-pull update, and change-notes-dir). This means the `claude.ai ICD-10` connector is wired even on installs whose user-level `~/.claude.json` doesn't already have it.
- After `cdi-v1` ships to develop and is verified stable, `icd10-coding` is archived (locally `git branch -D icd10-coding`; remote tip optionally tagged for posterity).

---

## 2026-05-19 (rs) — CDI v1 ships as a standalone skill + markdown standards files

**Context:** Engine 1 (CDI Co-Pilot) is the next-week deliverable per Jayanth. Plan [docs/plans/2026-05-19-rs-cdi-v1-skill.md](plans/2026-05-19-rs-cdi-v1-skill.md) splits delivery into two PRs: Plan 1 = the skill + standards files (this entry), Plan 2 = app integration (`spawnCdiReview` in main.js, UI, DB writes — written *after* the skill is verified manually).

**Decision:** Ship CDI v1 as a `claude -p`-invocable skill at `notes-claude/skills/cdi-review/`, with reference content in a new `notes-claude/standards/` directory. The skill produces three outputs per case in the case folder: `<stem>_cdi.json` (canonical), `<stem>_cdi.md` (rendered from the JSON), and `<stem>_cdi.docx` (produced later by `python/md_to_docx.py`). The skill is **non-blocking** — a CDI failure must not break the downstream SOAP pipeline; the skill itself always tries to write *something*, even on parse error, so Plan 2's main.js always has a file to point to. v1 supports `orthopedics` only; other specialties produce a stub output with `error: "specialty not yet supported"` and exit cleanly (no generic universal-only fallback — settled in [docs/pa-planning/04-open-questions.md](pa-planning/04-open-questions.md) Round 2).

**Skill-level shape of standards consumption:** `standards/icd10_fy2026.md` (universal ICD-10), `standards/ahima_acdis_2026.md` (query compliance), `standards/specialties/<doctor.specialty>.md` (specialty-specific layered rules). Adding a specialty = drop a file. No code change. The standards files are designed to be reusable by future review engines (SOAP Validator, E/M Scorer, etc.) — each file's "Used by:" header tracks the dependency graph.

**Skill judgment calls made during implementation (consistent with the plan's "open items" latitude):**

- **Quality score formulas:** used the plan's defaults verbatim — `overall = max(0, 100 − 15C − 5W − 1S − 0O)`; specificity sub `= max(0, 100 − 12 * spec_flag_count)`; evidence sub `= round(avg(confidence) * evidence_factor)` where factor = 1.0 if every flag has ≥ 1 found AND ≥ 1 missing, else 0.85; completeness sub `= max(0, 100 − 12 * completeness − 8 * linkage)`. Simple, explainable, easy to retune after real-case testing.
- **Two-pass extraction prompting:** expressed as explicit two-step prompt instruction in `SKILL.md` Step 3 (Pass 1 = extract every Dx from HPI + transcript + objective + assessment + plan; Pass 2 = evaluate against rules). Not trusted to emerge from a single-shot prompt.
- **`medical_necessity_status` mapping:** explicitly defined — `supported` requires the note to address symptom duration + functional impact + prior-treatment outcome; `weak` if some elements present, others missing; `missing` if not addressed at all.
- **Example codes in `orthopedics.md`:** included a curated set against the common-traps section (G56.0x carpal tunnel, M65.3xx trigger finger, M17.1x knee OA, M75.1xx rotator cuff, etc.) — not exhaustive, but enough to anchor the LLM. Claude's training covers FY2026 codes well enough that an exhaustive listing would just bloat the standards file.
- **Standards file verbosity:** ~5 KB universal files, ~9 KB orthopedics pack. The LLM gets all three files plus the SOAP note plus transcript as context per invocation — concision matters, but ortho needs the room to cover Chapter 13 vs. 19, fracture coding, named tests, conservative therapy, and the 10 specificity traps.

**Rejected:** (1) Inline CDI rules in the skill prompt itself — would couple rule updates to skill edits; standards files let you bump the ICD-10 FY without touching the skill. (2) JSON-schema-driven validator step — overkill for v1; a single `python3 -m json.tool` validation pass plus one retry is sufficient. (3) Inpatient DRG-impact field in the schema — out of scope (we're outpatient); kept the field as `null` for forward-compat. (4) Generic universal-only fallback for unsupported specialties — rejected per Round 2 decision; CDI without a specialty pack risks more harm than help.

**Implications:**
- Don't edit content inside `<NOTES_DIR>/.claude/standards/` — it's overwritten from `notes-claude/standards/` on every app start (same as the skills sync). Edit the repo files.
- Adding a new specialty (cardiology, family medicine, ENT, etc.) requires only `notes-claude/standards/specialties/<name>.md` — no skill change. The skill's specialty gate in Step 1 checks for the file at runtime.
- Plan 2 will:
  - Add `spawnCdiReview` to main.js, mirroring the `spawnSoapGeneration` pattern (non-blocking).
  - Parse one of three terminal lines: `CDI_OK:`, `CDI_SKIPPED:`, `CDI_FAIL:`.
  - Extend `python/md_to_docx.py` for severity-coloured cells in the CDI docx.
  - Add per-doctor `specialty` + `enable_cdi` + `cdi_mode` settings (default: disabled until specialty is set).
  - Hide `*_cdi.md` and `*_cdi.json` on Windows (canonical view shows the docx only).
- **Test execution is not in this PR.** The implementing session documented six test scenarios in `notes-claude/skills/cdi-review/TESTS.md` as a checklist for the human to run after merge. Nested `claude -p` calls during implementation waste tokens, are slow, and don't catch the right issues — real-case verification by the user is the gate.

**Known v1.1 follow-ups (logged 2026-05-22):**

- **Move CDI rendering script out of `SKILL.md` into `python/cdi_render.py`.** The deterministic JSON→markdown rendering Python script in Step 8 of `cdi-review/SKILL.md` (~100 lines) is mechanical formatting, not LLM work. It belongs in a sibling Python file the same way `md_to_docx.py` lives. Result: skill drops from ~650 to ~550 lines, rendering becomes testable without spawning Claude, and the future colored-cell styling pass becomes a Python-only edit. Not blocking v1.
- **Strip repo-internal doc references from `notes-claude/` content.** Lines like "(per the design decision in `docs/pa-planning/04-open-questions.md` Round 2)" in `SKILL.md` and `standards/README.md` reference files that aren't synced to `<NOTES_DIR>/.claude/` at runtime. The skill is a production artifact — rationale belongs in DECISIONS.md, not in the skill prompt. Behavior statements only in runtime files.
- **Unify docx generation path.** See [plans/2026-05-22-rs-unify-docx-generation.md](plans/2026-05-22-rs-unify-docx-generation.md). The `generate-note` skill currently has inline docx generation (added during the multi-patient flow work — that hack works but breaks the convention that all docx conversion goes through `main.js` → `python/md_to_docx.py`). Reconcile by giving skills a manifest contract and letting main.js drive all docx conversion.

**Follow-up amendment (2026-05-22) — soft-target flag counts, no hard caps:**

The original mode table specified hard caps (compliance: 4, balanced: 6, aggressive: 8) drawn from Fahd's PDF + `pa_agents.py`'s "Max 6 flags. Prioritize by revenue impact." On the first two real-case test runs (Tsai mark_freund, Sabbag cupp_carol_lee, both balanced mode), the engine produced exactly 6 flags in each case — strongly suggesting the cap was biting and the model was selecting "top 6" rather than reporting all genuine gaps.

Hard caps were the wrong shape of filter — the severity filter (no `opportunity` in compliance/balanced) and confidence threshold (≥70/50/30) already do the right job. A count cap is an arbitrary third filter that pressures the model to drop legitimate clinical-safety or over-coding-defense flags when many genuine issues coexist (e.g., Sabbag's Marx note has ~10 real gaps).

**Amendment:** the numbers stay in the mode table as **soft targets** — guidance for the scribe's expectations and an encouragement to consolidate truly redundant findings. The model is explicitly told these are not caps and may exceed them when warranted. The hard rules remain the severity filter and confidence threshold.

Updated in: `notes-claude/skills/cdi-review/SKILL.md` (Step 3 mode table + Step 4 constraints + Step 6 mode reference), `notes-claude/skills/cdi-review/TESTS.md` (Scenario 3 assertions), `docs/pa-planning/05-engines.md` (sub-feature 1.7).

---

## 2026-05-18 (rs) — SQLite as a metadata + index store, not a content store

**Context:** App state lived in three places: the filesystem (case folders walked on every IPC call), `settings.json` (doctors array), and `app.log` (token usage as unqueryable text). Pre-chart "recent cases" rescanned the whole `Cases/` tree on every open. Token cost per case required grepping logs. Phase 2 features (CDI, evaluations) need queryable per-case state.

**Decision:** Introduce SQLite (`app.db` in `NOTES_DIR`) as a metadata + index store. Files on disk remain canonical (transcripts, soap notes, docx, MP3s). DB stores references to those files plus structured metadata and per-stage processing events with token usage. Four v1 tables: `doctors`, `sessions`, `cases`, `processing_events`. WAL mode, `better-sqlite3` in main process, `busy_timeout = 5000ms`. All write sites wrapped in `try/catch` — a failed DB write never blocks the recording pipeline. Schema versioned by `PRAGMA user_version`; migrations are numbered SQL files under `db/migrations/`. Doctors migrated from `settings.json` on first launch; backup written to `settings.doctors.backup.json`.

**Rejected:** Keeping everything in `settings.json` (not queryable, no relational history). Using a full ORM (unnecessary complexity for a local single-writer app). Storing file artifacts in the DB as blobs (breaks the "everything's a file in your notes folder" affordance for end users).

**Implications:** All doctor CRUD goes through `db/doctors.js`; `settings.json` no longer carries `doctors[]` after migration. Every spawn function (transcribe, soap, docx, template create/update, prechart) emits `startEvent`/`finishEvent` rows. `spawnClaude` passes the full parsed result event as a 4th `onClose` arg so token data reaches the DB. `record.py` prints `DURATION_SECONDS: <float>` on stop for `cases.audio_duration_seconds`.

## 2026-04-28 (rs) — `notes-claude/` is the source of truth for skills

**Context:** Skills live in `<NOTES_DIR>/.claude/skills/` at runtime so the local `claude` CLI can find them. But that folder is per-user data outside the repo, so edits there aren't versioned.

**Decision:** Bundle skills under `notes-claude/` in the repo. On every app start (and after every successful `git pull`), `copyDirSync` mirrors `notes-claude/` → `<NOTES_DIR>/.claude/`.

**Rejected:** Symlinking — fragile across Windows / shared drives. Telling users to clone into the notes-dir — couples app and data lifecycle.

**Implications:**
- Edit skills only in `notes-claude/`. Edits to `<NOTES_DIR>/.claude/` are silently overwritten on next launch.
- Adding a skill = drop a folder under `notes-claude/skills/`. No further wiring needed.
- The app's auto-update flow re-runs the sync after pulling, so users get new skills without restarting twice.

---

## 2026-04-28 (rs) — Template creation as a background job with persistent state

**Context:** AI template creation runs `claude -p` with Opus 4.7 at max effort — takes several minutes. The popup window can hide on blur, and users may close it during a job.

**Decision:** Treat it as a background job. Persist `{status, doctorName, lastname, startedAt, ...}` in `<NOTES_DIR>/.template_job.json`. Renderer reads on open + subscribes to `template-job-status` events. Only one job at a time (`templateJobProc !== null` lock). On startup, any `running` status from a prior run is rewritten to `failed` (the child died with the app).

**Rejected:** Modal in-popup progress — blocks the rest of the app. In-memory only — popup close loses state.

**Implications:** New long-running operations should follow the same pattern: a sentinel JSON file in NOTES_DIR + an IPC event channel + startup-cleanup of orphaned `running` states.

---

## 2026-04-28 (rs) — `settings.json` lives in `<NOTES_DIR>`, not in user prefs

**Context:** App config (doctors, models, audio device, autoRecord) needs somewhere to live.

**Decision:** Store as `<NOTES_DIR>/settings.json`. Travels with the notes folder if the user moves it. `NOTES_DIR_PATH` itself lives in `.env` since it has to be readable before settings can be loaded.

**Rejected:** `app.getPath('userData')` (Electron default) — orphans config when the user moves the notes folder; harder for the user to inspect/edit.

**Implications:** New persistent settings go in `DEFAULT_SETTINGS` ([main.js:77](../main.js#L77)). Don't scatter them across files.

---

## 2026-04-28 (rs) — Stop recording via stdin, not signal

**Context:** Stopping a recording must give Python time to flush WAV, convert to MP3 with pydub, and exit cleanly. On Windows, `process.kill()` translates to `TerminateProcess`, which doesn't run cleanup code.

**Decision:** `stop-recording` writes `stop\n` to the Python process's stdin. A reader thread inside `record.py` sets a `threading.Event` the recording loop polls. `pause` and `resume` use the same channel.

**Rejected:** `SIGTERM` / `SIGBREAK` — unreliable on Windows when fired from Node. `kill()` — no clean shutdown on Windows.

**Implications:**
- DO NOT replace the stdin write in `stop-recording` / `discard-recording` with `.kill()`.
- Any future control commands to record.py go through the same stdin protocol.
- `before-quit` is the one place we *do* `.kill()` — when the app is dying anyway and a clean shutdown isn't worth blocking on.

---

## 2026-04-28 (rs) — Platform-split audio capture: PyAudioWPatch + sounddevice

**Context:** `pyaudio` (the common Python audio lib) has no native WASAPI loopback. `pyaudiowpatch` is a maintained fork that does. On macOS, the standard solution is BlackHole + a Multi-Output Device, accessed via `sounddevice`. The two libs conflict if installed together.

**Decision:** `requirements.txt` uses platform markers — `pyaudiowpatch` only on win32, `sounddevice` only on darwin. `record.py` branches on `sys.platform`.

**Rejected:** Cross-platform abstraction (e.g. `python-soundcard`) — less reliable on Windows for loopback. Bundling a virtual driver on Windows — unnecessary, WASAPI loopback is built in.

**Implications:** Two code paths to keep aligned. When changing the recording loop (formats, stop semantics, error reporting), update *both* branches.

---

## 2026-04-28 (rs) — Non-blocking pipeline: return to SESSION_ACTIVE before transcription

**Context:** Scribes do back-to-back consultations. Waiting for transcription + SOAP generation between cases would dead-time them.

**Decision:** `stop-recording` builds the case folder, kicks off transcription, and immediately sets state back to `SESSION_ACTIVE`. The pipeline runs detached (each child only listens for its predecessor's `close`).

**Rejected:** Synchronous PROCESSING state until SOAP note ready — kills throughput. Job queue with explicit progress UI — overkill for a single-user app.

**Implications:**
- The state machine is intentionally lightweight — it only models user-controllable flow, not the pipeline.
- Errors from transcribe/soap/docx must surface via `service-warning` (or notifications) since the state has already moved on.
- Don't put pipeline status into `currentState` — it's case-scoped, not session-scoped.

---

## 2026-04-28 (rs) — Auto-update via `git pull` on startup

**Context:** Users are scribes, not engineers. They install once and the app should self-update.

**Decision:** Run `git pull --ff-only` in the repo on every launch. If new commits land, re-sync skills and notify the user to restart. All failures logged and ignored — never blocks startup.

**Rejected:** Electron auto-updater — overhead for a small, internal-distribution app. Manual update instructions — users won't follow them.

**Implications:** The repo dir must remain a clean working tree on user machines. If we ever ship a build that requires user-side data migration, we need a startup version-check that runs before the app uses the data.

---

## 2026-04-28 (rs) — Single bundled skill prompt format

**Context:** The skills (`generate-note`, `create-doctor-profile`) are invoked by string prompts to `claude -p`. Their parsing is regex-ish.

**Decision:** Keep the prompt format strict and documented in CLAUDE.md and ARCHITECTURE.md:
- `generate a note using template "X" and transcript "Y"` (template optional)
- `create a doctor profile for "<name>" from source folder "<rel>"`

**Implications:** Don't change the spawn-side string in main.js without updating Step 0/1 of the corresponding SKILL.md, and vice versa. They're a contract.

---

## 2026-05-25 (rs) — `generate-note` emits a structured JSON manifest; app owns multi-patient folder splits + all DOCX

**Context:** The `generate-note` skill historically owned three responsibilities in addition to writing the SOAP note:

1. Detecting multi-patient transcripts and creating per-patient sub-folders next to the recording folder.
2. Copying the MP3 and full transcript into each per-patient sub-folder.
3. Generating `.docx` inline via pandoc / `python-docx`.

Every other skill writes `.md` only and lets `main.js → spawnDocxConversion → python/md_to_docx.py` handle conversion. The split here meant two docx code paths (the skill's and the app's) and made multi-patient runs opaque to `main.js` — the app had to scan the filesystem after the fact to discover what sub-folders the skill had created, which broke down for child DB rows, file hiding, and any downstream skill chaining.

**Decision:** Skill writes all `.md` outputs into the recording folder it was given and ends its final assistant response with a single-line JSON manifest (`schema_version: 1`) declaring patient name(s), per-case file paths, `multi_patient` flag, and per-case status. `main.js` parses the manifest via `parseSkillManifest()` (layered defensive parser: direct → strip fences → brace-balance scan) and does everything else:

- **Single-patient:** verify the declared `.md` is on disk, run docx, hide, update existing `cases` row to `completed`.
- **Multi-patient:** for each `ok`/`partial` case, create a child folder matching the single-patient on-disk convention (`<slug>_<YYYY-MM-DD>/`), copy in the MP3 + transcript + transcript.docx with single-patient naming, copy in the SOAP `.md` renamed to match, hide the audit `.md` in the recording folder (Windows), insert a child `cases` row (`createChildCase` in `db/cases.js`, status `converting` → flips to `completed` via the docx success path), and spawn docx on the copied `.md`. After the loop the parent row is marked `completed` with `soap_note_path=NULL` — an audit row. The recording folder retains all SOAP `.md` files the skill wrote, alongside the MP3 and transcript.

**Rejected:**

- **Skill keeps inline docx** — leaves two divergent docx paths and any future styling change (CDI severity-coloured cells, etc.) has to be applied twice.
- **Skill keeps multi-patient folder creation** — moves file shuffling, copy semantics, and folder collision handling into a Claude invocation; loses structured visibility for the app's DB writes, status window, and file hiding.
- **Adding manifest columns to `cases`** — `visit_type`, `chief_complaint`, `placeholders`, `warnings`, `summary` all live in the parsed manifest object and are logged to `app.log` only. Adding columns later is a one-line migration; preallocating is not. The DB stores only what existing queries need.
- **Persisting the manifest to a file** — `app.log` is sufficient for v1. A future "resume failed split" feature would need a durable manifest; that's deferred.

**Implications:**

- `notes-claude/skills/generate-note/SKILL.md` Steps 4, 6, 7 rewritten — no sub-folders, no copies, no inline docx; ends with manifest line. Schema + 3 worked examples embedded in the skill.
- `main.js` close handler in `spawnSoapGeneration` rewritten to manifest-driven; the old `detectPatientFolders` filesystem-probe helper is removed.
- `parseSkillManifest()` extracted into [parseSkillManifest.js](../parseSkillManifest.js) so it is unit-testable in isolation. [tests/parseSkillManifest.test.js](../tests/parseSkillManifest.test.js) covers the four parse layers + failure modes.
- `db/cases.js` gains `createChildCase` (inserts a child case with all paths populated, `status='converting'`) and `getCaseRow` (read-back for inheriting `recorded_at`/`doctor_id` onto child rows). **No schema changes.**
- Multi-patient child folders are on-disk indistinguishable from single-patient cases — pre-chart, recent-cases listings, DB queries, and file hiding all work unmodified.
- The skill is now schema-version-gated. Future format changes bump the version; the app fails closed (treats unknown versions as failed) until it catches up. Adopting the same JSON manifest format across the other skills (`cdi-review`, `edit-note`, `create-doctor-profile`, `update-doctor-profile`, future `icd`) is queued as follow-up work — out of scope for this PR.

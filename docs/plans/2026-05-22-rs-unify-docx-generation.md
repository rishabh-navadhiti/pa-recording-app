# Unify docx generation — one canonical path

**Status:** Planned. To be implemented soon after CDI v1 lands.

**Scope:** Remove inline docx generation from the `generate-note` skill and shift all `.md` → `.docx` conversion to the canonical app-driven path (`main.js` → `python/md_to_docx.py`). Introduce a skill-to-app **manifest contract** so multi-patient cases can produce per-patient docx without the skill owning the conversion step.

**Out of scope:** Touching `cdi-review`, `edit-note`, `create-doctor-profile`, or `update-doctor-profile` skills (they already follow the right pattern — produce `.md`, let the app convert). Touching `python/md_to_docx.py` internals (no changes needed; it already converts one file at a time).

---

## Context

The canonical docx pipeline is:

```
Skill writes .md  →  main.js spawnDocxConversion  →  python/md_to_docx.py  →  .docx
```

This holds for all skills *except* `generate-note`, which currently has an inline docx step inside its `SKILL.md` (added during the multi-patient flow work). The reason was practical: when one transcript covers N patients, the skill creates N sub-folders that `main.js` doesn't know about at spawn time — so the skill generated each sub-folder's docx itself.

That hack works but creates inconsistency:

- **generate-note** — produces `.md` AND `.docx` (multi-patient hack, inline pandoc/python-docx fallback)
- **edit-note, create-doctor-profile, update-doctor-profile, cdi-review** — produce `.md` only; main.js converts to docx
- **main.js spawnDocxConversion** — the canonical docx path

Three problems:
1. **Two code paths to maintain** for the same operation. If docx styling changes (CDI severity-coloured cells, for example), we have to update both.
2. **Token cost in the skill** — running pandoc / python-docx logic inside a Claude invocation wastes context and adds bash overhead.
3. **Hidden file generation** — main.js doesn't know which docx files exist after a multi-patient run, so its file-hiding pass on Windows + status reporting can drift.

---

## Target state

After this plan:

- **All skills produce `.md` files only.** No docx generation inside any skill prompt.
- **All skills emit a structured terminal "manifest" line** that lists the `.md` files they produced (and optionally other metadata). Mirrors the `CDI_OK: <path> · <N> flags · quality <X>/100` contract already in cdi-review.
- **main.js parses the manifest** from the skill's stdout and spawns `python/md_to_docx.py` once per `.md` file in the manifest.
- **Single-patient generate-note runs** keep the existing simple flow — one `.md`, one `.docx`. No behaviour change visible to the user.
- **Multi-patient generate-note runs** produce N `.md` files in N sub-folders; main.js iterates and converts each.

---

## Changes per file

### `notes-claude/skills/generate-note/SKILL.md`

**Remove** the inline docx generation step we added during the multi-patient work (the "Generate DOCX" block in Step 6 with the `pandoc` / `python-docx` fallback).

**Keep** the `.md` writing logic (single-patient writes one file; multi-patient writes N files in N sub-folders).

**Add** a terminal manifest line as the skill's last stdout line:

```
NOTES_OK: <md-path-1>[, <md-path-2>, ...]
```

- Single-patient case: one path.
- Multi-patient case: comma-separated absolute paths for every `.md` produced (the parent recording summary if any, plus each patient sub-folder's `.md`).
- On failure: `NOTES_FAIL: <reason>` (mirrors `CDI_FAIL:` from cdi-review).

This matches the `CDI_OK:` / `CDI_SKIPPED:` / `CDI_FAIL:` terminal-line contract documented in CLAUDE.md "Don't touch" §4.

### `main.js`

**`spawnSoapGeneration`** ([main.js ~line ?]):

1. Capture the skill's terminal output (stdout already piped through `spawnClaude`).
2. Parse the `NOTES_OK:` line — extract the comma-separated `.md` paths.
3. For each `.md` path, fire `spawnDocxConversion(mdPath)`. Convert serially (`for (...await...)`) — these are small files; parallel adds complexity without benefit.
4. On `NOTES_FAIL:`, log and surface the existing setup/service warning IPC. Don't try to recover.
5. The legacy assumption "one .md file at `<case_dir>/<stem>_soap_note.md`" goes away — multi-patient cases now produce multiple files in sub-directories.

**Per-stage status reporting** ([recording-status-update channel]):
- The "docx" stage in the per-case status popup may now fire multiple times for multi-patient runs (once per patient). Either:
  - (a) Emit one update with a list of files being converted, or
  - (b) Keep the stage as a single "converting" step that completes when all files are done.

Recommend (b) for simplicity — the floating status window's stage line doesn't need to enumerate every sub-file.

**File hiding** ([hideFileFromUser / hideExistingCaseMdFiles]):
- Currently the Windows file-hiding pass walks case folders and hides `.md` files there. For multi-patient cases this needs to walk sub-folders too. Probably already works (the walk is recursive in the helper) — verify when implementing.

### `python/md_to_docx.py`

**No changes anticipated.** The script already converts one file at a time. Main.js will call it per `.md` file.

If we discover the script needs to know about the parent SOAP case (for header metadata in the docx), add a `--patient-name` arg. Likely not needed.

### Other skills

**No changes.** `edit-note`, `create-doctor-profile`, `update-doctor-profile`, `cdi-review` already produce only `.md` and rely on the app to convert. They should optionally adopt the same `NOTES_OK:` / `<X>_OK:` terminal-line manifest convention for consistency, but that's a follow-up — not required for this plan.

---

## Migration / rollout

This change is **breaking** within the running app — main.js needs to be updated in the same PR as the generate-note skill change, otherwise multi-patient runs will silently lose their docx files.

Single PR with both:
1. Skill change (remove inline docx + add manifest line)
2. main.js change (parse manifest + spawn per-file)
3. Manual test: single-patient run → 1 docx as before. Multi-patient run (Spencer's 5-patient recording) → 5 docx files in 5 sub-folders.

Roll forward only — no need for a feature flag since the multi-patient case is the only one that uses the inline docx path today; single-patient cases already round-trip through `spawnDocxConversion`.

---

## Test plan

- [ ] **Single-patient recording end-to-end** — record, name patient, wait for pipeline. Verify: one `.md` and one `.docx` in the case folder. No regression.
- [ ] **Multi-patient recording end-to-end** — use Spencer's 5-patient transcript (or any multi-patient transcript). Verify: 5 sub-folders, each with a `.md` and a `.docx`. No `.md` left without its corresponding `.docx`.
- [ ] **Skill manifest format** — invoke generate-note manually via `claude -p` on a known multi-patient transcript; inspect the terminal output. The `NOTES_OK:` line should list all `.md` files with absolute paths.
- [ ] **Failure path** — corrupt the transcript file to force a skill error. Verify: main.js logs the `NOTES_FAIL:` line and does not crash; user sees a service warning.
- [ ] **Windows file hiding** — on Windows, multi-patient sub-folder `.md` files are hidden (only the `.docx` is visible to the end user).
- [ ] **Pre-chart on a multi-patient case** — Pre-chart picks one patient's `.md` to edit. After edit, the corresponding `.docx` is re-generated. Other patient sub-folders are untouched.

---

## Out of scope

- Restructuring the multi-patient flow itself (folder naming, manifest format inside the case, etc.). The change is purely about *who generates the docx*, not *what the case folder looks like*.
- Adding parallel docx conversion. Single-threaded `for await` is fine; conversion is fast.
- Changes to `cdi-review` or any other skill. They already follow the target pattern.
- Touching `extract_attachments.py`, `transcribe.py`, or `record.py`.

---

## Risks

- **Manifest parsing edge cases.** A `.md` filename containing a comma would break the parsing. Mitigate: use newline-separated paths instead of comma if patient names are ever expected to contain commas. Or sanitise patient names at folder-creation time (already done).
- **Backward-compat with old generate-note skill in user installs.** Users on older skill versions would still produce docx inline; that's fine until they pull the new skill. The main.js change tolerates the absence of a manifest line (treat as "no docx to convert by us") for one release cycle as a safety, then warn and remove that fallback.
- **Multi-patient detection drift.** If the generate-note skill changes how it splits multi-patient transcripts in a future version, the manifest contract still holds — main.js doesn't care about the splitting, only about the list of files.

---

## Deliverables checklist

When implementing this plan:

- [ ] `notes-claude/skills/generate-note/SKILL.md` — remove inline docx generation step; add `NOTES_OK:` / `NOTES_FAIL:` terminal-line contract.
- [ ] `main.js` — `spawnSoapGeneration` parses `NOTES_OK:` and iterates `spawnDocxConversion` per `.md` file. Tolerates missing manifest for one release cycle as backward-compat.
- [ ] `CLAUDE.md` — update "Don't touch" §4 to add the `generate-note` terminal-line contract (mirrors the cdi-review entry already there).
- [ ] `docs/ARCHITECTURE.md` — update the recording-pipeline sequence diagram to reflect that `spawnSoapGeneration` now fans out into one-or-more `spawnDocxConversion` calls.
- [ ] `docs/DECISIONS.md` — append an entry documenting the manifest contract and the rationale for the unification.
- [ ] Manual test: single-patient case → unchanged behaviour. Multi-patient case → one docx per patient sub-folder. No docx files missing.

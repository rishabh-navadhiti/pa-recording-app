# Condensed single-call note-gen prompt (canonical draft)

**Date:** 2026-06-18 (rev 2 — de-tailored + verified across all 11 doctor templates)
**Purpose:** the **SYSTEM prompt** for the API note-gen path — it replaces the 331-line agentic `generate-note/SKILL.md` (and the temporary "baked preamble on the old skill" from the M1 plan). This *is* the body of `notes-claude/skills/generate-note-api/SKILL.md`. The doctor **TEMPLATE + TRANSCRIPT still go in the USER message unchanged** — the template carries all doctor-specific structure/format/style; this prompt only governs how to fill it from one API call.
**Status:** draft for the implementation chat to integrate.
**Related:** [single-call plan](../plans/2026-06-18-single-call-note-generation.md), [multi-patient plan](../plans/2026-06-18-multipatient-api.md).

---

## Design principle (read first)

The prompt must work for **every** doctor — and the templates vary wildly in specialty and structure: hand/foot/ankle/spine ortho (sabbag, spencer, tsai, harris, ryan, dietrick, hindoyan, costigan), **ENT** (peterson — letterheads, endoscopy), **GYN/menopause** (park — HRT, pap, DEXA), **OB-GYN/primary care** (manuel — pelvic exam, 3 note types). Some have workers'-comp note types; most don't. Some have a scribe attestation; some don't. Some have one note type; manuel has three.

→ Therefore the prompt is **principle-based and template-deferential, not prescriptive.** It must NOT carry any doctor-, specialty-, or workers'-comp-specific assumption as if it were universal, and it must NEVER add a section/field/attestation/label the template doesn't define. The headline rule is: **the template is the source of truth; your job is to FILL it, never to impose structure of your own.** Anything specialty-specific (WC blocks, scribe attestation, LOS dot-phrases, exam layouts, HPI labels, style quirks) lives in each doctor's template and is reached only *because the template has it*.

## What this fixes (from the Sabbag + Harris model-comparison sessions)

The dangerous API-model failures were **fabrication**, not weak clinical ability, and closed by prompt + injection:
- Models **copy concrete values out of the template's EXAMPLE notes** (example scribe names, dates, carriers) → forbidden generically.
- Models **invent a Date of Service / patient name** → the app **injects** both (it has the name from the patient-name form, the date from `recorded_at`); instruction alone is insufficient.
- **Note/visit-type misclassification** (the "employer mention ⇒ wrongly WC" trap) → an explicit "don't switch type on weak cues; use the template's default" rule.
- **Placeholder-echo on exam sections** (even Sonnet left an exam block as template placeholders under a strict "never invent" rule) → a dedicated *synthesize-the-exam* rule.

This rev also **removed the ortho/WC tailoring** (scribe-attestation-always, WC legal blocks, `Per PTP`, `.KS14` LOS, PR-1/PR-2 labels, `Date of Service:` header, `[Side]` exam, the WC `visit_type` enum) that would have injected inappropriate content into ENT/GYN/etc. templates.

---

## SYSTEM prompt (use verbatim as the `generate-note-api` system prompt)

```
You are an expert medical scribe. From the visit TRANSCRIPT and the physician's NOTE TEMPLATE (both in the user message), produce ONE complete clinical note that fills the template from the transcript, followed by a single-line JSON manifest. Write the whole note now — do not ask questions, do not add commentary, do not stop early.

THE TEMPLATE IS THE SOURCE OF TRUTH.
The NOTE TEMPLATE fully defines this physician's note: which note/visit types exist, the section order and headings, the header/letterhead block, label styling (bold/underline), every boilerplate block and its trigger, the Assessment/Plan format, the placeholder conventions, and the Global Style (voice, tense, attribution verbs, abbreviations, punctuation). Follow it EXACTLY. Your job is to FILL it from the transcript — NEVER add, rename, reorder, drop, or restructure anything the template does not define, and never impose a generic note structure of your own. If the template has no such section, field, attestation, or block, do not invent one. When the template and these rules ever seem to disagree about format or content, the TEMPLATE wins.

AUTHORITATIVE INJECTED FACTS.
The user message includes an "INJECTED FACTS" block (e.g. Patient Name, Date of Service, Doctor) supplied by the application. Use them verbatim wherever the template has the corresponding field, overriding anything in the transcript for those facts. For anything not injected, follow Rule 2.

RULE 1 — CAPTURE EVERYTHING.
The transcript is mostly doctor–patient conversation; the clinical content (history, symptoms, functional impact, prior treatment, exam findings, imaging, the plan, medications, scheduling, follow-up, anyone co-managing care) is buried inside the dialogue and any end-of-visit dictation. Read all of it. Make each section as full and detailed as the template's section calls for. Never compress, drop, or generalize a detail that is present.

RULE 2 — NEVER FABRICATE; use the template's own placeholders, not guesses.
The template may contain EXAMPLE notes or example values — these illustrate style ONLY; never copy a name, date, scribe, address, identifier, code, or boilerplate-slot value out of an example into this note. Use only facts stated in the transcript or the INJECTED FACTS. For any field the template defines but the transcript does not fill, leave the template's own placeholder (or blank) exactly as the template dictates — do NOT guess, and do NOT add a field the template doesn't have. Specifically:
- Never invent a patient name and never "correct-guess" a garbled one — use the injected/transcript name, else the template's placeholder.
- Leave any scribe-name slot as the template's placeholder unless the transcript explicitly names the scribe. (If the template has no scribe field, add none.)
- Reproduce any billing/LOS line or any regulatory/legal block ONLY as the template's placeholder — never compose your own.
- If a finding's side/laterality (or any scored value like a pain score) isn't stated, use the template's placeholder rather than choosing one.

RULE 3 — NOTE TYPE / VISIT TYPE.
If the template defines more than one note or visit type (e.g. initial vs follow-up vs post-op, telehealth, or private vs workers'-comp), pick the one that matches this visit from transcript cues and use that section's exact structure and labels. If it defines only one, use it. Do NOT switch type on weak cues — e.g. a patient merely mentioning their job or employer is not by itself a workers'-comp visit; choose a special type only on clear indicators the template describes. When unsure, use the template's default / most-common type.

RULE 4 — BOILERPLATE, FORMAT & EMPTY SECTIONS.
Reproduce every boilerplate block whose trigger condition is met WORD-FOR-WORD from the template (never paraphrase or abbreviate). Reproduce the template's header/letterhead, section order, headings, and label styling exactly as shown — do not bold a label the template shows unbolded, and keep every header line the template includes. For a section the template includes but the visit gives no content for, keep the heading and leave it blank as the template dictates — do not write "N/A" and do not delete it.

RULE 5 — EXAM / PROCEDURE SECTIONS: synthesize, don't echo placeholders.
For any exam, focused/regional exam, or procedure section the template defines, SYNTHESIZE the findings the doctor actually described during the visit. Only leave a sub-field as a placeholder if it was genuinely never addressed — do not echo the template's example placeholders when the visit covered it.

RULE 6 — MULTI-PATIENT: detect first, then bail or focus.
BEFORE writing anything, determine whether the transcript documents MORE THAN ONE distinct patient (an explicit transition like "next patient", a new patient name, or a second full encounter for a different person). Then:
- TARGETED MODE — if the INJECTED FACTS name a specific patient to generate for (the app's per-patient fan-out), generate ONLY that patient's note from their portion of the transcript, ignore all other patients, "multi_patient": false.
- SINGLE PATIENT — generate the note normally, "multi_patient": false.
- MULTIPLE PATIENTS and NO targeted patient — do NOT write any note. Emit ONLY the manifest line with "multi_patient": true and one entry in "cases[]" per patient (each with "patient_name" best-effort, null if unclear, and "chief_complaint" if determinable, "status":"partial"; leave the given paths unchanged). Then STOP. The application re-issues one request per patient in TARGETED MODE.

RULE 7 — OUTPUT.
For SINGLE-PATIENT and TARGETED modes, begin your reply with exactly:
# Medical SOAP Note

**Doctor:** <doctor full name, from INJECTED FACTS or the template>
**Date:** <Date of Service from INJECTED FACTS, else the template's placeholder>

---

(this fixed wrapper precedes the template's own content) then the complete note, section by section, per the template. For the MULTIPLE-PATIENTS-detected case, write NO note — emit only the manifest. After any note, output NOTHING but the manifest line — no summary, no commentary, no code fence. Any human-readable summary goes BEFORE the manifest line, never after.

MANIFEST — the very last line, one line of valid JSON, no code fence:
{"schema_version":1,"skill":"generate-note","status":"ok|partial","multi_patient":false,"summary":"<one line>","recording_folder":"<value from the user message>","cases":[{"patient_name":<name or null>,"doctor_lastname":"<lastname from the user message>","visit_type":"<the chosen template section/visit-type label, lowercased_with_underscores, or null>","chief_complaint":"<one line or null>","soap_note_md":"<value from the user message>","placeholders":[{"field":"<snake_case>","reason":"<one line>"}],"warnings":[],"status":"ok|partial"}],"warnings":[]}
Use "status":"partial" whenever any placeholder remains in the note (or for a multiple-patients-detected manifest).
```

---

## USER message assembly (built by the app each run)

```
Generate the note for doctor <doctor_lastname>.

INJECTED FACTS (authoritative — use exactly where the template has the field):
- Patient Name: <name from the patient-name form, or "(not provided — use transcript or the template's placeholder)">
- Date of Service: <MM/DD/YYYY from recorded_at>
- Doctor: <doctor full name>
- recording_folder: <absolute case-folder path>
- soap_note_md: <absolute note path>

DOCTOR TEMPLATE:
---
<full template .md text>
---

TRANSCRIPT:
---
<full transcript .md text>
---

Write the full note now, following the DOCTOR TEMPLATE and the rules, then the manifest line.
```

**Two call modes (identical SYSTEM prompt):**
- **Normal:** the user message above. Single-patient transcript → a note; multi-patient transcript → the model **bails** with a detection manifest (Rule 6), no note.
- **Targeted fan-out:** for each patient the detection returned, the app re-issues with the detected name as `Patient Name` **plus** one extra INJECTED-FACTS line — `- Target patient (multi-patient fan-out — generate ONLY this patient, ignore the others): <detected name>` — so the model produces that one patient's note. See the [multi-patient plan](../plans/2026-06-18-multipatient-api.md).

---

## Integration notes for the implementation chat

- **Where it goes:** this SYSTEM text is the body of `notes-claude/skills/generate-note-api/SKILL.md` (after the frontmatter). It supersedes the M1 plan's "duplicate old skill + runtime preamble".
- **App injects** (all values the app already holds): `Patient Name` (form), `Date of Service` (`recorded_at`), `Doctor` + `doctor_lastname`, `recording_folder` + `soap_note_md`. Injection is **not optional** — it removes the name/date fabrication class. If the patient name is unknown, pass the "(not provided…)" line.
- **App owns the path:** write the note to the app's own `soap_note_md`; the manifest's echoed path is advisory.
- **Manifest stays `"skill":"generate-note"`** for the existing `parseSkillManifest` contract; `visit_type` is the template's own chosen section label (no fixed enum), matching the original generate-note schema.
- **Reasoning OFF** for all models. **Caching:** SYSTEM prompt (fixed) + per-doctor template = the stable cacheable prefix; keep them first.
- **Doctor-agnostic by design:** any per-doctor quirk belongs in that doctor's template (Global Style / boilerplate / placeholders), never in this shared prompt.
- **Worth a quick eval** before shipping wider: run this exact prompt on one case each for a *non-ortho* template (peterson ENT, park GYN, manuel) plus an ortho one (sabbag/harris), and confirm it adds nothing the template doesn't define and fills exam sections rather than echoing placeholders.

#!/bin/bash
# Usage: ./generate-soap.sh <doctor_lastname> "<case_folder_path>"
# Example: ./generate-soap.sh sabbag "/Users/rish/Development/PA/agent test/Cases/Alan Chu"

set -e

DOCTOR="${1:?Usage: $0 <doctor> <case_path>}"
CASE_PATH="${2:?Usage: $0 <doctor> <case_path>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATES_DIR="$(cd "$SCRIPT_DIR/../../templates" && pwd)"

CASE_STEM="$(basename "$CASE_PATH")"
SOAP_NOTE_PATH="${CASE_PATH}/${CASE_STEM}_soap_note.md"
TEMPLATE_PATH="${TEMPLATES_DIR}/${DOCTOR}.md"

# --- Validate inputs ---
if [ ! -d "$CASE_PATH" ]; then
  echo "ERROR: Case folder not found: $CASE_PATH" >&2
  exit 1
fi

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "ERROR: Template not found: $TEMPLATE_PATH" >&2
  exit 1
fi

TRANSCRIPT_FILE="$(ls "${CASE_PATH}"/*transcript*.md 2>/dev/null | head -1)"
if [ -z "$TRANSCRIPT_FILE" ]; then
  echo "ERROR: No transcript file found in: $CASE_PATH" >&2
  exit 1
fi

echo "Doctor:     $DOCTOR"
echo "Case:       $CASE_STEM"
echo "Transcript: $TRANSCRIPT_FILE"
echo "Output:     $SOAP_NOTE_PATH"
echo ""

TRANSCRIPT="$(cat "$TRANSCRIPT_FILE")"
TEMPLATE="$(cat "$TEMPLATE_PATH")"

# --- Build prompt ---
PROMPT="You are a medical scribe generating a doctor's clinical note. You must follow the doctor's template exactly.

=== DOCTOR TEMPLATE ===
${TEMPLATE}

=== PATIENT TRANSCRIPT ===
${TRANSCRIPT}

=== INSTRUCTIONS ===
1. Read the full template above carefully. Identify the correct note type (WC or Private) from the transcript context.
2. Generate the complete note following the template's exact structure, headings, section order, and formatting rules — not a generic SOAP format.
3. Use verbatim boilerplate text wherever the template specifies named macros (injection_macro_1st_him, biopsychosocial_wc, thank_you_wc, etc.).
4. Fill in patient-specific content ONLY from the transcript. Do not add details not stated.
5. Leave optional fields (like RADIOGRAPHS, DIAGNOSES in WC notes) as blank headings — never write N/A or omit them.
6. Output ONLY the raw note content — no explanations, no preamble, no markdown wrapper. Start immediately with the first line of the note itself."

# --- Generate note ---
echo "Generating note..."
CLAUDECODE="" claude -p "$PROMPT" --dangerously-skip-permissions > "$SOAP_NOTE_PATH"

echo ""
echo "Done. Saved to: $SOAP_NOTE_PATH"

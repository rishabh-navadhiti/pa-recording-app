#!/bin/bash
# generate-note.sh — Generate a SOAP note from a case folder
#
# Usage:
#   ./generate-note.sh --doctor sabbag --case "/path/to/Cases/Alan Chu"
#   ./generate-note.sh sabbag "/path/to/Cases/Alan Chu"
#
# The recorder app can call this script after saving the transcript.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GENERATE_SCRIPT="${SCRIPT_DIR}/.claude/scripts/generate-soap.sh"

# Parse args — support both --flag and positional
DOCTOR=""
CASE_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --doctor|-d) DOCTOR="$2"; shift 2 ;;
    --case|-c)   CASE_PATH="$2"; shift 2 ;;
    *)
      if [ -z "$DOCTOR" ]; then DOCTOR="$1"
      elif [ -z "$CASE_PATH" ]; then CASE_PATH="$1"
      fi
      shift ;;
  esac
done

if [ -z "$DOCTOR" ] || [ -z "$CASE_PATH" ]; then
  echo "Usage: $0 --doctor <lastname> --case <case_folder_path>"
  echo "   or: $0 <lastname> <case_folder_path>"
  exit 1
fi

exec bash "$GENERATE_SCRIPT" "$DOCTOR" "$CASE_PATH"

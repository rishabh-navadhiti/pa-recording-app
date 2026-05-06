#!/usr/bin/env python3
"""
extract_attachments.py — Combine multiple attachment files into a single .md
for the edit-note skill.

The edit-note skill takes ONE attachment path. The Pre-chart UI lets the scribe
pick multiple files, so the app pre-combines them here before invoking the
skill. Per-file extraction logic mirrors the skill's Step 5 so the model sees
the same content shape it would have if each file were passed individually.

Usage:
    python extract_attachments.py --output <out.md> --inputs <p1> [<p2> ...]

Behaviour per input:
    .md / .txt   read as UTF-8 (errors='replace')
    .docx        python-docx (paragraphs joined with newlines)
    .pdf         pdfplumber, falling back to pypdf
    other        line written into output saying it was skipped
    failure      line written into output with the error; processing continues

Output format:
    <contents of file 1 — verbatim>

    --- <basename of file 2> ---

    <contents of file 2 — verbatim>

    ...

The first file gets no header so a single-file run looks identical to passing
that file directly. Subsequent files are introduced by --- <basename> ---
separators.

Exit codes:
    0  output written successfully (even if some inputs were skipped/failed)
    1  output could not be written at all
"""

import argparse
import sys
from pathlib import Path


def extract_md_or_txt(path: Path) -> str:
    return path.read_text(encoding='utf-8', errors='replace')


def extract_docx(path: Path) -> str:
    from docx import Document
    doc = Document(str(path))
    return '\n'.join(p.text for p in doc.paragraphs if p.text.strip())


def extract_pdf(path: Path) -> str:
    try:
        import pdfplumber
        with pdfplumber.open(str(path)) as pdf:
            return '\n\n'.join((p.extract_text() or '') for p in pdf.pages)
    except ImportError:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        return '\n\n'.join((p.extract_text() or '') for p in reader.pages)


def extract_one(path: Path) -> str:
    """Return extracted text. Caller decides how to wrap with separators."""
    ext = path.suffix.lower()
    if ext in ('.md', '.txt'):
        return extract_md_or_txt(path)
    if ext == '.docx':
        return extract_docx(path)
    if ext == '.pdf':
        return extract_pdf(path)
    return f'> Skipped {path.name} — unsupported format ({ext or "no extension"})'


def main() -> int:
    parser = argparse.ArgumentParser(description='Combine attachments into one .md')
    parser.add_argument('--output', required=True, help='Output .md path')
    parser.add_argument('--inputs', required=True, nargs='+', help='Input file paths')
    args = parser.parse_args()

    out_path = Path(args.output)
    pieces = []

    for idx, raw in enumerate(args.inputs):
        in_path = Path(raw)
        if not in_path.exists():
            print(f'WARNING: input not found: {in_path}', file=sys.stderr)
            text = f'> Failed to read {in_path.name}: file not found'
        else:
            try:
                text = extract_one(in_path)
            except Exception as exc:
                print(f'WARNING: extraction failed for {in_path}: {exc}', file=sys.stderr)
                text = f'> Failed to read {in_path.name}: {exc}'

        if idx == 0:
            pieces.append(text.rstrip())
        else:
            pieces.append(f'\n\n--- {in_path.name} ---\n\n{text.rstrip()}')

    combined = '\n'.join(pieces) + '\n'

    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(combined, encoding='utf-8')
    except Exception as exc:
        print(f'ERROR: could not write output {out_path}: {exc}', file=sys.stderr)
        return 1

    print(str(out_path))
    return 0


if __name__ == '__main__':
    sys.exit(main())

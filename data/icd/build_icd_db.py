#!/usr/bin/env python3
"""
build_icd_db.py — regenerate the bundled local ICD-10-CM lookup DB from the CMS order file.

This is a once-per-fiscal-year MAINTENANCE tool, not part of the app runtime. The app reads the
committed icd10cm_fy<YEAR>.db read-only via src/icd/lookup.js (better-sqlite3). See README.md for
where to get the source file.

Source: the CMS/CDC ICD-10-CM "order file" (icd10cm-order-<YEAR>.txt), fixed-width:
  cols 0:5   order number
  cols 6:13  dotless code (right-padded)
  col  14    billable flag: '1' = valid_for_hipaa_transactions, '0' = header/non-billable
  cols 16:76 short description (the official short title — what we surface)
  cols 77:   long description (NOT stored — short_desc is sufficient for coding + cross-check;
             dropping it keeps the committed DB small)

Usage:
  python3 build_icd_db.py [path/to/icd10cm-order-2026.txt] [out.db]
Defaults: source = ./icd10cm-order-2026.txt, out = ./icd10cm_fy2026.db (next to this script).
"""
import sqlite3, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "icd10cm-order-2026.txt")
DB  = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "icd10cm_fy2026.db")


def dotted(code: str) -> str:
    """ICD-10-CM puts the decimal after the 3rd character; 3-char categories have none."""
    return code if len(code) <= 3 else code[:3] + "." + code[3:]


def main():
    if not os.path.exists(SRC):
        sys.exit(f"source order file not found: {SRC}\n(see README.md for the download URL)")

    rows = []
    with open(SRC, encoding="utf-8") as f:
        for ln in f:
            if not ln.strip():
                continue
            code = ln[6:13].strip()
            if not code:
                continue
            flag  = ln[14:15].strip()
            short = ln[16:76].strip()
            rows.append((dotted(code), code, 1 if flag == "1" else 0, short))

    if os.path.exists(DB):
        os.remove(DB)
    con = sqlite3.connect(DB)
    con.execute("CREATE TABLE codes ("
                "code TEXT PRIMARY KEY, code_nodot TEXT, billable INTEGER, short_desc TEXT)")
    con.executemany("INSERT OR REPLACE INTO codes VALUES (?,?,?,?)", rows)
    con.execute("CREATE INDEX idx_nodot ON codes(code_nodot)")
    # FTS5 over the description; `code` is UNINDEXED so MATCH hits only short_desc
    # but we can still read the code back from the row.
    con.execute("CREATE VIRTUAL TABLE codes_fts USING fts5(code UNINDEXED, short_desc)")
    con.execute("INSERT INTO codes_fts(code, short_desc) SELECT code, short_desc FROM codes")
    con.commit()
    con.isolation_level = None   # autocommit — VACUUM cannot run inside a transaction
    con.execute("VACUUM")
    con.isolation_level = ''

    total    = con.execute("SELECT COUNT(*) FROM codes").fetchone()[0]
    billable = con.execute("SELECT COUNT(*) FROM codes WHERE billable=1").fetchone()[0]
    print(f"built {DB}")
    print(f"  rows={total}  billable={billable}  headers={total - billable}  "
          f"size={os.path.getsize(DB) / 1e6:.1f}MB")
    for c in ("M54.50", "M65.4", "M19.07", "M25.77", "A00"):
        print(f"  {c:9} -> {con.execute('SELECT code, billable, short_desc FROM codes WHERE code=?', (c,)).fetchone()}")
    con.close()


if __name__ == "__main__":
    main()

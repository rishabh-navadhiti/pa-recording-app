# Bundled ICD-10-CM codeset (`data/icd/`)

`icd10cm_fy2026.db` is the **local, read-only ICD-10-CM lookup database** the ICD-coding step
uses to validate the codes the model proposes — the offline replacement for the claude.ai
ICD-10 MCP connector. It is read by `src/icd/lookup.js` (better-sqlite3) at runtime. Because the
app runs from this git checkout and auto-updates via `git pull`, committing the DB here is how it
reaches every install — no separate download or packaging step.

## What's in it

Every FY2026 ICD-10-CM code (~98k rows), one table + an FTS5 description index:

```
codes(code TEXT PK, code_nodot TEXT, billable INTEGER, short_desc TEXT)
codes_fts USING fts5(code UNINDEXED, short_desc)     -- description search
```

- `billable = 1` ⇔ the code is `valid_for_hipaa_transactions` (a billable leaf); `0` ⇔ a
  category/header code. This is the connector's billable flag, taken from the CMS **order file**
  (the only flat file that carries it).
- `short_desc` is the official ICD-10-CM short description. `long_desc` is intentionally NOT
  stored — the short description is sufficient for coding + the description cross-check, and
  dropping it keeps the committed DB ~21 MB instead of ~42 MB.

## Regenerating for a new fiscal year (once per October)

1. Download the CMS/CDC **"Code Descriptions in Tabular Order"** zip for the fiscal year and
   extract the order file `icd10cm-order-<YEAR>.txt`. Source (public domain):
   - CDC: `https://ftp.cdc.gov/pub/health_statistics/nchs/publications/ICD10CM/<YEAR>/icd10cm-Code%20Descriptions-<YEAR>.zip`
   - or the CMS ICD-10 page: `https://www.cms.gov/medicare/coding-billing/icd-10-codes`
2. Build:
   ```
   python3 data/icd/build_icd_db.py path/to/icd10cm-order-<YEAR>.txt data/icd/icd10cm_fy<YEAR>.db
   ```
3. Commit the new `icd10cm_fy<YEAR>.db`. `src/icd/lookup.js` auto-selects the newest
   `icd10cm_fy<YEAR>.db` present, so **no code change is needed** — just drop in the new file
   (and delete the prior year's if you don't want to keep it).
4. Parity-check against the live ICD-10 connector on a sample of codes before trusting a new
   build (existence + billable + description should agree).

Only the built `.db` and this builder are committed — the ~15 MB source `.txt` is not (get it
from the URL above when regenerating).

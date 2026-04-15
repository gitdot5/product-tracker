# Stage 5 — MedSum-style Merged Medical Records

**Date:** 2026-04-14
**Component:** `pipeline/stage5_merge.py`
**Status:** ✅ Validated against MedSum ground truth (Peterson + Westling)

## What it does

Takes a folder of source files and produces a single merged PDF matching
MedSum's "Merged Medical Records" deliverable:

- All source files concatenated (alphabetical default; receipt-order via CSV)
- One **L1 bookmark per source file** named `"{filename}.pdf (p.{start}-{end})"`
  or `"{filename}.pdf (p.{start})"` for single-page files
- **L2-L5 bookmarks preserved** from each source PDF's internal outline,
  with page numbers offset to the merged document

## Supported source formats

| Category | Extensions | Conversion |
|---|---|---|
| PDF | `.pdf` | inserted directly |
| Office | `.doc`, `.docx`, `.rtf`, `.odt` | LibreOffice headless |
| Images | `.jpg`, `.jpeg`, `.png`, `.tif`, `.tiff`, `.heic`, `.bmp`, `.webp`, `.gif` | PIL → single-page PDF |

`.DS_Store`, `Thumbs.db`, `desktop.ini`, and dotfiles are always skipped.

## Validation

### Case 1 — Alejandra Peterson (10 source files, alphabetical = receipt order)

| Metric | MedSum | Ours | Match |
|---|---|---|---|
| Page count | 699 | 699 | ✅ |
| Source files | 10 | 10 | ✅ |
| L1 bookmarks | 10 | 10 | ✅ |
| Total bookmarks | 78 | 78 | ✅ |
| Level histogram | {1:10, 2:4, 3:15, 4:25, 5:24} | {1:10, 2:4, 3:15, 4:25, 5:24} | ✅ |
| L1 titles | identical character-for-character | identical | ✅ |
| L1 page ranges | `p.1-51`, `p.52-139`, `p.140-143`, … | identical | ✅ |

**Result: 100% structural match.** The only delta is PyMuPDF reports MedSum's
bookmarks as `p. -1` (named destinations) vs our `p. 1, 52, 140, …` (direct
page refs). Click behavior is identical; only the PDF-level encoding differs.

### Case 2 — Mabelle Westling (20 source files, receipt order ≠ alphabetical)

| Metric | MedSum | Ours | Match |
|---|---|---|---|
| Page count | 332 | 332 | ✅ |
| Source files | 20 | 20 | ✅ |
| L1 bookmarks | 20 | 20 | ✅ |
| Set of source files | identical (all 20) | identical | ✅ |
| Order | receipt batch | alphabetical | ⚠️ differs |

**Result: content identical, order differs.** MedSum started with
`09-26-23 Coast Dental`; ours starts with `01-17-24 UF Health` (alphabetical).
This is the 1/6 corpus case where alphabetical ≠ receipt order.

**Workaround:** Run with `--manifest receipt_manifest.csv`:

```csv
filename,received_at
09-26-23 to 10-09-23 MR Coast Dental.pdf,2024-09-26
09-26-23 to 10-09-23 MR Tioga Dental & Orthoontics.pdf,2024-09-26
10-02-23 MR Haile Endodontics.pdf,2024-10-02
...
```

The manifest can be generated from MedSum's existing output for any case:
parse the L1 bookmarks in the old PDF and emit a CSV mirroring that order.

## How to run

```bash
# Default (alphabetical)
python -m pipeline.stage5_merge \
    --source "Source Files/" \
    --output "Merged Medical Records - Patient.pdf"

# With receipt manifest
python -m pipeline.stage5_merge \
    --source "Source Files/" \
    --output "Merged Medical Records - Patient.pdf" \
    --manifest "receipt_manifest.csv"

# Flat (no subdirectory recursion)
python -m pipeline.stage5_merge --source "Source Files/" \
    --output "Merged.pdf" --no-recurse
```

Peterson runtime (10 files → 699 pages): **~100 ms**.
Westling runtime (20 files → 332 pages): **~240 ms**.

## Implementation notes

- Source TOC preservation walks `src_doc.get_toc(simple=False)` before
  `insert_pdf`, then re-emits with `(level + 1, title, page + cursor)` so the
  source's root-level entries become L2 under our L1 file bookmark.
- Image conversion normalizes RGBA/LA/P → RGB before `PIL.Image.save`.
- All page numbers in bookmark labels are human-readable 1-indexed ranges.
- Output saved with `garbage=4, deflate=True` to minimize file size (our
  Westling output is 52 MB vs MedSum's 58 MB — 11% smaller due to better
  compression, no content difference).
- Skips any source file that fails to convert or open (logs warning,
  continues). Corrupt source files don't block the whole merge.

## Known follow-ups

1. **Receipt manifest generator.** Script to extract L1 bookmarks from an
   existing MedSum merged PDF and emit a CSV — useful for regression testing
   on past cases.
2. **Level-1 preservation.** Source PDFs sometimes have a useful level-1 TOC
   entry (e.g. Peterson's CME Report has "Dr. Damon Salzman" at top). Our
   implementation correctly demotes those to L2 under our file bookmark,
   matching MedSum's convention.
3. **Page-ref reindex.** If a chronology was written against MedSum's ordering
   and we produce a different ordering, the chronology's PDF refs will be
   wrong. The chronology writer (Stage 5c) must consume the same ordering we
   produce here.

## Files

- `pipeline/stage5_merge.py` — the script (~245 lines)
- `_deploy_2026-04-14/STAGE5_MERGE_REPORT.md` — this report
- `_deploy_2026-04-14/Peterson_Merge_Test.pdf` — 21 MB validation output
  (compare to `Expert Evaluation Cases/Alejandra Peterson/Final Files/Merged Medical Records - Alejandra Peterson.pdf`)
- `_deploy_2026-04-14/Westling_Merge_Test.pdf` — 52 MB validation output

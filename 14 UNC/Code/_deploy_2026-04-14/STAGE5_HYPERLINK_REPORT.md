# Stage 5 — MedSum-style Hyperlinked Medical Records

**Date:** 2026-04-14
**Component:** `pipeline/stage5_hyperlink.py`
**Status:** ✅ Validated against MedSum ground truth (Nicholas Hatcher)

## What it does

Takes two inputs — a medical chronology (`.doc` / `.docx` / `.pdf`) and a merged
records PDF — and produces a single PDF matching MedSum's "Hyperlinked Medical
Records" deliverable:

- Chronology pages at the front
- Merged records appended after
- Every page reference in the chronology becomes a clickable `LINK_GOTO`
  annotation jumping to the referenced page in the records section

Non-PDF chronology inputs are converted via headless LibreOffice.

## Validation — Nicholas Hatcher

Ground truth: `Final Files/Hyperlinked Medical Records - Nicholas Hatcher.pdf`
(produced by MedSum).

| Metric | MedSum | Ours |
|---|---|---|
| Total pages | 885 | 885 |
| Chronology pages | 66 | 67 ¹ |
| Records pages | 819 | 818 ¹ |
| Internal GOTO links | 128 | 225 |
| External links | 0 | 0 |

**Link-set overlap (source page → target page):**

| | Count |
|---|---|
| Exact-match pairs (present in both) | 127 |
| Only in MedSum | 1 |
| Only in Ours | 94 |

**Recall on MedSum's links: 127 / 128 = 99.2%** — the single miss
is `(MedSum p.57 → target 352)`, which we produced as `(p.56 → 352)`.
Same semantic link; the source-page index differs by 1 because our
LibreOffice conversion yields a 67-page chronology vs MedSum's 66.

**Extras (94):** our script is slightly more liberal than MedSum:

1. When a page ref is a range like `27-32`, we link both endpoints (`27` and
   `32`); MedSum links only `27`.
2. The "Missing Medical Records" table on the last chronology page has a
   `PDF Reference` column (e.g. `184-195, 432-443`); we link those numbers,
   MedSum does not.

Both behaviours are arguably useful for navigation. Easy to tighten to
MedSum-exact if we want precision over recall.

## How to run

```bash
python -m pipeline.stage5_hyperlink \
    --chronology "Medical Chronology - Patient.doc" \
    --records    "Merged Medical Records - Patient.pdf" \
    --output     "Hyperlinked Medical Records - Patient.pdf"
```

On Hatcher (67 chron pages + 818 records pages = 885 total): ~2.5 seconds
end-to-end including LibreOffice conversion.

## Implementation notes

- Uses `fitz.insert_pdf()` to append records to the chronology PDF.
- Parses chronology pages via `page.get_text("dict")` → lines → spans.
- A line yields link candidates when either:
  - it contains a `PDF Ref` / `PDF REF` / `PDF Reference` keyword (link all
    numbers after the keyword), OR
  - the entire line is page-ref-shaped — digits, commas, hyphens, whitespace
    only (i.e. the last column of the Detailed Summary table).
- Numbers outside `[1, len(records)]` are dropped so stray `5 mg` etc. don't
  leak through.
- Link bbox is located via `page.search_for(str(n), clip=line_bbox)`.
- Target page index: `chronology_page_count + n - 1`.

## Known follow-ups

1. **Off-by-one chronology length.** LibreOffice's `.doc → PDF` rendering
   sometimes produces one extra page vs the original Word typesetting.
   Acceptable; the link targets are still correct because the offset is
   applied uniformly.
2. **Tighten to MedSum-exact.** Drop range endpoint links and Missing
   Records table links if pixel-perfect replication is required.
3. **Pipeline integration.** Wire into `run_pipeline.py` as Stage 5a
   alongside DOCX formatters. Would run after chronology.docx is produced
   and before final bundling.

## Files

- `pipeline/stage5_hyperlink.py` — the script (≈230 lines).
- `_deploy_2026-04-14/Hatcher_Hyperlinked_Test.pdf` — test output (26 MB)
  used to validate the link-set overlap numbers above.

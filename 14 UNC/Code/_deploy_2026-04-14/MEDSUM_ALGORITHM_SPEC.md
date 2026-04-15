# MedSum Full-Algorithm Reverse-Engineering Spec

**Date:** 2026-04-14
**Corpus analyzed:** 8 completed MedSum cases
(Alejandra Peterson, Anna Leonard, Drew Brownlow, Kim Douglas-Beyer, Mabelle
Westling, Marisa Stidam, Nicholas Hatcher, Dominic Lutes) + Jon Witting's
MedSum-produced files as reference.

**Purpose:** replicate MedSum's 4-file deliverable so the UNC pipeline can
drop it cleanly. Every structural, formatting, and ordering convention is
documented below so nothing is guessed.

---

## 1. Deliverable contract — four files, exact filenames

```
Final Files/
├── Delivery Note - {PatientName}.docx
├── Medical Chronology - {PatientName}.doc                # .doc (legacy), NOT .docx
├── Merged Medical Records - {PatientName}.pdf
└── Hyperlinked Medical Records - {PatientName}.pdf
```

**Notes observed across corpus:**

- `{PatientName}` is the full human name with spaces (e.g. "Nicholas Hatcher")
  and can include hyphens ("Kim Douglas-Beyer").
- Filename typos occur in production (Anna Leonard has `Hyperlinked Medical
  Reocrds`, sic). Our pipeline should standardize on the clean spelling.
- Chronology is always `.doc` (Word 97-2003 binary). Delivery Note is `.docx`.
  This is a MedSum convention, not a technical requirement — we can output
  .docx for both and the downstream UNC pipeline accepts either.

---

## 2. File A — Merged Medical Records (.pdf)

**Deterministic, no AI.** The most mechanically reproducible artifact.

### 2.1 Ordering rule

The Delivery Note boilerplate says *"merged all the medical records together
in the order of receipt"*. In practice, across the corpus:

| Case | Alphabetical match? | Notes |
|---|---|---|
| Alejandra Peterson | ✅ | Alphabetical = receipt order |
| Drew Brownlow | ✅ (mostly) | Minor grouping by provider |
| Marisa Stidam | ✅ | "CP-" → "Leon" → "MED-" → photos |
| Mabelle Westling | ❌ | Date-prefix filenames reordered by receipt batch |
| Hatcher / Lutes | ✅ | Alphabetical |

**Our implementation rule:**

1. If a receipt-date manifest is provided (e.g. `manifest.csv` with
   `filename, received_at`), sort by `received_at`.
2. Otherwise, sort alphabetically by filename (matches 5/6 observed cases).

### 2.2 Concatenation rule

- Non-PDF source files are converted to PDF first:
  - `.doc` / `.docx` → LibreOffice headless
  - `.jpg` / `.jpeg` / `.png` / `.heic` → `img2pdf` or PIL → single-page PDF
- Concatenate in the order chosen above using PyMuPDF `insert_pdf`.

### 2.3 Bookmark rule — THIS IS LOAD-BEARING

Every merged records PDF has an outline (TOC) with at minimum one **L1
bookmark per source file**, named:

```
{original_filename}.pdf (p.{start}-{end})
```

or for single-page files:

```
{original_filename}.pdf (p.{start})
```

Examples from the corpus:

- `CME Report - Dr. Salzman (Def's neurologist).pdf (p.1-51)`
- `Records - Brevard County Fire Rescue 4.8.23.pdf (p.140-143)`
- `PHOTO 5 - Face scar.pdf (p.1383)`

**Bookmark counts per case** (= source-file count in every observed case):

| Patient | Merged pages | Source files | L1 bookmarks |
|---|---|---|---|
| Peterson | 699 | 10 | 10 |
| Leonard | 2,702 | ≈42 | 531 (incl. nested) |
| Brownlow | 1,464 | ≈28 | 435 (incl. nested) |
| Douglas-Beyer | 848 | 14 | 13 |
| Westling | 332 | 20 | 20 |
| Stidam | 1,385 | 52 | 52 |

When `source_file_count != L1 count`, the extras are **L2-L5 sub-bookmarks
preserved from the source PDF's internal outline**. PyMuPDF's `insert_pdf`
does NOT preserve the source TOC automatically, so we must:

1. Read `source.get_toc(simple=False)` before inserting
2. Insert the source pages
3. Emit our L1 bookmark at the start page
4. Append shifted sub-bookmarks (all levels from source TOC, with page
   numbers offset by `current_end_page - 1`)

### 2.4 Pseudocode

```python
def merge_records(source_files, output_path, receipt_order=None):
    import fitz
    files = receipt_order or sorted(source_files, key=lambda p: p.name)
    out = fitz.open()
    toc = []
    cursor = 0
    for f in files:
        pdf = to_pdf(f)  # convert if needed
        src = fitz.open(pdf)
        start, end = cursor + 1, cursor + len(src)
        label = f"{f.name} (p.{start}{'' if start == end else f'-{end}'})"
        toc.append([1, label, start])
        # Preserve source TOC as sub-bookmarks
        for lvl, title, pg in src.get_toc(simple=False):
            toc.append([lvl + 1, title, cursor + pg])
        out.insert_pdf(src)
        cursor = end
        src.close()
    out.set_toc(toc)
    out.save(output_path, garbage=4, deflate=True)
```

---

## 3. File B — Hyperlinked Medical Records (.pdf)

**Deterministic, no AI.** Already built as `pipeline/stage5_hyperlink.py` —
99.2% link-recall vs Hatcher ground truth. See `STAGE5_HYPERLINK_REPORT.md`.

### 3.1 Structure

```
[chronology pages 1..N]   ← Medical Chronology .doc rendered to PDF
[records pages N+1..M]    ← Merged Medical Records inserted
```

- Every page-reference token in the chronology is a clickable internal
  `LINK_GOTO` annotation pointing to `N + ref_page`.
- Links are placed only on the digit itself (narrow bbox from
  `page.search_for`), matching MedSum's style.

### 3.2 Page-reference detection

A chronology token becomes a link candidate when its line matches **one of two patterns**:

1. Contains a keyword `PDF Ref` / `PDF REF` / `PDF Reference` / `Ref:` —
   link every number after the keyword.
2. Whole-line regex `^[\s\d,\-]+$` — the line is pure digits/commas/hyphens/
   whitespace (i.e. the last column of the Detailed Summary table).

Numbers outside `[1, records_page_count]` are dropped.

### 3.3 Observed metrics (corpus)

| Patient | Chron pg | Records pg | Hyperlinked pg | GOTO links |
|---|---|---|---|---|
| Peterson | 95 | 699 | 794 | 149 |
| Leonard | 145 | 2702 | 2847 | 332 |
| Brownlow | 90 | 1464 | 1554 | 125 |
| Douglas-Beyer | 61 | 848 | 909 | 132 |
| Westling | 61 | 332 | 393 | 109 |
| Stidam | 76 | 1385 | 1461 | 108 |
| **Hatcher (ours)** | **67** | **818** | **885** | **225 ¹** |

¹ Our version links range endpoints + Missing Records table cells that MedSum
skips. Easy to tighten. Semantic recall vs MedSum: 127/128 = 99.2%.

---

## 4. File C — Medical Chronology (.doc)

**AI-heavy, template-driven.** The most complex deliverable.

### 4.1 Master structure (confirmed across all 8 cases)

```
Medical Chronology/Summary

Confidential and privileged information

Usage guideline/Instructions         ← boilerplate (§4.2)
    * Verbatim summary:
    * Case synopsis/Flow of events:
    * Injury report:
    * Comments:
    * Indecipherable notes/date:
    * Patient's History:
    * Snapshot inclusion:
    * De-Duplication:

General Instructions:                 ← 3-4 case-specific bullets (§4.3)
    •  The medical summary focuses on … 
    •  Initial and final therapy evaluation …
    •  Prior related records …

Injury Report:                        ← 2-col table (§4.4)
    DESCRIPTION       | DETAILS
    Prior injury details    | …
    Date of injury          | MM/DD/YYYY
    Description of injury   | …
    Injuries/Diagnoses      | • bullet list
    Treatments rendered     | Medications: / Procedures: / Therapy: …

Flow of events                        ← bulleted date-range summaries (§4.5)

Patient History                       ← 5 labeled lines with PDF ref (§4.6)
    Past Medical History: …       (PDF ref: X)
    Surgical History: …           (PDF ref: X)
    Family History: …             (PDF ref: X)
    Social History: …             (PDF ref: X)
    Allergy: …                    (PDF ref: X)

Detailed Summary                      ← 4-col table (§4.7)
    DATE  |  FACILITY/PROVIDER  |  MEDICAL EVENTS  |  PDF REF
    (grouped by provider, one row per encounter)
```

### 4.2 Usage Guidelines boilerplate

Identical across all cases (minor spelling / spacing jitter). Use this exact
template:

```
*Verbatim summary: All the medical details have been included "word by word" or
"as it is" from the provided medical records to avoid alteration of the meaning
and to maintain the validity of the medical records. The sentence available in
the medical record will be taken as it is without any changes to the tense.
*Case synopsis/Flow of events: For ease of reference and to know the glimpse of
the case, we have provided a brief summary including the significant case
details.
*Injury report: Injury report outlining the significant medical events/injuries
is provided which will give a general picture of the case.
*Comments: We have included comments for any noteworthy communications,
contradictory information, discrepancies, misinterpretation, missing records,
clarifications, etc for your notification and understanding. The comments will
appear in red italics as follows: "*Comments".
*Indecipherable notes/date: Illegible and missing dates are presented as
"00/00/0000" (mm/dd/yyyy format). Illegible handwritten notes are left as a
blank space "_____" with a note as "Illegible Notes" in heading reference.
*Patient's History: Pre-existing history of the patient has been included in
the history section.
*Snapshot inclusion: If the provider name is not decipherable, then the
snapshot of the signature is included. Snapshots of significant examinations
and pictorial representation have been included for reference.
*De-Duplication: Duplicate records and repetitive details have been excluded.
```

### 4.3 General Instructions — three bullets, patient-specific

Template:

```
• The medical summary focuses on {INCIDENT_TYPE} on {DOI}, the injuries and
  clinical condition of {PATIENT_NAME} as a result of {INJURY_TYPE},
  treatments rendered for the complaints and progress of the condition.
• Initial and final therapy evaluation has been summarized in detail. Interim
  visits have been presented cumulatively to avoid repetition and for ease of
  reference.
• Prior related records have been summarized in detail and prior unrelated
  records have been summarized in brief manner.
```

Variants observed: "only musculoskeletal injuries have been summarized in
detail" (Westling, Leonard) — used when prior records include non-related
conditions. Choice is AI-determined from source material.

### 4.4 Injury Report table

2-column (tab-separated in .doc source): `DESCRIPTION | DETAILS`.

Rows (in order):

1. **Prior injury details** — bulleted list of prior injuries/conditions, or "None available"
2. **Date of injury** / **Date of injuries** (plural for multi-DOI cases)
3. **Description of injury** / **Description of injuries** — prose, includes mechanism (seat position, speed, airbag deployment, LOC status)
4. **Injuries/Diagnoses** — bulleted ICD-style list, verbatim from source
5. **Treatments rendered** — grouped sub-headings:
   - Medications:
   - Procedures:
   - Therapy: (chiropractic / physical / vision / speech / psychotherapy — date ranges)
   - Imaging:

### 4.5 Flow of Events

Date-range summaries formatted as:

```
MM/DD/YYYY-MM/DD/YYYY: On MM/DD/YYYY, [description…] On MM/DD/YYYY, 
[next event…]
```

Grouped by primary provider. Optional italic reviewer comment between groups:
`*Reviewer's comment: Significant interim records are not available for review`

### 4.6 Patient History — exactly 5 lines

Each line ends with `(PDF ref: X)` where X is the page reference, or
`(PDF Ref: X)` (capitalization inconsistent across cases).

```
Past Medical History: [semicolon-separated prose]  (PDF ref: X)
Surgical History: [list]                           (PDF ref: X)
Family History: [list]                             (PDF ref: X)
Social History: [tobacco / alcohol / drugs / occupation]  (PDF ref: X)
Allergy: [drug allergies + environmental]          (PDF ref: X)
```

Missing section: write `Not available.` (Westling: Surgical History).

### 4.7 Detailed Summary — 4-column table

```
DATE | FACILITY/ PROVIDER | MEDICAL EVENTS | PDF REF
```

Table cells are tab-separated in .doc source. Formatting conventions:

- **DATE column:** `MM/DD/YYYY` or `MM/DD/YYYY-MM/DD/YYYY` for range visits.
  A "provider group" header row appears above subrows: `{Facility Name}` /
  `MM/DD/YYYY-MM/DD/YYYY` (italic, no other columns).
- **FACILITY/PROVIDER column:** Line 1 = facility, line 2 = primary provider
  with credentials, line 3 = secondary provider if any (PA-C, CRNP, DC, DO).
- **MEDICAL EVENTS column:** verbatim transcription with these conventional
  sub-headings bolded:
  - `Chief complaint:` / `History of present illness:` / `Presentation:`
  - `Review of systems:` / `Vital signs:` / `Physical exam:`
  - `Differential diagnosis:` / `MDM notes:` / `Clinical impression:`
  - `Assessment:` / `Plan:` / `Medications:` / `Imaging:` / `Labs:`
- **PDF REF column:** numeric refs, comma-and-range formatted:
  `184-195, 432-443` (one cell can list multiple non-contiguous ranges).

Reviewer comments appear in red italic between rows:
`*Reviewer's comment: …` or `*Comments: …`.

### 4.8 Styling (from `.doc` binary inspection)

- **Font:** Times New Roman, 11pt body, 12-14pt section headers (bold).
- **Section headers:** bold, mostly 12pt, some underlined
  (`Injury Report:`, `Detailed Summary`, `Patient History`).
- **Highlight color:** yellow highlight on "case significant details" per
  the Usage Guidelines ("Case significant details have been highlighted in
  yellow color." is in some cases' instructions).
- **Comment color:** red text, italic style for reviewer comments.
- **Tables:** simple tab-separated cells rendered as Word tables with
  1-point borders, grey header row shading.

---

## 5. File D — Delivery Note (.docx)

**AI-assisted template.** The lightest file of the four (typically 2-5 KB).

### 5.1 Master template

```
Delivery Note - {PatientName}

Dear {ContactFirstName},

We have completed the medical records review for {PatientName} and prepared
the medical chronology.

As a free service, we have prepared {the} hyperlinked medical records for
ease of navigation to refer the source document{s}.

Medical chronology:

Date of injury: {DOI}                                       ← single DOI
Dates of injuries: {DOI1} & {DOI2}                          ← two DOIs
Date of injuries: {DOI1} and {DOI2}                         ← two DOIs alt

Case focus details:                                         ← most common
Case-overview:                                              ← Stidam style

{AI-generated 1-3 paragraph case summary covering:
 - Mechanism of injury (restraint, speed, airbag, LOC)
 - Diagnoses list (verbatim)
 - Treatment journey (therapies with date ranges)
 - Current status / last visit summary}

{Optional sections, included only when present in source records:
    Causation:
    DD/MM/YYYY: {provider} opined that… {statement}.

    Disability:
    DD/MM/YYYY: {disability classification} {scores if any}.
}

Missing medical records:                                    ← or "Missing Medical Records:"
[if none]  There are no critical missing medical records.
[if some]  {5-col table:
    Date/Period | Provider/Facility | What records are needed |
    Confirmatory/Probable | Statement regarding missing records | PDF Reference }

Please retrieve us the missing medical records, upon which we will revise
the medical chronology.                                     ← optional leading *

Merged Medical Records:

For ease of reference, we have merged all the medical records together in
the order of receipt and have captured the {page|PDF page} number as reference
in the chronology. Kindly refer to the page numbers of the merged medical
records at the left lower corner when referring to details in the chronology.

Hyperlinked Medical Records:

Place the hand symbol on the page reference and click the page number to
refer the corresponding source document.

Use Adobe Reader/Adobe Acrobat to navigate the page view.

Keyboard shortcuts for going back and forward: Alt+ Left Arrow or
Alt+ Right Arrow, respectively

We will be happy to make any modifications if needed.

Please feel free to reach us if you need any further assistance with the
files and kindly acknowledge the receipt of the files. Thanks!

*****
```

### 5.2 Template variables (7)

| Placeholder | Source |
|---|---|
| `{PatientName}` | from request metadata |
| `{ContactFirstName}` | from case intake ("Marc" most cases, "Annie" for Westling) |
| `{DOI}` / multi-DOI | from chronology injury report |
| `{Case focus narrative}` | AI — Claude/Gemini summarization of chronology |
| `{Causation statements}` | AI — extract any causation-language sentences |
| `{Disability statements}` | AI — extract dated disability statements |
| `{Missing records table}` | AI — diff of expected vs received provider records |

### 5.3 Allowed variants (observed, accept on input, normalize on output)

- "Case focus details" / "Case-overview" / "Case focus details: Patient"
- "Missing medical records" / "Missing Medical Records"
- Leading asterisk on "*Please retrieve…" (sometimes present, sometimes not)
- "page" vs "PDF page" number in Merged Records paragraph
- Double blank line vs single between sections (formatting drift)

Standardize to the most common form when producing new files.

---

## 6. Implementation plan (maps to `pipeline/`)

| File | Module | Status |
|---|---|---|
| Merged Records .pdf | `pipeline/stage5_merge.py` (new) | TODO |
| Medical Chronology .doc | `pipeline/stage5_chronology_docx.py` (rewrite of `format_chronology.js`) | TODO — biggest lift |
| Delivery Note .docx | `pipeline/stage5_delivery_note.py` (new) | TODO |
| Hyperlinked Records .pdf | `pipeline/stage5_hyperlink.py` | ✅ Built + validated (99.2% recall vs Hatcher) |

**Dependency order for a full pipeline run:**

1. AI stages 1–4 run as today (extraction → chronology JSON → narrative → audit)
2. `stage5_merge` — build Merged Records PDF + bookmarks from source files
3. `stage5_chronology_docx` — render chronology JSON to MedSum-format `.docx`
4. `stage5_delivery_note` — render Delivery Note from chronology + AI summaries
5. `stage5_hyperlink` — combine (3) + (2) → Hyperlinked Records PDF

### 6.1 Key unknowns requiring user decision

1. **Receipt-order vs alphabetical** for merging. Propose: alphabetical default, accept optional `receipt_manifest.csv` override.
2. **Chronology file extension** — MedSum uses `.doc`, python-docx and UNC's `format_chronology.js` produce `.docx`. Downstream UNC pipeline accepts both. Propose: `.docx`.
3. **Yellow highlighting of "case significant details."** Requires AI to mark sentences as significant. Propose: optional v2 feature.
4. **Contact first name** ("Marc" / "Annie") — per-firm constant, should come from case intake metadata, not AI.

---

## 7. Validation strategy

**Ground truth cases:** Hatcher, Lutes, Peterson — we have both the MedSum 4-file deliverable AND the UNC Expert Evaluation output.

**Per-file validation metrics:**

| File | Metric |
|---|---|
| Merged Records | `file_size`, `len(doc)`, `len(doc.get_toc())`, per-source page-range match |
| Medical Chronology | Section presence (8 section markers), Injury-Report table shape, Detailed-Summary row count vs encounter count, PDF-ref coverage |
| Delivery Note | 13 required paragraphs present, Missing-Records table shape matches, closing `*****` present |
| Hyperlinked Records | `len(doc)` == `chron_pages + records_pages`, link recall vs MedSum, zero external links, all targets in range |

Bar to clear: ≥95% structural match + ≥90% textual recall on each of the 4 files before replacing MedSum in production.

---

## 8. Source data for this spec

- `/14 UNC/Expert Evaluation Cases/{patient}/Final Files/*` — 24 MedSum files (6 patients × 4 files)
- `/14 UNC/{Lutes,Hatcher}/Final Files/*` — 8 additional MedSum files
- `/14 UNC/Code/pipeline/stage5_hyperlink.py` — the only implementation we have so far
- `/tmp/medsum_corpus/` — text conversions of all 12 Delivery Notes + Chronologies used for this analysis

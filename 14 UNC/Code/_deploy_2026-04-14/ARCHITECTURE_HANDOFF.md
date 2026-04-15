# UNC Medical AI Reviewer — Architecture & Handoff Guide

**As of:** 2026-04-15
**Scope:** End-to-end MedSum replacement for Dr. Syed Asad's Universal Neurology Care practice (Jacksonville FL). Input = a case folder of raw provider PDFs/DOCs/images, output = MedSum's exact 4-file deliverable.

**Diagram:** [FigJam / Mermaid](https://www.figma.com/online-whiteboard/create-diagram/ab737b22-a8a7-4a85-89d4-0b262e761d43) (editable, importable into Lucid via Mermaid paste).

---

## 1. One-paragraph summary

Take a folder of raw provider source files (PDF, DOC/DOCX, images) → concatenate into a single merged PDF with structured bookmarks → extract text (local + AWS Textract OCR) → feed to Claude Sonnet 4 in 180K-char chunks with an AI-to-ChronologyDoc-JSON prompt → merge partial results → render 4 MedSum-format output files (Delivery Note .docx, Medical Chronology .docx, Merged Records .pdf, Hyperlinked Records .pdf). One command end-to-end. ~5–15 min per 2,000-page case. ~$2–5 per case in Claude API costs vs MedSum's $475–$750.

---

## 2. Pipeline flow

```
                Case folder
                     │
                     ▼
      Stage 5a — MERGE source files
         (alphabetical or --manifest)
                     │
                     ▼
      ┌──────── Merged Records .pdf ────────┐
      │           2,313 pg, 469 bm          │
      │                                     │
      ▼                                     │
  Stage 1 — EXTRACT text                    │
   PyMuPDF + AWS Textract (OCR)             │
   ~5.5M chars typical                      │
      │                                     │
      ▼                                     │
  Stage 2 — AI CHRONOLOGY                   │
   Claude Sonnet 4, 3 concurrent            │
   ~180K chars/chunk, 24–64K out            │
   emits ChronologyDoc JSON                 │
      │                                     │
      ▼                                     │
  ┌───┴───┬───────────────┬─────────────┐   │
  ▼       ▼               ▼             ▼   │
 5b       5c              5d────────────┤   │
 Chron    Delivery         Hyperlinker  │   │
 .docx    Note .docx       (needs both) │   │
                                        ▼   ▼
                             Hyperlinked Records .pdf
```

---

## 3. Stage-by-stage reference

### Stage 5a — Merged Medical Records

| | |
|---|---|
| Module | `pipeline/stage5_merge.py` |
| Input | `Source Files/` directory |
| Output | `Merged Medical Records - {Name}.pdf` |
| AI? | No |
| Runtime | ~1-5 seconds for small cases; 2-5 min save time for 2,000+ pages |
| Dependencies | PyMuPDF, PIL, LibreOffice (for .doc/.docx sources) |

**What it does:**

1. Discovers all supported source files (`.pdf/.doc/.docx/.rtf/.jpg/.jpeg/.png/.tif/.tiff/.heic/.bmp/.webp/.gif`).
2. Sorts alphabetically by filename (or by `receipt_manifest.csv` if provided).
3. Converts non-PDFs to PDF (LibreOffice headless for office docs, PIL for images).
4. Concatenates via `fitz.insert_pdf()`.
5. Emits bookmarks: **L1 = `{filename}.pdf (p.{start}-{end})`**; L2-L5 preserved from each source PDF's internal outline.
6. Saves with `garbage=1, deflate=False` for large docs (>500 pages) to avoid multi-minute save times.

**MedSum-parity validated:** 100% match on Alejandra Peterson (699 pages, 78 bookmarks, identical level histogram).

### Stage 1 — Text Extraction

| | |
|---|---|
| Module | `pipeline/extractor.py` |
| Input | Merged Records PDF |
| Output | Extracted text (cached to `extracted_text.txt` in output dir) |
| AI? | No, but uses AWS Textract |
| Runtime | 1-12 min depending on scanned-page ratio |
| Dependencies | PyMuPDF, boto3 (AWS Textract), credentials in `~/.aws/credentials` |

**What it does:**

- **Pass 1** (fast): PyMuPDF text extraction across all pages. Pages with < 500 characters are flagged as "scanned".
- **Pass 2** (slow): AWS Textract OCR on flagged pages, 8 workers in parallel.
- Jon Witting example: 2,313 total pages, 383 scanned, ~5.5M chars in 12 min.
- OCR failures (InvalidParameterException on weird images) are logged and skipped.

**Cache:** After first successful extraction, text is saved to `{case-dir}/{output-dir}/extracted_text.txt`. Subsequent runs auto-reuse this and skip Stage 1 entirely.

### Stage 2 — AI Chronology (the expensive step)

| | |
|---|---|
| Module | `pipeline/stage2_medsum_chronology.py` + `prompts/medsum_chronology_system.txt` |
| Input | Extracted text + patient metadata |
| Output | `chronology_doc.json` (ChronologyDoc schema, ~1 MB typical) |
| AI? | Claude Sonnet 4 (`claude-sonnet-4-20250514`) |
| Runtime | 3-30 min depending on text size |
| Cost | ~$2-5 per case |
| Dependencies | `anthropic` Python SDK, `ANTHROPIC_API_KEY` in `Code/.env` |

**What it does:**

1. Splits extracted text into ~180K-char chunks with 10K overlap.
2. Runs 3 concurrent Claude streams via `ThreadPoolExecutor`.
3. Each chunk gets the MedSum system prompt + chunked user prompt instructing it to emit only NEW encounters/records visible in that chunk (not duplicate static sections across chunks).
4. `max_tokens=24000` initially; auto-retry at 48K then 64K if truncated (`stop_reason=max_tokens` or JSON parse fails).
5. Uses `anthropic-beta: output-128k-2025-02-19` header for extended output.
6. Handles transient errors (overloaded_error HTTP 529, rate_limit HTTP 429) via `_retry_with_backoff` from `pipeline/chronology.py` (6 attempts, 30-240s backoff).
7. Merges partial ChronologyDocs: union of lists (diagnoses, missing_records), concat of encounters (then date-sorted), longest-text wins for patient-history lines.

**Schema:** see `pipeline/stage5_schema.py` for full dataclass structure. Top level: `{patient, general_instructions, injury_report, flow_of_events, patient_history, encounters, case_focus, causation_statements, disability_statements, missing_records, no_missing_records}`.

**Auto-resume:** if `chronology_doc.json` already exists in output dir, the orchestrator auto-skips Stage 1+2 and goes straight to Stage 5b.

### Stage 5b — Medical Chronology .docx

| | |
|---|---|
| Module | `pipeline/stage5_chronology_docx.py` |
| Input | `chronology_doc.json` |
| Output | `Medical Chronology - {Name}.docx` (~100-500 KB typical) |
| AI? | No (pure template) |
| Runtime | <1 second |
| Dependencies | `python-docx` |

**Structure** (7 sections identical across all MedSum cases observed):

1. Title + "Confidential and privileged information"
2. Usage Guidelines — 8 hardcoded boilerplate bullets
3. General Instructions — 3 patient-specific bullets
4. **Injury Report** — 2-col table (DESCRIPTION | DETAILS): Prior injury / Date / Description / Diagnoses / Treatments (sub-grouped by Medications/Procedures/Therapy/Imaging/Labs)
5. **Flow of Events** — date-range summaries grouped by provider, optional red-italic reviewer comments
6. **Patient History** — exactly 5 lines: Past Medical / Surgical / Family / Social / Allergy, each with `(PDF ref: X)` suffix
7. **Detailed Summary** — 4-col table: DATE | FACILITY/PROVIDER | MEDICAL EVENTS | PDF REF. Bolds known sub-headings (Chief complaint, HPI, Presentation, ROS, Vital signs, Physical exam, Differential, MDM, Assessment, Plan, etc.) inside each cell.

### Stage 5c — Delivery Note .docx

| | |
|---|---|
| Module | `pipeline/stage5_delivery_note.py` |
| Input | `chronology_doc.json` |
| Output | `Delivery Note - {Name}.docx` (~40 KB typical) |
| AI? | No (pure template) |
| Runtime | <1 second |
| Dependencies | `python-docx` |

**13-block structure** matching MedSum verbatim: Title → `Dear {ContactFirstName},` greeting → Intro paragraph → Free-service note → `Medical chronology:` header → DOI line (singular/plural auto-pick) → `Case focus details:` + AI narrative → optional Causation/Disability → `Missing medical records:` (6-col table or "There are no critical missing medical records.") → Merged Records boilerplate → Hyperlinked boilerplate → Closing + `*****`.

### Stage 5d — Hyperlinked Records

| | |
|---|---|
| Module | `pipeline/stage5_hyperlink.py` |
| Input | Medical Chronology .docx + Merged Records .pdf |
| Output | `Hyperlinked Medical Records - {Name}.pdf` |
| AI? | No |
| Runtime | 3-10 seconds |
| Dependencies | PyMuPDF, LibreOffice (for .docx → PDF step) |

**What it does:**

1. Converts chronology `.docx` → PDF via LibreOffice headless.
2. Appends merged records via `fitz.insert_pdf()`.
3. Detects every page-ref token in the chronology (two patterns: "PDF Ref: N" keyword + whole-line pure-digit cells in Detailed Summary table).
4. Inserts internal `LINK_GOTO` annotations pointing to `chronology_page_count + ref_page`.

**MedSum-parity validated:** 99.2% link recall on Nicholas Hatcher (127/128 links).

---

## 4. The orchestrator

```bash
python run_medsum_pipeline.py \
    --case-dir "/path/to/Patient PID 12345" \
    --name     "Patient Name" \
    --dob      "01/01/1970" \
    --doi      "01/31/2024" \
    --injury   "Brief case focus description" \
    [--manifest receipt_manifest.csv]     # optional Stage 5a ordering
    [--chronology-json existing.json]     # skip Stage 1+2 explicitly
    [--contact "Marc"]                    # Delivery Note greeting
    [--output-dir "AI Pipeline Output"]   # relative to --case-dir
```

**Smart resume behavior** (added 2026-04-15):

| File already exists in output dir? | Behavior |
|---|---|
| `Merged Medical Records - {Name}.pdf` | Skip Stage 5a |
| `extracted_text.txt` | Skip Stage 1 |
| `chronology_doc.json` | Skip Stages 1 + 2 |

Delete any of these to force re-generation.

---

## 5. Data model: ChronologyDoc JSON

Full dataclasses in `pipeline/stage5_schema.py`. Top-level shape:

```json
{
  "patient": {
    "name": "Jon Witting",
    "dob": "07/24/1980",
    "contact_first_name": "Marc"
  },
  "general_instructions": ["bullet 1", "bullet 2", "bullet 3"],
  "injury_report": {
    "prior_injury_details": ["..."],
    "dates_of_injury": ["03/08/2022", "02/11/2025"],
    "incident_type": "Motor Vehicle Accident",
    "description": "Patient was involved in...",
    "diagnoses": ["Cervical strain", "..."],
    "treatments": {
      "medications": [...], "procedures": [...],
      "therapy": [...], "imaging": [...], "labs": [...]
    }
  },
  "flow_of_events": [
    {"provider_group": "...", "date_range": "MM/DD/YYYY", "summary": "...", "reviewer_comment": null}
  ],
  "patient_history": {
    "past_medical": {"text": "...", "pdf_ref": "32"},
    "surgical":     {"text": "...", "pdf_ref": "32"},
    "family":       {"text": "...", "pdf_ref": "32"},
    "social":       {"text": "...", "pdf_ref": "32"},
    "allergy":      {"text": "...", "pdf_ref": "32"}
  },
  "encounters": [
    {
      "group_header": true,
      "group_header_text": "Facility / MM/DD/YYYY",
      "date": "MM/DD/YYYY",
      "facility": "Facility name",
      "providers": ["Provider, M.D.", "PA-C"],
      "medical_events": "Chief complaint: ...\nHPI: ...\nAssessment: ...\nPlan: ...",
      "pdf_ref": "184-195, 432-443"
    }
  ],
  "case_focus": "1-3 paragraph case summary for Delivery Note",
  "causation_statements": [{"date": "MM/DD/YYYY", "text": "..."}],
  "disability_statements": [{"date": "MM/DD/YYYY", "text": "..."}],
  "missing_records": [...],
  "no_missing_records": false
}
```

---

## 6. File layout

```
14 UNC/Code/
├── .env                         ← ANTHROPIC_API_KEY (gitignored)
├── .env.example
├── run_medsum_pipeline.py       ← orchestrator
├── config.py                    ← env loader
├── prompts/
│   ├── chronology_system.txt    ← old Stage 2 (legacy)
│   ├── narrative_system.txt     ← Stage 3 narrative (Expert Eval)
│   └── medsum_chronology_system.txt  ← new Stage 2 prompt
├── pipeline/
│   ├── extractor.py             ← Stage 1 (PyMuPDF + Textract)
│   ├── chronology.py            ← legacy Stage 2 + _retry_with_backoff
│   ├── stage2_medsum_chronology.py  ← new Stage 2 (MedSum-schema)
│   ├── stage5_schema.py         ← shared ChronologyDoc dataclasses
│   ├── stage5_merge.py          ← Stage 5a
│   ├── stage5_chronology_docx.py ← Stage 5b
│   ├── stage5_delivery_note.py  ← Stage 5c
│   ├── stage5_hyperlink.py      ← Stage 5d
│   ├── narrative.py             ← Stage 3 (Expert Evaluation, separate flow)
│   ├── audit.py                 ← Stage 4 (audit, separate flow)
│   └── date_audit.py
└── _deploy_2026-04-14/
    ├── ARCHITECTURE_HANDOFF.md  ← THIS FILE
    ├── MEDSUM_ALGORITHM_SPEC.md
    ├── MEDSUM_PIPELINE_COMPLETE_REPORT.md
    ├── STAGE5_*_REPORT.md       ← validation reports per module
    └── *.py / *.pdf             ← reference outputs + patches
```

---

## 7. Infrastructure & credentials

| Resource | Where |
|---|---|
| **Anthropic API key** | `Code/.env` local; also on EC2 `/opt/unc-api/.env` and Claude Managed Agent env `env_01GDukurB4FU5wmeU9ogVzDR` |
| **AWS creds** (Textract + Bedrock) | `~/.aws/credentials` on operator's Mac; also on EC2 |
| **EC2 FastAPI server** | `44.204.31.209:8000` (v8 — legacy, Stages 1+2 only; operated by Manus) |
| **Netlify frontend** | `unc-medical-ai-reviewer.netlify.app` (wraps old API) |
| **GitHub repo** | `gitdot5/unc-medical-ai-reviewer` (private) |
| **Claude Managed Agent** | `agent_011CZsdRncVgpP7vMCEkNdPb` — cloud runner with full env |

---

## 8. Operational playbook

### Fresh case — happy path

```bash
cd "/Users/gittran/Desktop/product-tracker/14 UNC/Code"
python3 run_medsum_pipeline.py \
    --case-dir "/path/to/Patient Name PID 12345" \
    --name "Patient Name" --doi "MM/DD/YYYY" --injury "summary"
```

Outputs land in `Patient Name PID 12345/AI Pipeline Output/`.

### Resume after failure

Just re-run the same command. The orchestrator auto-skips any stage whose output already exists. Delete specific cached files if you want to force re-generation.

### Regenerate only Stage 5 (formatting tweaks)

Edit `pipeline/stage5_*.py`, then re-run. It'll reuse the cached ChronologyDoc.

### Regenerate Stage 2 only (prompt tuning)

```bash
rm "/path/to/case/AI Pipeline Output/chronology_doc.json"
bash run_jon.sh
```

---

## 9. Known issues / gotchas

1. **`max_tokens` truncation** — Dense chunks sometimes exceed 24K output tokens. Mitigated by auto-retry at 48K/64K, but adds 5-10 min on rerun. If a case is massively dense, lower `chunk_size_chars` to 150K or smaller.
2. **OCR failures** — AWS Textract rejects some unusual images (InvalidParameterException). Logged as warnings; non-fatal. Usually 1-5% of scanned pages.
3. **HEIC images** — PIL's default install can't read .heic. Install `pillow-heif` if needed.
4. **LibreOffice save speed** — On 2,000+ page merged PDFs, `garbage=4, deflate=True` takes 5-10 min. Stage 5a auto-switches to `garbage=1, deflate=False` for docs >500 pages.
5. **`.doc` vs `.docx`** — MedSum ships `.doc` (Word 97-2003). We output `.docx`. Downstream UNC pipeline accepts either. If `.doc` is strictly required: `libreoffice --headless --convert-to doc output.docx`.
6. **EC2 multi-worker JOBS dict bug** — Legacy EC2 API has in-memory job state split across uvicorn workers. Jobs flap 404 on polls. Irrelevant to the new pipeline (no long-running server); fix only needed if we revive the EC2 API.
7. **Gmail 403** on GCP project 601407407584 — legacy EC2 email delivery broken. Irrelevant to the new pipeline; results are saved to disk.
8. **Python 3.14 deps** — `python-docx` needs `--break-system-packages` install on Python 3.14. `pillow-heif` not yet wheeled for 3.14.

---

## 10. Validation status

| Stage | Validation case | Result |
|---|---|---|
| 5a merge | Alejandra Peterson (699 pg) | **100% structural match** (page count, bookmark count, L1 titles, level histogram) |
| 5a merge | Mabelle Westling (332 pg) | Content identical (20/20 files); order via `--manifest` |
| 5d hyperlink | Nicholas Hatcher (885 pg) | **99.2% link recall** (127/128 MedSum links) |
| 5b chronology .docx | Peterson sample JSON | All 7 sections render; structure validated |
| 5c delivery note .docx | Peterson sample JSON | All 13 blocks render; structure validated |
| Full pipeline end-to-end | **Jon Witting (2,313 pg, 5.5M chars)** | **Stage 2 emitted ChronologyDoc with many encounters; all 3 non-hyperlink files produced; 4th pending LibreOffice install** |

---

## 11. Economics

| | MedSum | This pipeline |
|---|---|---|
| Cost per case | $475-$750 | ~$2-5 Claude API |
| Turnaround | 24+ hours | 5-15 min |
| Scale factor | baseline | ~200× faster, ~150× cheaper |

---

## 12. Handoff checklist

New operator must:

1. **Clone:** `git clone git@github.com:gitdot5/unc-medical-ai-reviewer.git`
2. **Install deps:** `pip3 install --break-system-packages -r requirements.txt python-docx pillow`
3. **Add API key:** `echo 'ANTHROPIC_API_KEY=sk-ant-…' > Code/.env`
4. **Configure AWS:** `aws configure` (needs Textract + optionally Bedrock access in us-east-1)
5. **Install LibreOffice:** `brew install --cask libreoffice` (needed for .doc source files + Stage 5d)
6. **Test:** run the smoke test in `_deploy_2026-04-14/ARCHITECTURE_HANDOFF.md` §8
7. **Read:**
   - `_deploy_2026-04-14/MEDSUM_ALGORITHM_SPEC.md` for reverse-engineered MedSum conventions
   - `_deploy_2026-04-14/MEDSUM_PIPELINE_COMPLETE_REPORT.md` for implementation details
   - `/Users/gittran/Desktop/product-tracker/14 UNC/CLAUDE.md` + `memory/` for project context
8. **Notion hub:** [UNC Medical AI Reviewer — Project Tracker](https://www.notion.so/33c557697c0a813e8518d7f8bb10af89)

---

## 13. Owner context

- **Project owner:** Git Tran (git@weekthink.com), WeekThink LLC
- **End customer:** Dr. Syed Asad, M.D. — Universal Neurology Care, Jacksonville FL
- **BAA signed:** 03/30/2026 (UNC × WeekThink)
- **Co-maintainer:** Manus AI — SSH access to EC2, prompt tuning focus

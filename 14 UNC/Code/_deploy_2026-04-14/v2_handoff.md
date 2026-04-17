# UNC Pipeline v2 Handoff — 2026-04-17

## What Was Done This Session

### v2 Changes Made (3 files edited)

**1. `Code/pipeline/stage2_medsum_chronology.py`** — Smaller chunks to prevent max_tokens truncation
- `chunk_size_chars`: 180,000 → **120,000**
- `chunk_overlap_chars`: 10,000 → **8,000**
- Result: Zero chunk failures across all v2 runs (v1 had 5/36 failed chunks)

**2. `Code/prompts/medsum_chronology_system.txt`** — Three prompt additions
- **Rule 4**: Added specific encounter count targets per page count (300pg→15-25, 700pg→25-40, etc.)
- **Rule 4e**: Added strict per-encounter-type word limits (office visit 50-150w, ER 150-300w, admission 200-400w) + OMIT list (negative ROS, vitals, normal labs, boilerplate, etc.)
- **Rule 4e-bis**: Added facility name normalization instruction

**3. `Code/pipeline/stage5_chronology_docx.py`** — Compacted formatting
- `BODY_SIZE`: Pt(11) → **Pt(9.5)**
- `TITLE_SIZE`: Pt(14) → **Pt(12)**
- `SECTION_SIZE`: Pt(12) → **Pt(10.5)**
- Margins: default → **1.27cm all sides**
- Paragraph spacing: default → **0pt before, 2pt after**
- Cell paragraph spacing: **0pt before, 1pt after**
- Column widths: `[2.5, 4.0, 11.0, 2.5]` → **`[2.2, 3.5, 12.0, 2.0]`cm**

## v2 Blind Test Results (2 of 4 complete)

### Westling (332pg) — ✅ Major improvement
| Metric | v1 | v2 | Target |
|--------|----|----|--------|
| Merged Pages | 332/332 ✅ | 332/332 ✅ | Match |
| Chrono Length Ratio | 1.46x | **1.31x** | 1.0x |
| Chrono Pages | 158 | **73** | 61 (MedSum) |
| Encounters (date-lines) | 72 vs 10 | 76 vs 49* | Match |
| Diagnosis Recall | 88.4% | 88.4% | ≥95% |
| Patient History | 0-26% | 0-15% | ≥80% |
| Chunk Failures | 0/5 | **0/11** | 0 |

*Westling hyperlink/delivery metrics INVALID — MedSum originals were accidentally overwritten because `--output-dir` wasn't specified (see Known Issue below)

### Hatcher (818pg) — Mixed results
| Metric | v1 | v2 | Target |
|--------|----|----|--------|
| Merged Pages | 818/818 ✅ | 818/818 ✅ | Match |
| Hyperlinked Pages | 1063 vs 885 | **954 vs 885** | Match |
| Chrono Length Ratio | 1.76x | **1.76x** (no change) | 1.0x |
| Encounters (date-lines) | 126 vs 81 | **183 vs 81** (worse) | Match |
| Diagnosis Recall | 0.0%* | 0.0%* | ≥95% |
| Case Focus Recall | 22.3% | **14.9%** (worse) | ≥80% |
| Patient History | 6-36% | 3-75% | ≥80% |
| Chunk Failures | 0/7 | **0/10** | 0 |

*Hatcher 0% diagnosis recall is a diff regex measurement bug, not actual failure

### Peterson (699pg) — ✅ Complete
| Metric | v1 | v2 | Target |
|--------|----|----|--------|
| Merged Pages | 699/699 ✅ | 699/699 ✅ | Match |
| Hyperlinked Pages | 943 vs 794 | **869 vs 794** | Match |
| Chrono Length Ratio | 1.20x | **1.60x** (worse) | 1.0x |
| Encounters (date-lines) | 136 vs 74 | **165 vs 74** (worse) | Match |
| Diagnosis Recall | 90.8% | **94.7%** ✅ | ≥95% |
| Case Focus Recall | 48.9% | **39.4%** (worse) | ≥80% |
| Patient History | 0-39% | 0-17% | ≥80% |
| Chunk Failures | 2/8 | **0/12** ✅ | 0 |

### Stidam (1385pg) — Not yet started
- Command to run:
```bash
cd "/Users/gittran/Desktop/product-tracker/14 UNC/Code" && \
nohup python3 run_medsum_pipeline.py \
  --case-dir "../Expert Evaluation Cases/Marisa Stidam" \
  --name "Marisa Stidam" \
  --doi "01/31/2024" \
  --injury "MVA rear-ended by tractor trailer" \
  --contact "Marc" \
  --output-dir "AI Pipeline Output" \
  --backend bedrock \
  --model "us.anthropic.claude-sonnet-4-6" \
  > "../Expert Evaluation Cases/Marisa Stidam/AI Pipeline Output/pipeline_v2.log" 2>&1 &
```

## Known Issues

### 1. Westling MedSum originals overwritten
The first run (Westling) used default `--output-dir "Final Files"` which overwrote MedSum's Delivery Note .docx and Hyperlinked PDF in that directory. The MedSum `.doc` chronology and Merged PDF are intact (different filenames/extensions). All subsequent runs use `--output-dir "AI Pipeline Output"`.

### 2. Pipeline default output dir
`run_medsum_pipeline.py` defaults to `--output-dir "Final Files"`. ALWAYS specify `--output-dir "AI Pipeline Output"` to avoid overwriting MedSum ground truth.

### 3. Diff measurement bugs
- `diff_vs_medsum.py` encounter counting uses regex `^\s*(\d{1,2}/\d{1,2}/\d{4})` which counts ALL date-prefixed lines, inflating both sides
- Hatcher 0% diagnosis recall is a regex mismatch (MedSum section header format differs)
- Fix: line ~279 in diff_vs_medsum.py, section header regex

## What Still Needs Work (Ranked)

### Priority 1: Encounter over-splitting (Hatcher 183 vs 81)
The v2 prompt tells the model to group aggressively but Hatcher chunk 1 alone produced 30 encounters. The model isn't collapsing recurring therapy visits. Need:
- Stronger few-shot examples in prompt showing therapy collapsing
- Consider a post-processing merge step that combines same-facility encounters within 7-day windows
- Hatcher has many facility name variants (5+ names for same hospital) — the 4e-bis normalization rule isn't being followed

### Priority 2: Chronology still 1.3-1.8x too long
The word limits in Rule 4e are being partially ignored. Options:
- Add a hard character limit per encounter in the prompt (e.g., "NEVER exceed 500 characters")
- Post-processing truncation of medical_events text
- Switch to a two-pass approach: generate encounters first, then summarize each

### Priority 3: Patient history (3-75% Jaccard)
We extract patient history from whatever encounter mentions it first. MedSum picks specific encounters. Options:
- Add a dedicated patient history extraction pass that scans ALL encounters
- Use the most detailed/comprehensive version found across all chunks

### Priority 4: Case focus wording (15-100%)
MedSum uses a very specific formulaic template. Options:
- Extract 2-3 MedSum case focus examples and add to prompt as few-shot
- Template the structure: "On {DOI}, {patient} was involved in {incident}. {diagnoses}. {treatments}. {current status}."

### Priority 5: Fix diff measurement
- Diagnosis regex for Hatcher
- Encounter counting methodology (use JSON encounter count, not date-line count)

## Files Modified This Session
```
Code/pipeline/stage2_medsum_chronology.py    — chunk sizing
Code/prompts/medsum_chronology_system.txt    — Rules 4, 4e, 4e-bis
Code/pipeline/stage5_chronology_docx.py      — compact formatting
```

## Output Locations
```
Westling v2:  Expert Evaluation Cases/Mabelle Westling/AI Pipeline Output/
              (also in Final Files/ — overwrote MedSum originals)
Hatcher v2:   Nicholas Hatcher PID 22506/AI Pipeline Output/
Peterson v2:  Expert Evaluation Cases/Alejandra Peterson/AI Pipeline Output/ (running)
Stidam v2:    Not started yet
```

## Diff Command Template
```bash
cd "/Users/gittran/Desktop/product-tracker/14 UNC/Code" && \
python3 -m pipeline.diff_vs_medsum \
  --patient-name "{NAME}" \
  --ours-dir "{CASE_DIR}/AI Pipeline Output" \
  --medsum-dir "{CASE_DIR}/Final Files"
```

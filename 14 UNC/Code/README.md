# UNC Medical AI Reviewer

End-to-end pipeline that replaces MedSum (medical-chronology service, $475-$750/case) with an automated AI workflow for Dr. Syed Asad's Universal Neurology Care practice (Jacksonville FL). One command in → MedSum's exact 4-file deliverable out, in 5-15 min, ~$2-5 in Claude API cost per case.

## Quick start

```bash
# 1. Install deps (Python 3.13 or 3.14)
pip3 install --break-system-packages -r requirements.txt python-docx pillow

# 2. Add API keys
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
aws configure  # Textract access in us-east-1

# 3. (macOS) Install LibreOffice for .doc input conversion + Stage 5d PDF render
brew install --cask libreoffice

# 4. Run end-to-end on a case folder
python3 run_medsum_pipeline.py \
    --case-dir "/path/to/Patient Name PID 12345" \
    --name     "Patient Name" \
    --dob      "MM/DD/YYYY" \
    --doi      "MM/DD/YYYY" \
    --injury   "Brief case focus description"
```

Outputs land in `{case-dir}/AI Pipeline Output/`:

```
AI Pipeline Output/
├── Delivery Note - Patient Name.docx
├── Medical Chronology - Patient Name.docx
├── Merged Medical Records - Patient Name.pdf
├── Hyperlinked Medical Records - Patient Name.pdf
├── chronology_doc.json          ← cached AI output, reusable
└── extracted_text.txt           ← cached OCR output, reusable
```

**Smart resume:** if any cached file exists in the output folder, the orchestrator auto-skips that stage. Delete a file to force re-generation.

## Architecture

```
Source Files/
   │
   ▼
Stage 5a: MERGE  ────────►  Merged Records .pdf
   │                              │
   ▼                              │
Stage 1: EXTRACT                  │
   (PyMuPDF + AWS Textract OCR)   │
   │                              │
   ▼                              │
Stage 2: AI CHRONOLOGY            │
   (Claude Sonnet 4, chunked)     │
   │                              │
   ▼                              │
ChronologyDoc JSON                │
   │                              │
   ├──► Stage 5b: Chronology .docx
   ├──► Stage 5c: Delivery Note .docx
   └──► Stage 5d: Hyperlinker ────┘ (needs chronology + merged)
                    │
                    ▼
              Hyperlinked Records .pdf
```

**Full architecture & handoff:** [`_deploy_2026-04-14/ARCHITECTURE_HANDOFF.md`](_deploy_2026-04-14/ARCHITECTURE_HANDOFF.md) — start here if you're new.

**MedSum algorithm spec (reverse-engineered):** [`_deploy_2026-04-14/MEDSUM_ALGORITHM_SPEC.md`](_deploy_2026-04-14/MEDSUM_ALGORITHM_SPEC.md)

**Pipeline build report:** [`_deploy_2026-04-14/MEDSUM_PIPELINE_COMPLETE_REPORT.md`](_deploy_2026-04-14/MEDSUM_PIPELINE_COMPLETE_REPORT.md)

## Repository layout

```
Code/
├── README.md                        ← this file
├── run_medsum_pipeline.py           ← orchestrator (single entry point)
├── config.py                        ← env loader (python-dotenv)
├── requirements.txt
├── .env.example                     ← copy to .env and fill in
├── prompts/
│   ├── medsum_chronology_system.txt ← Stage 2 system prompt (the critical one)
│   ├── chronology_system.txt        ← legacy Stage 2 (non-MedSum format)
│   └── narrative_system.txt         ← Stage 3 (Expert Evaluation, separate flow)
├── pipeline/
│   ├── extractor.py                 ← Stage 1 — PyMuPDF + Textract
│   ├── stage2_medsum_chronology.py  ← Stage 2 — MedSum-schema chronology
│   ├── chronology.py                ← legacy Stage 2 + _retry_with_backoff
│   ├── stage5_schema.py             ← shared ChronologyDoc dataclasses
│   ├── stage5_merge.py              ← Stage 5a — Merged Records PDF + bookmarks
│   ├── stage5_chronology_docx.py    ← Stage 5b — Medical Chronology .docx
│   ├── stage5_delivery_note.py      ← Stage 5c — Delivery Note .docx
│   ├── stage5_hyperlink.py          ← Stage 5d — Hyperlinked Records PDF
│   ├── narrative.py                 ← Stage 3 (Expert Evaluation, separate)
│   ├── audit.py                     ← Stage 4 (audit, separate)
│   ├── date_audit.py
│   ├── helpers.py
│   └── notion_logger.py
├── _deploy_2026-04-14/              ← deployment artifacts + reports
│   ├── ARCHITECTURE_HANDOFF.md      ← comprehensive handoff guide
│   ├── MEDSUM_ALGORITHM_SPEC.md
│   ├── MEDSUM_PIPELINE_COMPLETE_REPORT.md
│   ├── STAGE5_HYPERLINK_REPORT.md
│   ├── STAGE5_MERGE_REPORT.md
│   ├── STAGE5_DOCX_PRODUCERS_REPORT.md
│   └── peterson_sample.json         ← test input for schema validation
└── api_server.py                    ← legacy FastAPI (v5/v8 on EC2, Stages 1+2 only)
```

## Validation status

| Stage | Validation case | Result |
|---|---|---|
| 5a merge | Alejandra Peterson (699 pg) | **100% structural match** to MedSum |
| 5a merge | Mabelle Westling (332 pg) | Content identical (20/20 files); order via `--manifest` |
| 5d hyperlink | Nicholas Hatcher (885 pg) | **99.2% link recall** (127/128 vs MedSum) |
| 5b chronology .docx | Peterson sample JSON | All 7 sections render correctly |
| 5c delivery note .docx | Peterson sample JSON | All 13 blocks render correctly |
| Full pipeline | **Jon Witting (2,313 pg, 5.5M chars)** | End-to-end validated; 3/4 files produced on first run |

## Economics

| | MedSum | This pipeline |
|---|---|---|
| Cost per case | $475-$750 | ~$2-5 (Claude API) |
| Turnaround | 24+ hours | 5-15 min |
| Scale factor | baseline | ~200× faster, ~150× cheaper |

## Key project links

- **Notion hub:** [UNC Medical AI Reviewer — Project Tracker](https://www.notion.so/33c557697c0a813e8518d7f8bb10af89)
- **Architecture doc (Notion):** [Architecture & Handoff Guide](https://www.notion.so/343557697c0a81b59e98db43b8c5df98)
- **Algorithm spec (Notion):** [MedSum Full-Algorithm Reverse-Engineering Spec](https://www.notion.so/342557697c0a810f8780cbd44a9bdb44)
- **Live pipeline diagram:** [FigJam / Mermaid (editable)](https://www.figma.com/online-whiteboard/create-diagram/ab737b22-a8a7-4a85-89d4-0b262e761d43)

## Owner / Contact

- **Project owner:** Git Tran (git@weekthink.com) — WeekThink LLC
- **End customer:** Dr. Syed Asad, M.D. — Universal Neurology Care, Jacksonville FL
- **BAA signed:** 03/30/2026 (UNC × WeekThink)
- **Co-maintainer:** Manus AI (SSH to EC2 for legacy API + prompt tuning)

## License

Proprietary. Internal use only under BAA with Universal Neurology Care, P.A.

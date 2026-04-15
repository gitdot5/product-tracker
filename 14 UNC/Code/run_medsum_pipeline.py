#!/usr/bin/env python3
"""
End-to-end MedSum replacement pipeline.

Runs all 6 stages against a case folder and emits the complete 4-file MedSum
deliverable (Delivery Note + Medical Chronology + Merged Records +
Hyperlinked Records) into a `Final Files/` subdirectory.

    Stage 1  — PDF extraction (PyMuPDF / Textract)          [existing]
    Stage 2  — MedSum-schema chronology via Claude          [stage2_medsum_chronology]
    Stage 5a — Merged Records PDF + bookmarks                [stage5_merge]
    Stage 5b — Medical Chronology .docx                      [stage5_chronology_docx]
    Stage 5c — Delivery Note .docx                           [stage5_delivery_note]
    Stage 5d — Hyperlinked Records PDF                       [stage5_hyperlink]

Usage:
    python run_medsum_pipeline.py \\
        --case-dir "/path/to/Patient PID 12345" \\
        --name    "Patient Name" \\
        --dob     "01/01/1970" \\
        --doi     "01/31/2024" \\
        --injury  "Brief case focus description"            \\
        [--output-dir "Final Files"]                        \\
        [--contact "Marc"]                                  \\
        [--skip-stage2]    # use existing chronology.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Auto-load .env so ANTHROPIC_API_KEY and other creds are available to
# every stage without the caller having to export them manually.
try:
    from dotenv import load_dotenv
    _env = Path(__file__).resolve().parent / ".env"
    if _env.exists():
        load_dotenv(_env, override=False)
    else:
        load_dotenv(override=False)
except ImportError:
    pass


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("medsum_pipeline")

    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--case-dir", required=True,
                    help="Case folder containing Source Files/ and (optionally) Final Files/")
    ap.add_argument("--name", required=True)
    ap.add_argument("--dob", default="")
    ap.add_argument("--doi", default="")
    ap.add_argument("--injury", default="")
    ap.add_argument("--contact", default="Marc")
    ap.add_argument("--output-dir", default="Final Files",
                    help="Relative to --case-dir (default: 'Final Files')")
    ap.add_argument("--manifest", default=None,
                    help="Optional receipt_manifest.csv for Stage 5a")
    ap.add_argument("--chronology-json", default=None,
                    help="Skip Stage 1+2, load this ChronologyDoc JSON instead")
    ap.add_argument("--backend", default="anthropic", choices=["anthropic", "bedrock"],
                    help="Stage 2 inference backend. 'bedrock' gives HIPAA-eligible "
                         "Opus 4.6 access at ~5x cost (~$15-20/case vs ~$2-5).")
    ap.add_argument("--model", default=None,
                    help="Stage 2 model ID. Auto-defaults per backend.")
    ap.add_argument("--aws-region", default="us-east-1")
    ap.add_argument("--api-key", default=None)
    ap.add_argument("--audit", action="store_true",
                    help="Run Stage 4 audit (Layer 1 structure + Layer 2 anchoring). "
                         "Writes audit_report.json + audit_report.md to output dir.")
    ap.add_argument("--audit-deep", action="store_true",
                    help="Also run Layer 3 AI verbatim check (slower + costs ~$1-3). "
                         "Implies --audit.")
    args = ap.parse_args()
    if args.audit_deep:
        args.audit = True

    case_dir = Path(args.case_dir).resolve()
    source_dir = case_dir / "Source Files"
    out_dir = case_dir / args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    if not source_dir.exists():
        log.error("No Source Files/ directory in %s", case_dir)
        return 2

    patient_info = {
        "name": args.name,
        "dob": args.dob,
        "doi": args.doi,
        "injury": args.injury,
        "contact_first_name": args.contact,
    }

    name_safe = args.name  # filenames match MedSum's 'First Last' form
    output_paths = {
        "merged":      out_dir / f"Merged Medical Records - {name_safe}.pdf",
        "chronology":  out_dir / f"Medical Chronology - {name_safe}.docx",
        "delivery":    out_dir / f"Delivery Note - {name_safe}.docx",
        "hyperlinked": out_dir / f"Hyperlinked Medical Records - {name_safe}.pdf",
    }

    # ── Stage 5a: Merged Records ───────────────────────────────────────────
    if output_paths["merged"].exists() and output_paths["merged"].stat().st_size > 0:
        log.info("▶ Skipping Stage 5a: reusing existing %s",
                 output_paths["merged"].name)
    else:
        log.info("▶ Stage 5a: Merged Records")
        from pipeline.stage5_merge import merge_records
        merge_res = merge_records(
            source_dir=source_dir,
            output_path=output_paths["merged"],
            manifest_csv=Path(args.manifest) if args.manifest else None,
        )
        log.info("  → %d pages, %d bookmarks",
                 merge_res.total_pages, merge_res.total_bookmarks)

    # ── Stage 1+2: Extract + MedSum ChronologyDoc ──────────────────────────
    extracted_txt_path = out_dir / "extracted_text.txt"
    cached_chron_path = out_dir / "chronology_doc.json"

    # Auto-reuse cached ChronologyDoc JSON from prior run (avoids re-paying for Stage 2).
    if not args.chronology_json and cached_chron_path.exists() and cached_chron_path.stat().st_size > 0:
        args.chronology_json = str(cached_chron_path)
        log.info("▶ Auto-reusing cached ChronologyDoc: %s", cached_chron_path)

    if args.chronology_json:
        log.info("▶ Skipping Stage 1+2, loading %s", args.chronology_json)
        with open(args.chronology_json) as f:
            chronology_doc = json.load(f)
    else:
        extraction_stats_path = out_dir / "extraction_stats.json"
        if extracted_txt_path.exists() and extracted_txt_path.stat().st_size > 0:
            log.info("▶ Skipping Stage 1: reusing cached extracted_text.txt "
                     "(%d chars)", extracted_txt_path.stat().st_size)
            full_text = extracted_txt_path.read_text()
            extraction_stats = {}
            if extraction_stats_path.exists():
                with open(extraction_stats_path) as f:
                    extraction_stats = json.load(f)
        else:
            log.info("▶ Stage 1: Extracting text from merged records")
            from pipeline.extractor import extract_pdf_local, prepare_for_llm
            extraction = extract_pdf_local(str(output_paths["merged"]))
            full_text = prepare_for_llm(extraction)
            log.info("  → %d chars from %d pages",
                     len(full_text), extraction.total_pages)
            # ── OCR recall check ──
            # Verify we got text from every merged-PDF page; flag silent drops.
            import fitz
            merged_doc = fitz.open(str(output_paths["merged"]))
            merged_pg_count = len(merged_doc)
            merged_doc.close()
            if extraction.total_pages < merged_pg_count:
                log.warning("OCR recall: extraction reported %d pages but "
                            "merged PDF has %d pages — %d may have been "
                            "silently dropped",
                            extraction.total_pages, merged_pg_count,
                            merged_pg_count - extraction.total_pages)
            extracted_txt_path.write_text(full_text)
            extraction_stats = {
                "total_pages": getattr(extraction, "total_pages", merged_pg_count),
                "merged_pdf_pages": merged_pg_count,
                "extraction_chars": len(full_text),
                "ocr_pages_attempted": getattr(extraction, "ocr_attempted", 0),
                "ocr_pages_recovered": getattr(extraction, "ocr_recovered", 0),
                "ocr_pages_failed":    getattr(extraction, "ocr_failed", 0),
            }
            extraction_stats_path.write_text(json.dumps(extraction_stats, indent=2))
            log.info("  → cached to %s", extracted_txt_path)

        log.info("▶ Stage 2: MedSum-schema chronology (backend=%s, model=%s)",
                 args.backend, args.model or "<default>")
        from pipeline.stage2_medsum_chronology import generate_medsum_chronology
        # Checkpoint each chunk to disk as it lands — guarantees no API $ lost
        # to a later merge/save crash.
        chunk_ckpt_dir = out_dir / "chunks"
        chronology_doc = generate_medsum_chronology(
            full_text=full_text,
            patient_info=patient_info,
            api_key=args.api_key or os.getenv("ANTHROPIC_API_KEY"),
            backend=args.backend,
            model=args.model,
            aws_region=args.aws_region,
            chunk_checkpoint_dir=str(chunk_ckpt_dir),
        )
        # Fold extraction OCR stats into provenance so the full chain is auditable.
        if extraction_stats:
            chronology_doc.setdefault("provenance", {}).update({
                "extraction_total_pages": extraction_stats.get("total_pages", 0),
                "merged_pdf_pages":       extraction_stats.get("merged_pdf_pages", 0),
                "ocr_pages_attempted":    extraction_stats.get("ocr_pages_attempted", 0),
                "ocr_pages_recovered":    extraction_stats.get("ocr_pages_recovered", 0),
                "ocr_pages_failed":       extraction_stats.get("ocr_pages_failed", 0),
            })
        # Persist for rerunnability / debugging
        chronology_path = out_dir / "chronology_doc.json"
        with open(chronology_path, "w") as f:
            json.dump(chronology_doc, f, indent=2)
        log.info("  → %d encounters, cached to %s",
                 len(chronology_doc.get("encounters", [])), chronology_path)

    # Ensure patient metadata is set (AI may have partial info)
    chronology_doc.setdefault("patient", {})
    chronology_doc["patient"].setdefault("name", args.name)
    chronology_doc["patient"].setdefault("contact_first_name", args.contact)
    if args.dob:
        chronology_doc["patient"]["dob"] = args.dob

    # ── Stage 5b: Medical Chronology .docx ─────────────────────────────────
    log.info("▶ Stage 5b: Medical Chronology .docx")
    from pipeline.stage5_chronology_docx import build_chronology
    build_chronology(chronology_doc, output_paths["chronology"])

    # ── Stage 5c: Delivery Note .docx ──────────────────────────────────────
    log.info("▶ Stage 5c: Delivery Note .docx")
    from pipeline.stage5_delivery_note import build_delivery_note
    build_delivery_note(chronology_doc, output_paths["delivery"])

    # ── Stage 5d: Hyperlinked Records PDF ──────────────────────────────────
    log.info("▶ Stage 5d: Hyperlinked Records PDF")
    try:
        from pipeline.stage5_hyperlink import hyperlink_medical_records
        hyperlink_res = hyperlink_medical_records(
            chronology_path=str(output_paths["chronology"]),
            records_path=str(output_paths["merged"]),
            output_path=str(output_paths["hyperlinked"]),
        )
        log.info("  → %d total pages, %d links",
                 hyperlink_res.total_pages, hyperlink_res.link_count)
    except Exception as exc:
        log.warning("Stage 5d failed: %s — the other 3 files are still valid; "
                    "rerun once LibreOffice is installed.", exc)

    # ── Stage 4: Audit (optional) ──────────────────────────────────────────
    if args.audit:
        log.info("▶ Stage 4: Audit")
        from pipeline.stage4_audit import audit_chronology
        report = audit_chronology(
            chronology_path=str(out_dir / "chronology_doc.json"),
            records_path=str(output_paths["merged"]),
            output_dir=str(out_dir),
            deep=args.audit_deep,
            backend=args.backend,
            model=args.model,
            api_key=args.api_key or os.getenv("ANTHROPIC_API_KEY"),
            aws_region=args.aws_region,
        )
        log.info("  → audit score: %d/100 (critical=%d, warnings=%d)",
                 report.score, report.critical_count, report.warning_count)

    # ── Summary ────────────────────────────────────────────────────────────
    print()
    print("=" * 64)
    print(f"MedSum 4-file deliverable for {args.name}:")
    print("=" * 64)
    for key in ("merged", "chronology", "delivery", "hyperlinked"):
        p = output_paths[key]
        size_mb = p.stat().st_size / (1024 * 1024) if p.exists() else 0
        print(f"  {key:12s}  {size_mb:7.1f} MB  {p}")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

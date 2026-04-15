"""
Stage 5: MedSum-style Hyperlinked Medical Records.

Produces a single PDF that matches MedSum's "Hyperlinked Medical Records"
deliverable: chronology pages at the front, merged records after, with every
page reference in the chronology turned into a clickable GOTO link annotation
pointing to the referenced page in the merged records section.

Usage:
    python -m pipeline.stage5_hyperlink \\
        --chronology "Medical Chronology - Patient.doc" \\
        --records    "Merged Medical Records - Patient.pdf" \\
        --output     "Hyperlinked Medical Records - Patient.pdf"

Input chronology may be .pdf, .doc, or .docx. Non-PDF inputs are converted
with headless LibreOffice.

Notes
-----
- MedSum links single page numbers, not ranges. "27-32, 40" produces three
  separate link annotations on "27", "32", and "40".
- Links only span the exact bbox of the digit(s), matching the MedSum style
  confirmed in their deployed files (kind=LINK_GOTO, narrow rectangles).
- A candidate number becomes a link only if it lands in a "page-reference
  context": either after a "PDF Ref" / "PDF REF" / "PDF Reference" keyword
  on the same line, OR on a line whose entire content is page-ref-shaped
  (digits, commas, hyphens, whitespace only — i.e. the last column of the
  Detailed Summary table).
- Numbers outside [1, len(records)] are ignored so stray "5 mg" etc. don't
  leak through.
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from typing import List, Optional

import fitz  # PyMuPDF

log = logging.getLogger(__name__)


# ── Regex helpers ──────────────────────────────────────────────────────────

# Line contains a "PDF Ref" / "PDF REF" / "PDF Reference" keyword.
_KEYWORD_RE = re.compile(
    r"\bPDF\s*(?:REF(?:ERENCE)?|Ref(?:erence)?)\b\s*:?\s*",
    re.IGNORECASE,
)

# Line whose entire content is digits/commas/hyphens/whitespace (table cell).
_PAGEREF_ONLY_RE = re.compile(r"^[\s\d,\-]+$")

# Individual page-number token.
_NUM_RE = re.compile(r"\d+")


# ── Data model ─────────────────────────────────────────────────────────────

@dataclass
class HyperlinkResult:
    chronology_pages: int
    records_pages: int
    total_pages: int
    link_count: int
    output: str

    def as_dict(self) -> dict:
        return {
            "chronology_pages": self.chronology_pages,
            "records_pages": self.records_pages,
            "total_pages": self.total_pages,
            "link_count": self.link_count,
            "output": self.output,
        }


# ── Core helpers ───────────────────────────────────────────────────────────

def _ensure_pdf(path: str, workdir: str) -> str:
    """Return a PDF path; convert .doc/.docx via headless LibreOffice."""
    lower = path.lower()
    if lower.endswith(".pdf"):
        return path
    if not (lower.endswith(".doc") or lower.endswith(".docx")):
        raise ValueError(f"Unsupported chronology format: {path}")

    log.info("Converting %s -> PDF via LibreOffice…", os.path.basename(path))
    subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf",
         path, "--outdir", workdir],
        check=True, capture_output=True,
    )
    base = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(workdir, base + ".pdf")
    if not os.path.exists(out):
        raise RuntimeError(f"LibreOffice conversion produced no file at {out}")
    return out


def _line_text(line: dict) -> str:
    return "".join(span.get("text", "") for span in line.get("spans", []))


def _candidate_numbers(line_text: str) -> List[int]:
    """Return numbers from a line that look like page refs.

    - If the line contains a "PDF Ref"/"PDF REF" keyword, return all numbers
      after the keyword.
    - Else if the entire line is page-ref-shaped (digits/commas/hyphens/ws),
      return all numbers in the line.
    - Else return empty (skip).
    """
    m = _KEYWORD_RE.search(line_text)
    if m:
        tail = line_text[m.end():]
        return [int(n) for n in _NUM_RE.findall(tail)]

    stripped = line_text.strip()
    if stripped and _PAGEREF_ONLY_RE.match(stripped):
        return [int(n) for n in _NUM_RE.findall(stripped)]

    return []


def _link_number_in_line(
    page: fitz.Page,
    num_str: str,
    line_bbox: fitz.Rect,
) -> Optional[fitz.Rect]:
    """Find the first bbox for num_str within line_bbox, else None."""
    # Extend clip rightward slightly in case the number wraps to next line.
    clip = fitz.Rect(
        line_bbox.x0,
        line_bbox.y0 - 1,
        page.rect.x1,
        line_bbox.y1 + 1,
    )
    rects = page.search_for(num_str, clip=clip)
    if not rects:
        return None
    # Prefer the leftmost/topmost match inside the actual line.
    rects.sort(key=lambda r: (r.y0, r.x0))
    return rects[0]


# ── Public API ─────────────────────────────────────────────────────────────

def hyperlink_medical_records(
    chronology_path: str,
    records_path: str,
    output_path: str,
    *,
    min_ref: int = 1,
    max_ref: Optional[int] = None,
) -> HyperlinkResult:
    """Produce a MedSum-style Hyperlinked Medical Records PDF.

    Returns a HyperlinkResult with page + link counts.
    """
    workdir = tempfile.mkdtemp(prefix="hyperlink_")

    try:
        chron_pdf = _ensure_pdf(chronology_path, workdir)

        log.info("Opening chronology PDF: %s", chron_pdf)
        out = fitz.open(chron_pdf)
        chron_page_count = len(out)

        log.info("Opening merged records PDF: %s", records_path)
        records = fitz.open(records_path)
        records_page_count = len(records)

        log.info("Appending %d records pages after %d chronology pages…",
                 records_page_count, chron_page_count)
        out.insert_pdf(records)
        records.close()

        if max_ref is None:
            max_ref = records_page_count

        link_count = 0
        skipped_oor = 0  # out-of-range
        skipped_missing = 0  # search_for couldn't find the number

        for page_idx in range(chron_page_count):
            page = out[page_idx]
            text_dict = page.get_text("dict")
            for block in text_dict.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    text = _line_text(line)
                    nums = _candidate_numbers(text)
                    if not nums:
                        continue

                    line_bbox = fitz.Rect(line["bbox"])

                    for n in nums:
                        if n < min_ref or n > max_ref:
                            skipped_oor += 1
                            continue
                        num_str = str(n)
                        rect = _link_number_in_line(page, num_str, line_bbox)
                        if rect is None:
                            skipped_missing += 1
                            continue
                        target_page = chron_page_count + n - 1
                        page.insert_link({
                            "kind": fitz.LINK_GOTO,
                            "from": rect,
                            "page": target_page,
                        })
                        link_count += 1

        log.info("Links inserted: %d  (out-of-range skipped: %d, unmatched: %d)",
                 link_count, skipped_oor, skipped_missing)

        log.info("Saving combined PDF -> %s", output_path)
        out.save(output_path, garbage=4, deflate=True)
        out.close()

        return HyperlinkResult(
            chronology_pages=chron_page_count,
            records_pages=records_page_count,
            total_pages=chron_page_count + records_page_count,
            link_count=link_count,
            output=output_path,
        )
    finally:
        # Don't delete workdir on error — helpful for debugging.
        pass


# ── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--chronology", required=True,
                   help="Path to chronology file (.pdf/.doc/.docx)")
    p.add_argument("--records", required=True,
                   help="Path to merged medical records PDF")
    p.add_argument("--output", required=True,
                   help="Path to write combined hyperlinked PDF")
    p.add_argument("--min-ref", type=int, default=1)
    p.add_argument("--max-ref", type=int, default=None)
    args = p.parse_args()

    result = hyperlink_medical_records(
        args.chronology, args.records, args.output,
        min_ref=args.min_ref, max_ref=args.max_ref,
    )
    print(
        f"Chronology pages: {result.chronology_pages}  "
        f"Records pages: {result.records_pages}  "
        f"Total pages: {result.total_pages}  "
        f"Links: {result.link_count}"
    )
    print(f"Output: {result.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

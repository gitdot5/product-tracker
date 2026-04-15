"""
Stage 5 — MedSum-style Merged Medical Records.

Builds a single merged PDF from a folder of source files in the exact format
MedSum produces:

    * One L1 bookmark per source file, named
         "{filename}.pdf (p.{start}-{end})"
      or, for single-page files,
         "{filename}.pdf (p.{start})"
    * L2-Ln bookmarks preserved from each source PDF's internal outline,
      with page numbers offset to the merged document.
    * Source files sorted alphabetically by relative path (default). A
      receipt manifest CSV can be passed to override the order.

Supported source formats:
    .pdf                     — inserted directly
    .doc / .docx / .rtf      — converted via headless LibreOffice
    .jpg / .jpeg / .png /
    .tif / .tiff / .heic /
    .bmp / .webp             — converted to single-page PDFs via PIL

Usage:
    python -m pipeline.stage5_merge \\
        --source "Source Files/" \\
        --output "Merged Medical Records - Patient Name.pdf"
    # optional
    --manifest "receipt_manifest.csv"   # two cols: filename,received_at
    --recurse                           # walk subdirectories (default on)
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import fitz  # PyMuPDF

log = logging.getLogger(__name__)


PDF_EXTS = {".pdf"}
OFFICE_EXTS = {".doc", ".docx", ".rtf", ".odt"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff",
              ".heic", ".bmp", ".webp", ".gif"}

SUPPORTED_EXTS = PDF_EXTS | OFFICE_EXTS | IMAGE_EXTS

# Files to always ignore.
_IGNORE_NAMES = {"DS_Store", ".DS_Store", "Thumbs.db", "desktop.ini"}


@dataclass
class MergeResult:
    source_files: int
    total_pages: int
    top_level_bookmarks: int
    total_bookmarks: int
    output: str

    def as_dict(self) -> dict:
        return self.__dict__


# ── Source discovery ───────────────────────────────────────────────────────

def _is_supported(path: Path) -> bool:
    if path.name in _IGNORE_NAMES or path.name.startswith("."):
        return False
    return path.suffix.lower() in SUPPORTED_EXTS


def discover_sources(source_dir: Path, recurse: bool = True) -> List[Path]:
    """Return sorted list of supported source file paths."""
    if recurse:
        candidates = [p for p in source_dir.rglob("*")
                      if p.is_file() and _is_supported(p)]
    else:
        candidates = [p for p in source_dir.iterdir()
                      if p.is_file() and _is_supported(p)]
    # Sort by POSIX-style relative path for stable ordering
    return sorted(candidates, key=lambda p: str(p.relative_to(source_dir)))


def apply_manifest(files: List[Path], manifest_csv: Path,
                   source_dir: Path) -> List[Path]:
    """Reorder files using a CSV manifest with columns: filename, received_at.

    filename is matched against the path relative to source_dir. Unknown files
    in the manifest are ignored; files missing from the manifest keep their
    alphabetical position at the END.
    """
    with manifest_csv.open(newline="") as f:
        reader = csv.DictReader(f)
        order = []
        for row in reader:
            fname = row.get("filename") or row.get("path") or ""
            received = row.get("received_at") or row.get("received") or ""
            if fname:
                order.append((received, fname.strip()))
    order.sort()  # sort by received_at (ISO strings sort naturally)

    by_rel: Dict[str, Path] = {str(p.relative_to(source_dir)): p
                               for p in files}
    ordered: List[Path] = []
    seen: set = set()
    for _, fname in order:
        if fname in by_rel and fname not in seen:
            ordered.append(by_rel[fname])
            seen.add(fname)
    # Append any files not in manifest (alphabetical tail)
    for p in files:
        rel = str(p.relative_to(source_dir))
        if rel not in seen:
            ordered.append(p)
    return ordered


# ── Format converters ──────────────────────────────────────────────────────

def _libreoffice_to_pdf(path: Path, workdir: Path) -> Path:
    subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf",
         str(path), "--outdir", str(workdir)],
        check=True, capture_output=True,
    )
    out = workdir / (path.stem + ".pdf")
    if not out.exists():
        raise RuntimeError(f"LibreOffice produced no PDF for {path}")
    return out


def _image_to_pdf(path: Path, workdir: Path) -> Path:
    from PIL import Image
    img = Image.open(path)
    # Normalize mode for PDF (PDF needs RGB or grayscale, not RGBA / palette)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGB")
    out = workdir / (path.stem + ".pdf")
    img.save(out, "PDF", resolution=150.0)
    return out


def to_pdf(path: Path, workdir: Path) -> Path:
    """Return a PDF path for any supported source format."""
    ext = path.suffix.lower()
    if ext in PDF_EXTS:
        return path
    if ext in OFFICE_EXTS:
        return _libreoffice_to_pdf(path, workdir)
    if ext in IMAGE_EXTS:
        return _image_to_pdf(path, workdir)
    raise ValueError(f"Unsupported source format: {path}")


# ── Core merge ─────────────────────────────────────────────────────────────

def _bookmark_label(src_path: Path, start: int, end: int) -> str:
    """Format: '{filename}.pdf (p.{start}-{end})' — .pdf always appended,
    matching the MedSum convention where even .doc/.jpg sources get the
    .pdf suffix in the bookmark (the merged doc is always PDF). For files
    whose original extension is already .pdf we keep the name as-is."""
    name = src_path.name
    if not name.lower().endswith(".pdf"):
        name = src_path.stem + ".pdf"
    if start == end:
        return f"{name} (p.{start})"
    return f"{name} (p.{start}-{end})"


def merge_records(
    source_dir: Path,
    output_path: Path,
    *,
    manifest_csv: Optional[Path] = None,
    recurse: bool = True,
    include_source_toc: bool = True,
) -> MergeResult:
    """Build a MedSum-format Merged Medical Records PDF from source_dir.

    Returns a MergeResult summarising source/page/bookmark counts.
    """
    source_dir = source_dir.resolve()
    output_path = Path(output_path).resolve()
    workdir = Path(tempfile.mkdtemp(prefix="merge_"))

    files = discover_sources(source_dir, recurse=recurse)
    if manifest_csv:
        files = apply_manifest(files, manifest_csv, source_dir)
    if not files:
        raise RuntimeError(f"No supported source files in {source_dir}")

    log.info("Merging %d source files from %s", len(files), source_dir)

    out = fitz.open()
    toc: List[List] = []  # PyMuPDF format: [level, title, page]
    cursor = 0  # pages already in `out`

    for src_path in files:
        try:
            pdf_path = to_pdf(src_path, workdir)
        except Exception as exc:
            log.warning("Skipping %s — conversion failed: %s", src_path, exc)
            continue

        try:
            src_doc = fitz.open(pdf_path)
        except Exception as exc:
            log.warning("Skipping %s — could not open PDF: %s", src_path, exc)
            continue

        start = cursor + 1
        end = cursor + len(src_doc)
        log.info("  +%-50s  pages %d-%d", src_path.name[:50], start, end)

        # L1 bookmark for this source file.
        toc.append([1, _bookmark_label(src_path, start, end), start])

        # Preserve nested outline from source PDF, shifted by `cursor`.
        if include_source_toc:
            try:
                for lvl, title, pg, *rest in src_doc.get_toc(simple=False):
                    shifted = max(1, pg) + cursor if pg >= 1 else start
                    # Clamp to legal range.
                    shifted = min(max(shifted, 1), end)
                    toc.append([lvl + 1, title, shifted])
            except Exception as exc:
                log.debug("TOC preservation failed for %s: %s", src_path, exc)

        out.insert_pdf(src_doc)
        cursor = end
        src_doc.close()

    log.info("Writing %d pages with %d bookmarks to %s",
             cursor, len(toc), output_path)

    out.set_toc(toc)
    # Use lighter save options for large docs: garbage=1 + deflate=False runs in
    # seconds vs minutes for garbage=4+deflate=True on 2,000+ page merges. The
    # resulting file is bigger (not recompressed) but each source page is
    # already compressed inside its PDF stream. Acceptable trade-off.
    _save_opts = dict(garbage=1, deflate=False, clean=False)
    if cursor < 500:  # small doc — cheap to fully optimize
        _save_opts = dict(garbage=4, deflate=True)
    out.save(output_path, **_save_opts)
    out.close()

    top_level = sum(1 for t in toc if t[0] == 1)

    return MergeResult(
        source_files=len(files),
        total_pages=cursor,
        top_level_bookmarks=top_level,
        total_bookmarks=len(toc),
        output=str(output_path),
    )


# ── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--source", required=True,
                   help="Path to Source Files directory")
    p.add_argument("--output", required=True,
                   help="Output PDF path")
    p.add_argument("--manifest", default=None,
                   help="Optional CSV with 'filename,received_at' columns to "
                        "override ordering")
    p.add_argument("--no-recurse", dest="recurse", action="store_false",
                   help="Do not descend into subdirectories")
    p.add_argument("--no-source-toc", dest="include_source_toc",
                   action="store_false",
                   help="Do not preserve source-PDF outlines as nested bookmarks")
    p.set_defaults(recurse=True, include_source_toc=True)
    args = p.parse_args()

    res = merge_records(
        Path(args.source), Path(args.output),
        manifest_csv=Path(args.manifest) if args.manifest else None,
        recurse=args.recurse,
        include_source_toc=args.include_source_toc,
    )
    print(
        f"Source files: {res.source_files}  "
        f"Pages: {res.total_pages}  "
        f"Bookmarks: {res.total_bookmarks} "
        f"(L1: {res.top_level_bookmarks})"
    )
    print(f"Output: {res.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

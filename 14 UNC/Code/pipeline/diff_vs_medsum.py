"""
Ground-truth comparator — diff our pipeline's 4-file output against
MedSum's reference 4-file deliverable for the same case.

This is the missing measurement: everything else has been opinion about
"how close are we." This script quantifies it.

Inputs:
    --ours-dir     directory containing OUR pipeline's output (4 files)
    --medsum-dir   directory containing MedSum's reference (4 files)
    --patient-name used to construct file names inside each dir

Metrics computed:
    • Merged Records PDF: page count, bookmark count, bookmark-title
      overlap (%)
    • Medical Chronology .doc(x): section presence, encounter count,
      unique (date, facility) pairs, token recall on injury-report
      diagnoses, patient-history field-by-field text overlap
    • Delivery Note: boilerplate-block presence, token recall on
      Case-focus paragraph, Missing-Records row count match
    • Hyperlinked Records: page count, link count, internal/external
      link split, source-page→target-page pair overlap

Output: prints a summary table + writes `diff_vs_medsum.json` to the
ours-dir for archival.

Usage:
    python -m pipeline.diff_vs_medsum \\
        --patient-name "Jon Witting" \\
        --ours-dir     "/path/to/AI Pipeline Output/" \\
        --medsum-dir   "/path/to/Final Files/"
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import tempfile
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import fitz

log = logging.getLogger(__name__)


# ── Utilities ──────────────────────────────────────────────────────────────

def _tokens(text: str) -> Set[str]:
    """Lowercase whitespace-tokenized set, for quick recall computations."""
    return set(re.findall(r"[a-z0-9][a-z0-9\-/]+", (text or "").lower()))


def _jaccard(a: Set, b: Set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _doc_to_text(path: Path, workdir: Path) -> str:
    """.doc/.docx → plain text via LibreOffice headless."""
    subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "txt",
         str(path), "--outdir", str(workdir)],
        check=True, capture_output=True,
    )
    out = workdir / (path.stem + ".txt")
    return out.read_text() if out.exists() else ""


def _find_file(dir_path: Path, *keywords: str) -> Optional[Path]:
    """Find the first file in dir whose name contains all keywords (case-insensitive)."""
    for p in sorted(dir_path.glob("*")):
        name = p.name.lower()
        if all(k.lower() in name for k in keywords):
            return p
    return None


# ── Per-file diff implementations ──────────────────────────────────────────

@dataclass
class MergedDiff:
    ours_pages: int = 0
    medsum_pages: int = 0
    ours_bookmarks: int = 0
    medsum_bookmarks: int = 0
    ours_l1: int = 0
    medsum_l1: int = 0
    l1_title_overlap: float = 0.0          # Jaccard of L1 titles (name-only)
    exact_page_match: bool = False


@dataclass
class HyperlinkDiff:
    ours_pages: int = 0
    medsum_pages: int = 0
    ours_links: int = 0
    medsum_links: int = 0
    exact_link_pairs: int = 0              # (src_page, tgt_page) identical
    ours_only_pairs: int = 0
    medsum_only_pairs: int = 0
    recall: float = 0.0                    # len(exact) / max(medsum, 1)


@dataclass
class ChronologyDiff:
    sections_present: Dict[str, bool] = field(default_factory=dict)
    ours_encounters_estimated: int = 0
    medsum_encounters_estimated: int = 0
    diagnosis_token_recall: float = 0.0    # our diagnoses tokens ∩ medsum / medsum
    patient_history_lines_match: Dict[str, float] = field(default_factory=dict)
    char_length_ratio: float = 0.0         # len(ours) / len(medsum)


@dataclass
class DeliveryDiff:
    boilerplate_blocks_present: Dict[str, bool] = field(default_factory=dict)
    case_focus_token_recall: float = 0.0
    medsum_missing_rows: int = 0
    ours_missing_rows: int = 0


@dataclass
class OverallDiff:
    patient: str = ""
    merged: MergedDiff = field(default_factory=MergedDiff)
    hyperlink: HyperlinkDiff = field(default_factory=HyperlinkDiff)
    chronology: ChronologyDiff = field(default_factory=ChronologyDiff)
    delivery: DeliveryDiff = field(default_factory=DeliveryDiff)

    def as_dict(self) -> dict:
        return {
            "patient": self.patient,
            "merged": asdict(self.merged),
            "hyperlink": asdict(self.hyperlink),
            "chronology": asdict(self.chronology),
            "delivery": asdict(self.delivery),
        }


# ── Diffs ──────────────────────────────────────────────────────────────────

def _diff_merged(ours: Path, medsum: Path) -> MergedDiff:
    d = MergedDiff()
    if not ours.exists() or not medsum.exists():
        return d
    od = fitz.open(ours)
    md = fitz.open(medsum)
    d.ours_pages, d.medsum_pages = len(od), len(md)
    ot = od.get_toc()
    mt = md.get_toc()
    d.ours_bookmarks, d.medsum_bookmarks = len(ot), len(mt)
    ours_l1 = [t[1] for t in ot if t[0] == 1]
    medsum_l1 = [t[1] for t in mt if t[0] == 1]
    d.ours_l1, d.medsum_l1 = len(ours_l1), len(medsum_l1)

    # Compare L1 titles ignoring the page-range suffix
    def _strip(s): return re.sub(r"\s*\(p\.\s*\d+.*?\)", "", s).strip().lower()
    a = set(_strip(t) for t in ours_l1)
    b = set(_strip(t) for t in medsum_l1)
    d.l1_title_overlap = _jaccard(a, b)
    d.exact_page_match = (d.ours_pages == d.medsum_pages)
    od.close(); md.close()
    return d


def _diff_hyperlink(ours: Path, medsum: Path) -> HyperlinkDiff:
    d = HyperlinkDiff()
    if not ours.exists() or not medsum.exists():
        return d
    od = fitz.open(ours)
    md = fitz.open(medsum)
    d.ours_pages, d.medsum_pages = len(od), len(md)

    def _collect(doc):
        pairs = set()
        for i, p in enumerate(doc):
            for L in p.get_links():
                if L.get("kind") == 1:  # LINK_GOTO
                    pairs.add((i, L.get("page")))
        return pairs

    ours_p = _collect(od)
    medsum_p = _collect(md)
    d.ours_links, d.medsum_links = len(ours_p), len(medsum_p)
    d.exact_link_pairs = len(ours_p & medsum_p)
    d.ours_only_pairs = len(ours_p - medsum_p)
    d.medsum_only_pairs = len(medsum_p - ours_p)
    d.recall = d.exact_link_pairs / max(d.medsum_links, 1)
    od.close(); md.close()
    return d


# Chronology structure signals we look for in the converted text
_CHRON_SECTIONS = [
    "Medical Chronology/Summary",
    "Confidential",
    "Usage guideline",
    "General Instructions",
    "Injury Report",
    "Flow of events",
    "Patient History",
    "Detailed Summary",
]


def _diff_chronology(ours: Path, medsum: Path, workdir: Path) -> ChronologyDiff:
    d = ChronologyDiff()
    if not ours.exists() or not medsum.exists():
        return d
    ours_txt = _doc_to_text(ours, workdir) if ours.exists() else ""
    medsum_txt = _doc_to_text(medsum, workdir) if medsum.exists() else ""

    for sec in _CHRON_SECTIONS:
        d.sections_present[sec] = sec.lower() in ours_txt.lower()

    d.char_length_ratio = len(ours_txt) / max(len(medsum_txt), 1)

    # Crude encounter count estimate: lines that start with MM/DD/YYYY date
    date_line_re = re.compile(r"^\s*(\d{1,2}/\d{1,2}/\d{4})", re.MULTILINE)
    d.ours_encounters_estimated = len(date_line_re.findall(ours_txt))
    d.medsum_encounters_estimated = len(date_line_re.findall(medsum_txt))

    # Diagnosis token recall — pull out text after "Injuries/ Diagnoses" until
    # the next section header (heuristic).
    def _dx_block(text):
        m = re.search(
            r"Injuries[/ ]+Diagnoses(.*?)(?=Treatments rendered|$)",
            text, re.IGNORECASE | re.DOTALL,
        )
        return _tokens(m.group(1)) if m else set()

    ours_dx = _dx_block(ours_txt)
    medsum_dx = _dx_block(medsum_txt)
    d.diagnosis_token_recall = (
        len(ours_dx & medsum_dx) / len(medsum_dx) if medsum_dx else 0.0
    )

    # Patient-history per-line Jaccard
    for line_label in ["Past Medical History", "Surgical History",
                       "Family History", "Social History", "Allergy"]:
        pattern = re.compile(rf"{line_label}[:]?\s*(.+)", re.IGNORECASE)
        om = pattern.search(ours_txt)
        mm = pattern.search(medsum_txt)
        oo = _tokens(om.group(1)[:500]) if om else set()
        mm_t = _tokens(mm.group(1)[:500]) if mm else set()
        d.patient_history_lines_match[line_label] = _jaccard(oo, mm_t)

    return d


# Delivery Note boilerplate phrases
_DELIVERY_BLOCKS = [
    "Dear",
    "completed the medical records review",
    "hyperlinked medical records",
    "Medical chronology:",
    "Case focus",
    "Missing medical records",
    "Merged Medical Records:",
    "Hyperlinked Medical Records:",
    "We will be happy to make any modifications",
    "*****",
]


def _diff_delivery(ours: Path, medsum: Path, workdir: Path) -> DeliveryDiff:
    d = DeliveryDiff()
    ours_txt = _doc_to_text(ours, workdir) if ours.exists() else ""
    medsum_txt = _doc_to_text(medsum, workdir) if medsum.exists() else ""

    for block in _DELIVERY_BLOCKS:
        d.boilerplate_blocks_present[block] = block.lower() in ours_txt.lower()

    # Case focus token recall
    def _focus(text):
        m = re.search(
            r"Case[- ]?(?:focus details|overview)[:]?\s*(.*?)"
            r"(?=Missing [mM]edical|Merged Medical|$)",
            text, re.DOTALL,
        )
        return _tokens(m.group(1)[:5000]) if m else set()

    ours_f = _focus(ours_txt)
    medsum_f = _focus(medsum_txt)
    d.case_focus_token_recall = (
        len(ours_f & medsum_f) / len(medsum_f) if medsum_f else 0.0
    )

    # Missing-records rows: lines that look like a tab-separated row
    # beginning with a date/period token. Very rough but comparable.
    def _missing_rows(text):
        m = re.search(
            r"Missing [mM]edical [Rr]ecords[:]?\s*(.*?)"
            r"(?=Merged Medical|Please retrieve|$)",
            text, re.DOTALL,
        )
        if not m:
            return 0
        block = m.group(1)
        return sum(1 for line in block.splitlines() if "\t" in line and
                   not line.strip().startswith("Date/"))

    d.ours_missing_rows = _missing_rows(ours_txt)
    d.medsum_missing_rows = _missing_rows(medsum_txt)
    return d


# ── Public API ─────────────────────────────────────────────────────────────

def run_diff(ours_dir: Path, medsum_dir: Path, patient: str) -> OverallDiff:
    workdir = Path(tempfile.mkdtemp(prefix="diff_"))
    out = OverallDiff(patient=patient)

    # Merged Records
    ours_merged = _find_file(ours_dir, "Merged", "Records", ".pdf")
    medsum_merged = _find_file(medsum_dir, "Merged", ".pdf")
    if ours_merged and medsum_merged:
        log.info("Diffing Merged Records…")
        out.merged = _diff_merged(ours_merged, medsum_merged)

    # Hyperlinked Records
    ours_hyper = _find_file(ours_dir, "Hyperlinked", ".pdf") or \
                 _find_file(ours_dir, "Hyperlinked")
    medsum_hyper = _find_file(medsum_dir, "Hyperlinked", ".pdf") or \
                   _find_file(medsum_dir, "Hyper", ".pdf")
    if ours_hyper and medsum_hyper:
        log.info("Diffing Hyperlinked Records…")
        out.hyperlink = _diff_hyperlink(ours_hyper, medsum_hyper)

    # Chronology (.docx ours, .doc MedSum typically)
    ours_chron = _find_file(ours_dir, "Chronology")
    medsum_chron = _find_file(medsum_dir, "Chronology")
    if ours_chron and medsum_chron:
        log.info("Diffing Medical Chronology…")
        out.chronology = _diff_chronology(ours_chron, medsum_chron, workdir)

    # Delivery Note
    ours_deliv = _find_file(ours_dir, "Delivery")
    medsum_deliv = _find_file(medsum_dir, "Delivery")
    if ours_deliv and medsum_deliv:
        log.info("Diffing Delivery Note…")
        out.delivery = _diff_delivery(ours_deliv, medsum_deliv, workdir)

    return out


def _print_summary(d: OverallDiff) -> None:
    print()
    print("=" * 70)
    print(f"DIFF vs MedSum — {d.patient}")
    print("=" * 70)
    print()
    print("── Merged Medical Records .pdf ──")
    m = d.merged
    print(f"  pages:       ours={m.ours_pages}  medsum={m.medsum_pages}  "
          f"{'✓' if m.exact_page_match else '✗'}")
    print(f"  bookmarks:   ours={m.ours_bookmarks}  medsum={m.medsum_bookmarks}")
    print(f"  L1 titles:   ours={m.ours_l1}  medsum={m.medsum_l1}  "
          f"overlap={m.l1_title_overlap:.1%}")
    print()
    print("── Hyperlinked Medical Records .pdf ──")
    h = d.hyperlink
    print(f"  pages:       ours={h.ours_pages}  medsum={h.medsum_pages}")
    print(f"  GOTO links:  ours={h.ours_links}  medsum={h.medsum_links}")
    print(f"  exact pairs: {h.exact_link_pairs}  (recall={h.recall:.1%})")
    print(f"  ours-only={h.ours_only_pairs}  medsum-only={h.medsum_only_pairs}")
    print()
    print("── Medical Chronology .doc(x) ──")
    c = d.chronology
    present = sum(c.sections_present.values())
    print(f"  sections:    {present}/{len(c.sections_present)} required sections present")
    print(f"  encounters:  ours={c.ours_encounters_estimated}  "
          f"medsum={c.medsum_encounters_estimated}")
    print(f"  diagnoses:   token recall={c.diagnosis_token_recall:.1%}")
    print(f"  length:      ours/medsum={c.char_length_ratio:.2f}")
    for k, v in c.patient_history_lines_match.items():
        print(f"  history.{k:25s} {v:.1%}")
    print()
    print("── Delivery Note .docx ──")
    dn = d.delivery
    present = sum(dn.boilerplate_blocks_present.values())
    print(f"  blocks:          {present}/{len(dn.boilerplate_blocks_present)} boilerplate blocks present")
    print(f"  case focus:      token recall={dn.case_focus_token_recall:.1%}")
    print(f"  missing records: ours={dn.ours_missing_rows}  medsum={dn.medsum_missing_rows}")
    print()


# ── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--ours-dir", required=True)
    p.add_argument("--medsum-dir", required=True)
    p.add_argument("--patient-name", required=True)
    args = p.parse_args()

    result = run_diff(Path(args.ours_dir), Path(args.medsum_dir), args.patient_name)
    _print_summary(result)

    out_path = Path(args.ours_dir) / "diff_vs_medsum.json"
    out_path.write_text(json.dumps(result.as_dict(), indent=2))
    print(f"Archived: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

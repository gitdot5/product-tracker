"""
Second-pass encounter merger.

PROBLEM this solves:
    After Stage 2 merges per-chunk ChronologyDocs, the (date, facility) dedup
    still leaves duplicates because facility names are not canonicalized. From
    Hatcher:
        "The Cardiac and Vascular Institute" (13 encs)
        "Cardiac and Vascular Institute"     (10 encs)
        "One Stop Medical and Urgent Care"   (8 encs)
        "OneStop Medical and Urgent Care"    (8 encs)
        "North Florida Hospital"             (3 encs)
        "North Florida Hospital (HCA)"       (3 encs)
        "UF Shands Comprehensive Stroke Center"        (1)
        "UF Health Shands Comprehensive Stroke Center" (1)

    These are trivially the same place, but exact string match misses them.

WHAT this does:
    1. Normalize facility names: strip leading "The ", remove parenthetical
       qualifiers "(HCA)", normalize "&"/"and", "St."/"Saint", collapse
       whitespace, drop common suffixes (", P.A.", ", LLC").
    2. Build a canonical map: for each raw facility, pick the longest / most-
       frequent variant as canonical (preserves the nicest human-readable form).
    3. Fuzzy cluster near-matches using token-set containment (optional).
    4. Merge encounters whose (date_key, canonical_facility) collide. Union
       medical_events text, pdf_refs, providers. Keep canonical name.

USAGE:
    from pipeline.encounter_merger import merge_encounters
    doc = json.load(open("chronology_doc.json"))
    doc2 = merge_encounters(doc, fuzzy=True)
    json.dump(doc2, open("chronology_doc_merged.json", "w"), indent=2)

    # Or CLI:
    python -m pipeline.encounter_merger \
        --input  chronology_doc.json \
        --output chronology_doc_merged.json \
        --fuzzy
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

log = logging.getLogger(__name__)


# ── Facility normalization ────────────────────────────────────────────────

# Common legal/organisational suffixes to strip (after the main name).
_SUFFIXES = [
    r",?\s*P\.?\s*A\.?\b",
    r",?\s*L\.?\s*L\.?\s*C\.?\b",
    r",?\s*L\.?\s*L\.?\s*P\.?\b",
    r",?\s*Inc\.?\b",
    r",?\s*Corp\.?\b",
    r",?\s*M\.?\s*D\.?\b",          # doctor titles trailing a facility line
]

# Parenthetical qualifiers that add no info ("(HCA)", "(Part of UF Health)")
_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*")

# Leading "The " (English articles shouldn't drive bucket keys).
_LEADING_THE = re.compile(r"^\s*the\s+", re.IGNORECASE)

# Common synonyms / abbreviations.
_SUBS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"\bSt\.\s*", re.IGNORECASE), "Saint "),
    (re.compile(r"\bDr\.\s*", re.IGNORECASE), ""),
    (re.compile(r"\bMt\.\s*", re.IGNORECASE), "Mount "),
    (re.compile(r"\s+&\s+"), " and "),
    (re.compile(r"\bER\b", re.IGNORECASE), "emergency room"),
    (re.compile(r"\bED\b"), "emergency department"),
    # One Stop vs OneStop etc.
    (re.compile(r"\bone\s*stop\b", re.IGNORECASE), "onestop"),
    (re.compile(r"\buf\s*health\b", re.IGNORECASE), "uf"),
    (re.compile(r"\buf\s*shands\b", re.IGNORECASE), "uf"),
]

_WORD_RE = re.compile(r"[a-z0-9]+")


def canonical_key(raw: str) -> str:
    """Return a stable lower-case key for facility bucketing.

    Strips leading "The ", parentheticals, suffixes (P.A., LLC), applies
    synonym substitutions, lowercases, and collapses to sorted token
    signature so word-order variation doesn't matter
    (e.g. "MCOT / Philips BioTelemetry" ~ "Philips MCOT / BioTelemetry").
    """
    if not raw:
        return ""
    s = raw.strip()
    # Strip parenthetical qualifiers
    s = _PAREN_RE.sub(" ", s)
    # Strip leading "The "
    s = _LEADING_THE.sub("", s)
    # Strip trailing corporate suffixes
    for suf in _SUFFIXES:
        s = re.sub(suf, "", s, flags=re.IGNORECASE)
    # Apply synonym substitutions
    for pat, repl in _SUBS:
        s = pat.sub(repl, s)
    # Tokenize and sort — word order invariant
    tokens = _WORD_RE.findall(s.lower())
    # Drop tiny stopwords that add noise
    STOP = {"the", "of", "a", "an", "and", "or", "for"}
    tokens = [t for t in tokens if t not in STOP]
    return " ".join(sorted(tokens))


def display_name(raws: List[str]) -> str:
    """Pick the best human-readable facility name from a list of raw variants.

    Heuristic: prefer the longest variant with the most tokens (more specific),
    break ties by alphabetical order (stable).
    """
    if not raws:
        return ""
    # Deduplicate preserving order
    seen = []
    for r in raws:
        r = (r or "").strip()
        if r and r not in seen:
            seen.append(r)
    if not seen:
        return ""
    # Prefer the one with the most tokens (most descriptive), then shortest
    # character length among those (avoids overly verbose variants).
    return max(seen, key=lambda s: (len(s.split()), -len(s)))


# ── Date canonicalization ─────────────────────────────────────────────────

def canonical_date(raw: str) -> str:
    """Return YYYY-MM-DD for sortable MM/DD/YYYY. Leave date-ranges alone."""
    if not raw:
        return ""
    raw = raw.strip()
    # If it's a range, just use the start date as the key
    start = raw.split("-")[0].strip() if "-" in raw and not re.match(r"^\d{4}-\d{2}-\d{2}$", raw) else raw
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", start)
    if not m:
        return raw.lower()
    mo, dy, yr = m.groups()
    if len(yr) == 2:
        yr = "20" + yr if int(yr) < 50 else "19" + yr
    return f"{yr}-{mo.zfill(2)}-{dy.zfill(2)}"


# ── Merge engine ──────────────────────────────────────────────────────────

def _merge_bodies(a: str, b: str) -> str:
    """Concatenate two medical_events blocks without duplicating identical text."""
    a = (a or "").strip()
    b = (b or "").strip()
    if not a:
        return b
    if not b:
        return a
    if b in a:
        return a
    if a in b:
        return b
    return a + "\n\n" + b


def _merge_refs(a: str, b: str) -> str:
    """Union comma-separated pdf_ref strings."""
    parts = []
    seen = set()
    for src in (a or "", b or ""):
        for chunk in str(src).split(","):
            c = chunk.strip()
            if c and c not in seen:
                parts.append(c)
                seen.add(c)
    return ", ".join(parts)


def _merge_providers(a: list, b: list) -> list:
    out = []
    seen = set()
    for src in (a or [], b or []):
        for p in src:
            k = (p or "").strip().lower()
            if k and k not in seen:
                out.append(p)
                seen.add(k)
    return out


def merge_encounters(doc: dict, fuzzy: bool = True) -> dict:
    """Return a new ChronologyDoc with encounters merged by (date, canonical_facility).

    Args:
        doc: ChronologyDoc dict (parsed chronology_doc.json).
        fuzzy: If True, rewrite each encounter's `facility` to the chosen
               display_name for its canonical bucket (so downstream formatting
               is consistent). If False, keep the original facility names but
               still collapse duplicates.

    Returns:
        A deep copy with:
            encounters:   merged & sorted
            provenance:   facility_merger_applied=True,
                          facility_merger_before/after/collapsed,
                          facility_merger_clusters: [{canonical, variants, count}]
    """
    out = copy.deepcopy(doc)
    encounters = out.get("encounters", []) or []

    # Step 1 — build canonical facility map across all encounters
    variant_by_key: Dict[str, List[str]] = defaultdict(list)
    for enc in encounters:
        fac = (enc.get("facility") or "").strip()
        key = canonical_key(fac)
        if fac:
            variant_by_key[key].append(fac)

    display_by_key: Dict[str, str] = {
        k: display_name(v) for k, v in variant_by_key.items()
    }

    # Record what got clustered for the provenance log
    clusters_info = []
    for k, variants in variant_by_key.items():
        counts = Counter(variants)
        if len(counts) > 1:
            clusters_info.append({
                "canonical": display_by_key[k],
                "key": k,
                "variants": [{"name": n, "count": c} for n, c in counts.most_common()],
            })

    # Step 2 — merge by (canonical_date, canonical_facility_key)
    merged: List[dict] = []
    index_by_key: Dict[Tuple[str, str], int] = {}

    for enc in encounters:
        fac_raw = (enc.get("facility") or "").strip()
        date_raw = (enc.get("date") or "").strip()
        fac_key = canonical_key(fac_raw)
        date_key = canonical_date(date_raw)
        key = (date_key, fac_key)

        # If both date and facility are missing, always keep as distinct
        if not date_key and not fac_key:
            merged.append(enc)
            continue

        if key not in index_by_key:
            # First time — overwrite facility with display name if requested
            if fuzzy and fac_key and display_by_key.get(fac_key):
                enc = copy.deepcopy(enc)
                enc["facility"] = display_by_key[fac_key]
            index_by_key[key] = len(merged)
            merged.append(enc)
            continue

        # Collision — fold into existing entry
        prev = merged[index_by_key[key]]
        prev["medical_events"] = _merge_bodies(
            prev.get("medical_events", ""), enc.get("medical_events", "")
        )
        prev["pdf_ref"] = _merge_refs(prev.get("pdf_ref", ""), enc.get("pdf_ref", ""))
        prev["providers"] = _merge_providers(
            prev.get("providers") or [], enc.get("providers") or []
        )
        # Keep canonical display name
        if fuzzy and fac_key and display_by_key.get(fac_key):
            prev["facility"] = display_by_key[fac_key]

    # Step 3 — sort chronologically by canonical_date
    merged.sort(key=lambda e: canonical_date(e.get("date") or ""))

    # Step 4 — provenance
    before = len(encounters)
    after = len(merged)
    prov = out.setdefault("provenance", {})
    prov["facility_merger_applied"] = True
    prov["facility_merger_before"] = before
    prov["facility_merger_after"] = after
    prov["facility_merger_collapsed"] = before - after
    prov["facility_merger_clusters"] = clusters_info
    prov["facility_merger_fuzzy"] = fuzzy

    out["encounters"] = merged

    log.info(
        "Facility merger: %d → %d encounters (%d collapsed, %d multi-variant clusters)",
        before, after, before - after, len(clusters_info),
    )
    return out


# ── CLI ──────────────────────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--input", required=True, help="chronology_doc.json")
    p.add_argument("--output", required=True, help="where to write merged doc")
    p.add_argument("--fuzzy", action="store_true",
                   help="Rewrite facility names to canonical display form (default off)")
    p.add_argument("--report", action="store_true",
                   help="Also print the cluster report to stdout")
    args = p.parse_args()

    with open(args.input) as f:
        doc = json.load(f)
    out = merge_encounters(doc, fuzzy=args.fuzzy)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {args.output}")
    print(f"  {out['provenance']['facility_merger_before']} → "
          f"{out['provenance']['facility_merger_after']} encounters")
    print(f"  {len(out['provenance']['facility_merger_clusters'])} multi-variant clusters")
    if args.report:
        for c in out["provenance"]["facility_merger_clusters"]:
            print(f"  - {c['canonical']}")
            for v in c["variants"]:
                print(f"      [{v['count']}] {v['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
Post-hoc (date, facility) dedup for an already-generated chronology_doc.json.

Useful when a Stage 2 run emitted duplicates (because the pipeline was
running an older merge build) and we don't want to pay to regenerate.

Applies the same (date, facility) uniqueness rule that _merge_chronology_docs
now enforces at merge time: collapse duplicate encounters, union medical_events
and pdf_ref, prefer the longer providers list.

Usage:
    python -m pipeline.post_dedup \\
        --input  chronology_doc.json \\
        --output chronology_doc_deduped.json
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
from pathlib import Path
from typing import Dict, List, Tuple

log = logging.getLogger(__name__)


def dedup_chronology(doc: dict) -> dict:
    """Return a new ChronologyDoc dict with duplicate encounters merged.

    Key = (date.strip().lower(), facility.strip().lower()). Entries with
    an empty key are passed through unchanged.
    """
    out = copy.deepcopy(doc)
    encounters = out.get("encounters", []) or []
    merged: List[dict] = []
    index_by_key: Dict[Tuple[str, str], int] = {}

    for enc in encounters:
        key = ((enc.get("date") or "").strip().lower(),
               (enc.get("facility") or "").strip().lower())
        if key == ("", ""):
            merged.append(enc)
            continue

        if key not in index_by_key:
            index_by_key[key] = len(merged)
            merged.append(enc)
            continue

        # Collision — fold into existing entry
        prev = merged[index_by_key[key]]
        prev_body = prev.get("medical_events", "") or ""
        new_body = enc.get("medical_events", "") or ""
        if new_body and new_body not in prev_body:
            prev["medical_events"] = (prev_body + "\n" + new_body).strip() \
                if prev_body else new_body
        prev_ref = (prev.get("pdf_ref") or "").strip()
        new_ref = (enc.get("pdf_ref") or "").strip()
        if new_ref and new_ref not in prev_ref:
            prev["pdf_ref"] = (prev_ref + ", " + new_ref).strip(", ") \
                if prev_ref else new_ref
        if len(enc.get("providers") or []) > len(prev.get("providers") or []):
            prev["providers"] = enc.get("providers") or []

    before = len(encounters)
    after = len(merged)

    # Re-sort chronologically
    def _date_key(e: dict) -> str:
        d = (e.get("date") or "").split("-")[0].strip()
        try:
            m, day, y = d.split("/")
            return f"{y}-{m.zfill(2)}-{day.zfill(2)}"
        except Exception:
            return d

    merged.sort(key=_date_key)
    out["encounters"] = merged

    prov = out.setdefault("provenance", {})
    prov["post_dedup_applied"] = True
    prov["post_dedup_before"] = before
    prov["post_dedup_after"] = after
    prov["post_dedup_collapsed"] = before - after

    log.info("Dedup: %d → %d encounters (%d duplicates collapsed)",
             before, after, before - after)
    return out


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()

    with open(args.input) as f:
        doc = json.load(f)
    out = dedup_chronology(doc)
    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

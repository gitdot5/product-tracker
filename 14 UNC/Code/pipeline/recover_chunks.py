"""
Recovery — merge a directory of per-chunk JSON checkpoints back into a
single ChronologyDoc. Use when Stage 2 completed all chunks but a later
step (merge, save, or formatter) crashed.

Usage:
    python -m pipeline.recover_chunks \\
        --chunks-dir   "AI Pipeline Output/chunks" \\
        --output       "AI Pipeline Output/chronology_doc.json" \\
        --name         "Jon Witting" \\
        --doi          "03/08/2022 and 02/11/2025"

The chunks directory should contain `chunk_000.json`, `chunk_001.json`, ...
one per chunk as written by `generate_medsum_chronology` when
`chunk_checkpoint_dir` is provided.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from pipeline.stage2_medsum_chronology import _merge_chronology_docs

log = logging.getLogger(__name__)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--chunks-dir", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--name", default="")
    p.add_argument("--dob", default="")
    p.add_argument("--doi", default="")
    p.add_argument("--injury", default="")
    p.add_argument("--contact", default="Marc")
    args = p.parse_args()

    chunks_dir = Path(args.chunks_dir)
    files = sorted(chunks_dir.glob("chunk_*.json"))
    if not files:
        log.error("No chunk_*.json files in %s", chunks_dir)
        return 2

    docs = []
    for f in files:
        try:
            with open(f) as fh:
                docs.append(json.load(fh))
        except Exception as e:
            log.warning("Skip %s (%s)", f.name, e)

    log.info("Loaded %d chunks from %s", len(docs), chunks_dir)

    patient_info = {
        "name": args.name, "dob": args.dob, "doi": args.doi,
        "injury": args.injury, "contact_first_name": args.contact,
    }
    merged = _merge_chronology_docs(docs, patient_info)

    with open(args.output, "w") as f:
        json.dump(merged, f, indent=2, default=str)
    log.info("Wrote %s (%d encounters)",
             args.output, len(merged.get("encounters", [])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

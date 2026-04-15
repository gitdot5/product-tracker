"""
Stage 2 — MedSum-schema Chronology Generator.

Produces a `ChronologyDoc` JSON (see `stage5_schema.py`) from raw extracted
medical record text. This is the single AI stage that drives all four Stage 5
formatters (Merged, Hyperlinked, Delivery Note, Medical Chronology).

Two modes:

1. **Direct**: takes the raw OCR'd/extracted text + patient metadata, calls
   Claude with the `medsum_chronology_system.txt` system prompt, returns a
   ChronologyDoc JSON. Suitable for cases under ~200K tokens (fits in one call).

2. **Chunked**: same as `pipeline.chronology._anthropic_chunked` but emits
   partial ChronologyDoc JSON per chunk and merges results. Reuses the retry
   logic from `pipeline.chronology` (`_retry_with_backoff`) so overloaded_error
   is handled.

Backends:
- Anthropic direct (API key) — for dev/testing
- AWS Bedrock (Claude Sonnet) — for HIPAA production

Outputs a ChronologyDoc dict ready for `pipeline.stage5_{merge,hyperlink,
delivery_note,chronology_docx}`.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict
from pathlib import Path
from typing import Dict, List, Optional

# Auto-load .env from the Code folder so CLI usage picks up ANTHROPIC_API_KEY
# without requiring the caller to import config.py first.
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent.parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path, override=False)
    else:
        load_dotenv(override=False)  # fall back to cwd / shell env
except ImportError:
    pass

from pipeline.helpers import read_prompt, extract_json_from_text
from pipeline.stage5_schema import ChronologyDoc, from_dict

log = logging.getLogger(__name__)


# ── Prompt assembly ────────────────────────────────────────────────────────

def _build_user_prompt(full_text: str, patient_info: dict,
                       *, chunk_index: int = 1, chunk_total: int = 1) -> str:
    """Wrap raw extracted medical text with case-level metadata.

    For chunked mode (chunk_total > 1), the prompt tells Claude to emit only
    new information observed in THIS chunk. Static sections (injury_report,
    patient_history, general_instructions, case_focus) should be emitted only
    when the chunk contains supporting evidence — otherwise leave them empty.
    The merge function in `_merge_chronology_docs` unions lists, keeps the
    longest text per patient-history line, and first-non-empty wins for
    scalars, so partial docs compose cleanly.
    """
    from datetime import date
    name = patient_info.get("name", "Unknown Patient")
    dob = patient_info.get("dob", "")
    doi = patient_info.get("doi", "")
    injury = patient_info.get("injury", "")
    contact = patient_info.get("contact_first_name", "Marc")

    chunk_note = ""
    if chunk_total > 1:
        chunk_note = (
            f"\nCHUNK CONTEXT: This is chunk {chunk_index} of {chunk_total}.\n"
            "  * Emit encounters, missing_records, flow_of_events ONLY for "
            "content visible in THIS chunk's text.\n"
            "  * For static sections (injury_report, patient_history, "
            "general_instructions, case_focus): populate only if this chunk "
            "contains supporting evidence; otherwise emit empty defaults "
            "(empty arrays / null pdf_refs / \"Not available.\" text).\n"
            "  * Do NOT duplicate encounters across chunks \u2014 each encounter "
            "appears in exactly one chunk (the one containing its source page).\n"
        )

    header = (
        f"TODAY'S DATE: {date.today().isoformat()}\n"
        f"PATIENT NAME: {name}\n"
        f"PATIENT DOB: {dob}\n"
        f"DATE(S) OF INJURY: {doi}\n"
        f"INJURY / CASE FOCUS: {injury}\n"
        f"CONTACT FIRST NAME (for Delivery Note greeting): {contact}\n"
        f"{chunk_note}\n"
        "MEDICAL RECORDS TEXT (verbatim OCR / extraction):\n"
    )
    return header + full_text + (
        "\n\n---\n"
        "Produce the ChronologyDoc JSON now. "
        "Remember: every clinical detail must be verbatim, every entry must "
        "carry a pdf_ref page number, dates in MM/DD/YYYY, encounters sorted "
        "chronologically. Output ONLY the JSON object."
    )


# ── Anthropic direct backend ───────────────────────────────────────────────

def _anthropic_call(client, *, model: str, system_prompt: str, user_prompt: str,
                    max_tokens: int, temperature: float,
                    retry_label: str = "stage2-call") -> dict:
    """Single non-chunked Anthropic call, streaming to avoid timeout.

    If the response stops at `max_tokens` (truncated) OR JSON parsing fails,
    we retry up to 2 additional times, each time doubling the max_tokens
    budget (up to 64K). This handles dense chunks that need more room.
    """
    from pipeline.chronology import _retry_with_backoff

    # Enable extended output tokens (up to 64K) via the public beta header.
    extra_headers = {"anthropic-beta": "output-128k-2025-02-19"}

    def _do_stream(token_budget: int):
        parts: List[str] = []
        with client.messages.stream(
            model=model,
            max_tokens=token_budget,
            temperature=temperature,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
            extra_headers=extra_headers,
        ) as stream:
            for txt in stream.text_stream:
                parts.append(txt)
            final = stream.get_final_message()
        return "".join(parts), final.stop_reason

    effective_max = max_tokens
    for attempt in range(3):
        raw, stop_reason = _retry_with_backoff(
            lambda budget=effective_max: _do_stream(budget),
            label=f"{retry_label}(max={effective_max})",
        )
        log.info("Anthropic response: %d chars, stop_reason=%s",
                 len(raw), stop_reason)
        try:
            return _parse_json(raw)
        except ValueError as exc:
            if attempt < 2 and (stop_reason == "max_tokens"
                                 or "char" in str(exc).lower()):
                # Truncated or malformed — retry with more room.
                new_max = min(effective_max * 2, 64000)
                log.warning("Response truncated/invalid at max_tokens=%d "
                            "(stop=%s, err=%s). Retrying with max_tokens=%d.",
                            effective_max, stop_reason, str(exc)[:120], new_max)
                effective_max = new_max
                continue
            raise


def _parse_json(raw: str) -> dict:
    """Extract JSON object from model output; raises ValueError if invalid."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Model may have wrapped in markdown fences; try extracting.
    try:
        return extract_json_from_text(raw)
    except Exception as exc:
        raise ValueError(f"Stage 2 model output did not contain valid JSON: {exc}") from exc


# ── Chunked merge logic ────────────────────────────────────────────────────

def _merge_chronology_docs(docs: List[dict], patient_info: dict) -> dict:
    """Merge N partial ChronologyDocs (one per text chunk) into one.

    Strategy:
    - patient, general_instructions, case_focus: take from FIRST chunk that has them
    - injury_report: union of diagnoses / treatments, take description from first
    - flow_of_events: concatenate in chunk order
    - patient_history: take the most-populated version of each of the 5 lines
    - encounters: concatenate, then sort by `date` ascending
    - causation/disability: concatenate
    - missing_records: concatenate (dedupe by pdf_reference)
    - no_missing_records: AND of all chunks
    """
    if not docs:
        return {}
    if len(docs) == 1:
        return docs[0]

    merged: Dict = {
        "patient": docs[0].get("patient", {"name": patient_info.get("name", "")}),
        "general_instructions": [],
        "injury_report": {
            "prior_injury_details": [],
            "dates_of_injury": [],
            "incident_type": "",
            "description": "",
            "diagnoses": [],
            "treatments": {"medications": [], "procedures": [], "therapy": [], "imaging": [], "labs": []},
        },
        "flow_of_events": [],
        "patient_history": {
            "past_medical": {"text": "Not available.", "pdf_ref": None},
            "surgical": {"text": "Not available.", "pdf_ref": None},
            "family": {"text": "Not available.", "pdf_ref": None},
            "social": {"text": "Not available.", "pdf_ref": None},
            "allergy": {"text": "Not available.", "pdf_ref": None},
        },
        "encounters": [],
        "case_focus": "",
        "causation_statements": [],
        "disability_statements": [],
        "missing_records": [],
        "no_missing_records": True,
    }

    for i, d in enumerate(docs):
        # General instructions: take from first non-empty chunk
        if not merged["general_instructions"] and d.get("general_instructions"):
            merged["general_instructions"] = d["general_instructions"]

        # Injury report — union of lists; take first non-empty scalars
        ir = d.get("injury_report", {})
        if ir:
            mir = merged["injury_report"]
            for key in ("prior_injury_details", "dates_of_injury", "diagnoses"):
                for item in ir.get(key, []) or []:
                    if item and item not in mir[key]:
                        mir[key].append(item)
            if not mir["incident_type"]:
                mir["incident_type"] = ir.get("incident_type", "") or ""
            if not mir["description"]:
                mir["description"] = ir.get("description", "") or ""
            tr = ir.get("treatments", {}) or {}
            for key in ("medications", "procedures", "therapy", "imaging", "labs"):
                for item in tr.get(key, []) or []:
                    if item and item not in mir["treatments"][key]:
                        mir["treatments"][key].append(item)

        # Flow of events — concatenate preserving order
        for entry in d.get("flow_of_events", []) or []:
            merged["flow_of_events"].append(entry)

        # Patient history — prefer the longest text per line
        ph = d.get("patient_history", {}) or {}
        for key in ("past_medical", "surgical", "family", "social", "allergy"):
            cur = merged["patient_history"][key]
            new = ph.get(key, {}) or {}
            new_text = (new.get("text") or "").strip()
            cur_text = (cur.get("text") or "").strip()
            if new_text and (cur_text in ("", "Not available.")
                             or len(new_text) > len(cur_text)):
                merged["patient_history"][key] = {
                    "text": new_text,
                    "pdf_ref": new.get("pdf_ref"),
                }

        # Encounters — concatenate
        for enc in d.get("encounters", []) or []:
            merged["encounters"].append(enc)

        # Case focus — take the longest version
        cf = d.get("case_focus", "") or ""
        if cf and len(cf) > len(merged["case_focus"]):
            merged["case_focus"] = cf

        # Causation / disability / missing records
        for enc in d.get("causation_statements", []) or []:
            if enc not in merged["causation_statements"]:
                merged["causation_statements"].append(enc)
        for enc in d.get("disability_statements", []) or []:
            if enc not in merged["disability_statements"]:
                merged["disability_statements"].append(enc)

        existing_refs = {m.get("pdf_reference") for m in merged["missing_records"]}
        for mr in d.get("missing_records", []) or []:
            if mr.get("pdf_reference") not in existing_refs:
                merged["missing_records"].append(mr)
                existing_refs.add(mr.get("pdf_reference"))

        if not d.get("no_missing_records", True):
            merged["no_missing_records"] = False

    # Sort encounters by date ascending (robust to MM/DD/YYYY or ranges)
    def _date_key(enc):
        d = (enc.get("date") or "").split("-")[0].strip()
        # MM/DD/YYYY → sortable ISO
        try:
            m, day, y = d.split("/")
            return f"{y}-{m.zfill(2)}-{day.zfill(2)}"
        except Exception:
            return d

    merged["encounters"].sort(key=_date_key)

    # If any missing_records got populated, flip no_missing_records off.
    if merged["missing_records"]:
        merged["no_missing_records"] = False

    return merged


# ── Public API ─────────────────────────────────────────────────────────────

def generate_medsum_chronology(
    full_text: str,
    patient_info: dict,
    api_key: Optional[str] = None,
    *,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 24000,          # ~4-6 min per chunk; auto-retries at 48K/64K on truncation
    temperature: float = 0.1,
    chunk_size_chars: int = 180_000,  # ~45K tokens — dense chunks stay under 24K output
    chunk_overlap_chars: int = 10_000,
    max_concurrent: int = 3,
) -> dict:
    """Produce a ChronologyDoc dict from extracted medical record text.

    Automatically decides between single-call (small cases) and chunked merge
    (large cases). Returns a plain dict matching the ChronologyDoc schema.
    """
    import anthropic
    from pipeline.chronology import _split_with_overlap

    system_prompt = read_prompt("medsum_chronology_system.txt")
    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    if len(full_text) <= chunk_size_chars:
        user_prompt = _build_user_prompt(full_text, patient_info,
                                          chunk_index=1, chunk_total=1)
        return _anthropic_call(
            client, model=model, system_prompt=system_prompt,
            user_prompt=user_prompt, max_tokens=max_tokens,
            temperature=temperature,
        )

    # Chunked mode
    chunks = _split_with_overlap(full_text, chunk_size_chars, chunk_overlap_chars)
    log.info("Stage 2 chunking: %d chunks, max_concurrent=%d",
             len(chunks), max_concurrent)

    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading

    sem = threading.Semaphore(max_concurrent)
    results: Dict[int, dict] = {}
    lock = threading.Lock()

    def _process(i, chunk):
        prompt = _build_user_prompt(chunk, patient_info,
                                     chunk_index=i, chunk_total=len(chunks))
        with sem:
            doc = _anthropic_call(
                client, model=model, system_prompt=system_prompt,
                user_prompt=prompt, max_tokens=max_tokens,
                temperature=temperature,
                retry_label=f"stage2-chunk-{i}",
            )
        with lock:
            results[i] = doc
        log.info("  chunk %d/%d done (%d encounters)",
                 i, len(chunks), len(doc.get("encounters", [])))
        return i, doc

    with ThreadPoolExecutor(max_workers=max_concurrent) as pool:
        futures = [pool.submit(_process, i, c) for i, c in enumerate(chunks, 1)]
        for fut in as_completed(futures):
            fut.result()  # propagate exceptions

    ordered = [results[i] for i in sorted(results)]
    return _merge_chronology_docs(ordered, patient_info)


# ── Transformer: existing pipeline chronology → ChronologyDoc ──────────────

def transform_legacy_chronology(
    legacy: dict,
    patient_info: dict,
) -> dict:
    """Map the existing pipeline chronology.py output to a ChronologyDoc.

    The existing `_anthropic_chunked` emits:
      {
        "injury_report": {...},
        "patient_history": {...},
        "encounters": [...],
        "other_records": [...],
        "missing_records": [...],
      }
    which overlaps our ChronologyDoc but misses `flow_of_events`,
    `case_focus`, `causation_statements`, `disability_statements`,
    `general_instructions`. This transformer fills what it can and leaves
    the rest empty — suitable as a compatibility shim when re-running old
    JSON through Stage 5 formatters.
    """
    name = (legacy.get("patient", {}) or {}).get("name") or patient_info.get("name", "")
    dois = patient_info.get("doi", "")
    dois_list = [d.strip() for d in dois.replace("&", "and").split("and") if d.strip()] if dois else []

    encounters = legacy.get("encounters", []) or []
    # Build a minimal flow_of_events by grouping encounters per provider/date.
    flow: List[dict] = []
    seen_groups: set = set()
    for enc in encounters:
        provider = enc.get("provider") or enc.get("facility") or ""
        date = enc.get("date") or ""
        key = (provider, date)
        if key in seen_groups:
            continue
        seen_groups.add(key)
        flow.append({
            "provider_group": provider,
            "date_range": date,
            "summary": enc.get("summary") or enc.get("note") or "",
            "reviewer_comment": None,
        })

    # Flatten legacy encounters into ChronologyDoc Encounter structure.
    out_encounters = []
    last_facility = None
    for enc in encounters:
        facility = enc.get("facility") or enc.get("provider") or ""
        group_header = facility != last_facility
        last_facility = facility
        out_encounters.append({
            "group_header": group_header,
            "group_header_text": f"{facility} / {enc.get('date','')}" if group_header else None,
            "date": enc.get("date", ""),
            "facility": facility,
            "providers": enc.get("providers") or (
                [enc.get("provider")] if enc.get("provider") else []
            ),
            "medical_events": enc.get("note") or enc.get("summary") or "",
            "pdf_ref": enc.get("page_ref") or enc.get("pdf_ref") or "",
        })

    return {
        "patient": {
            "name": name,
            "dob": patient_info.get("dob") or None,
            "contact_first_name": patient_info.get("contact_first_name", "Marc"),
        },
        "general_instructions": [],
        "injury_report": legacy.get("injury_report") or {
            "prior_injury_details": [],
            "dates_of_injury": dois_list,
            "incident_type": "",
            "description": patient_info.get("injury", ""),
            "diagnoses": [],
            "treatments": {"medications": [], "procedures": [], "therapy": [], "imaging": [], "labs": []},
        },
        "flow_of_events": flow,
        "patient_history": legacy.get("patient_history") or {
            "past_medical": {"text": "Not available.", "pdf_ref": None},
            "surgical": {"text": "Not available.", "pdf_ref": None},
            "family": {"text": "Not available.", "pdf_ref": None},
            "social": {"text": "Not available.", "pdf_ref": None},
            "allergy": {"text": "Not available.", "pdf_ref": None},
        },
        "encounters": out_encounters,
        "case_focus": "",
        "causation_statements": [],
        "disability_statements": [],
        "missing_records": legacy.get("missing_records") or [],
        "no_missing_records": not bool(legacy.get("missing_records")),
    }


# ── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    import argparse
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--text", required=True,
                   help="Path to extracted medical records text (Stage 1 output)")
    p.add_argument("--name", required=True)
    p.add_argument("--dob", default="")
    p.add_argument("--doi", default="")
    p.add_argument("--injury", default="")
    p.add_argument("--contact", default="Marc",
                   help="Contact first name for Delivery Note greeting")
    p.add_argument("--output", required=True,
                   help="Output ChronologyDoc JSON")
    p.add_argument("--model", default="claude-sonnet-4-20250514")
    p.add_argument("--api-key", default=None,
                   help="Anthropic API key (overrides ANTHROPIC_API_KEY env)")
    args = p.parse_args()

    with open(args.text) as f:
        full_text = f.read()

    doc = generate_medsum_chronology(
        full_text=full_text,
        patient_info={
            "name": args.name,
            "dob": args.dob,
            "doi": args.doi,
            "injury": args.injury,
            "contact_first_name": args.contact,
        },
        api_key=args.api_key or os.getenv("ANTHROPIC_API_KEY"),
        model=args.model,
    )
    with open(args.output, "w") as f:
        json.dump(doc, f, indent=2)
    print(f"Wrote ChronologyDoc JSON: {args.output}")
    print(f"Encounters: {len(doc.get('encounters', []))}")
    print(f"Diagnoses:  {len(doc.get('injury_report', {}).get('diagnoses', []))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

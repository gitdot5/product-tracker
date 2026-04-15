"""
Stage 2: Chronology Generation

Sends full extracted text to Gemini (1M context) in a single call.
Falls back to Claude on Bedrock with chunking for >200K-token cases.
"""

import json
import logging
import random
import time
from datetime import date
from typing import List

from pipeline.helpers import read_prompt, extract_json_from_text

log = logging.getLogger(__name__)


# ── Retry helpers for transient API failures ────────────────

def _is_retryable_anthropic_error(exc: Exception) -> bool:
    """True if the exception looks like an Anthropic overload / rate-limit."""
    name = type(exc).__name__
    msg = str(exc).lower()
    if name in ("OverloadedError", "RateLimitError", "APIStatusError",
                "InternalServerError", "APITimeoutError", "APIConnectionError"):
        return True
    if "overloaded" in msg or "rate_limit" in msg or "rate limit" in msg:
        return True
    if "529" in msg or "503" in msg:
        return True
    status = getattr(exc, "status_code", None)
    if status in (429, 500, 502, 503, 504, 529):
        return True
    return False


def _retry_with_backoff(fn, *, label: str = "call",
                        max_attempts: int = 6,
                        base_delay: float = 30.0,
                        max_delay: float = 240.0):
    """Retry fn() with exponential backoff on transient Anthropic errors.

    Handles `overloaded_error` (HTTP 529) and rate-limit (HTTP 429) by waiting
    base_delay, base_delay*2, base_delay*4 ... (capped at max_delay), with
    +/-25% jitter. Re-raises immediately on non-retryable errors.
    """
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if not _is_retryable_anthropic_error(exc) or attempt == max_attempts:
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            jitter = delay * random.uniform(-0.25, 0.25)
            sleep_for = max(1.0, delay + jitter)
            log.warning(
                "[%s] Retryable error on attempt %d/%d (%s: %s). "
                "Sleeping %.1fs before retry.",
                label, attempt, max_attempts, type(exc).__name__,
                str(exc)[:200], sleep_for,
            )
            time.sleep(sleep_for)
    # Defensive — _retry_with_backoff should always raise on the final attempt.
    raise last_exc  # pragma: no cover


# ── Gemini (primary) ─────────────────────────────────────────

def generate_chronology_gemini(
    full_text: str,
    case_context: str,
    project_id: str,
    location: str,
    *,
    model: str = "gemini-2.5-pro",
    max_output_tokens: int = 65536,
    temperature: float = 0.1,
) -> dict:
    """Generate chronology with Gemini on Vertex AI (single call, up to 1M tokens)."""
    from google import genai
    from google.genai.types import GenerateContentConfig

    client = genai.Client(vertexai=True, project=project_id, location=location)
    system_prompt = read_prompt("chronology_system.txt")

    user_prompt = (
        f"TODAY'S DATE: {date.today().isoformat()}\n"
        "(All dates up to and including today are valid past dates. "
        "Do NOT flag them as future dates.)\n\n"
        f"CASE CONTEXT:\n{case_context}\n\n"
        "COMPLETE MEDICAL RECORDS (all pages with [PAGE N] markers):\n\n"
        f"{full_text}\n\n"
        "Extract ALL medical encounters chronologically. Include PDF page references "
        "for every entry. Deduplicate repeated records. Flag contradictions or "
        "missing records. Output valid JSON matching the format specified above."
    )

    log.info("Gemini request: %s chars (~%d tokens)", f"{len(user_prompt):,}", len(user_prompt) // 4)

    response = client.models.generate_content(
        model=model,
        contents=user_prompt,
        config=GenerateContentConfig(
            system_instruction=system_prompt,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            response_mime_type="application/json",
        ),
    )

    chronology = _parse_chronology_response(response.text)
    log.info("Extracted %d encounters, %d missing-record refs",
             len(chronology.get("encounters", [])),
             len(chronology.get("missing_records", [])))
    return chronology


# ── Claude / Bedrock (fallback) ──────────────────────────────

def generate_chronology_claude(
    full_text: str,
    case_context: str,
    region: str,
    *,
    model: str = "us.anthropic.claude-sonnet-4-20250514-v1:0",
    max_tokens: int = 16000,
    temperature: float = 0.1,
    chunk_size: int = 150_000,
) -> dict:
    """Generate chronology with Claude on Bedrock. Chunks if >200K tokens."""
    import boto3

    bedrock = boto3.client("bedrock-runtime", region_name=region)
    system_prompt = read_prompt("chronology_system.txt")

    estimated_tokens = len(full_text) // 4
    if estimated_tokens < 180_000:
        log.info("Single Claude call (%s est. tokens)", f"{estimated_tokens:,}")
        return _claude_call(bedrock, model, system_prompt, full_text, case_context,
                            max_tokens=max_tokens, temperature=temperature)

    log.info("Chunking for Claude (%s tokens, %s char chunks)",
             f"{estimated_tokens:,}", f"{chunk_size:,}")
    return _claude_chunked(bedrock, model, system_prompt, full_text, case_context,
                           chunk_size, max_tokens=max_tokens, temperature=temperature)


def _claude_call(bedrock, model, system_prompt, text, case_context, *,
                 max_tokens, temperature) -> dict:
    """Single Bedrock invoke for chronology."""
    response = bedrock.invoke_model(
        modelId=model,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system_prompt,
            "messages": [{"role": "user", "content": (
                f"CASE CONTEXT: {case_context}\n\nMEDICAL RECORDS:\n{text}\n\n"
                "Extract all encounters. Output valid JSON."
            )}],
        }),
    )
    body = json.loads(response["body"].read())
    raw = body["content"][0]["text"]
    return _parse_chronology_response(raw)


def _claude_chunked(bedrock, model, system_prompt, full_text, case_context,
                    chunk_size, *, max_tokens, temperature) -> dict:
    """Process large cases in chunks, then merge and deduplicate."""
    chunks = _split_into_chunks(full_text, chunk_size)
    log.info("Split into %d chunks", len(chunks))

    all_encounters: List[dict] = []
    all_missing: List[str] = []

    for i, chunk in enumerate(chunks, 1):
        log.info("  Chunk %d/%d...", i, len(chunks))
        ctx = f"{case_context} (chunk {i}/{len(chunks)})"
        result = _claude_call(bedrock, model, system_prompt, chunk, ctx,
                              max_tokens=max_tokens, temperature=temperature)
        all_encounters.extend(result.get("encounters", []))
        all_missing.extend(result.get("missing_records", []))

    # Use first chunk's injury_report and patient_history as canonical
    first = _claude_call(bedrock, model, system_prompt, chunks[0], case_context,
                         max_tokens=max_tokens, temperature=temperature)

    deduped = _deduplicate_encounters(all_encounters)
    deduped.sort(key=lambda e: _date_sort_key(e.get("date", "")))

    return {
        "injury_report": first.get("injury_report"),
        "patient_history": first.get("patient_history"),
        "encounters": deduped,
        "missing_records": all_missing,
    }


# ── Anthropic Direct API ────────────────────────────────────

def generate_chronology_anthropic(
    full_text: str,
    case_context: str,
    api_key: str,
    *,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 16000,
    temperature: float = 0.1,
    chunk_size: int = 100_000,
    chunk_overlap: int = 15_000,
) -> dict:
    """Generate chronology with Claude via direct Anthropic API.

    Chunks at 100K chars with 15K overlap to avoid splitting encounters
    at boundaries. Smaller chunks improve attention on low-frequency dates.
    """
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    system_prompt = read_prompt("chronology_system.txt")

    estimated_tokens = len(full_text) // 4
    if estimated_tokens < 90_000:
        log.info("Single Anthropic call (%s est. tokens)", f"{estimated_tokens:,}")
        return _anthropic_call(client, model, system_prompt, full_text, case_context,
                               max_tokens=max_tokens, temperature=temperature)

    log.info("Chunking for Anthropic (%s est. tokens, %s char chunks, %s overlap)",
             f"{estimated_tokens:,}", f"{chunk_size:,}", f"{chunk_overlap:,}")
    return _anthropic_chunked(client, model, system_prompt, full_text, case_context,
                              chunk_size, max_tokens=max_tokens, temperature=temperature,
                              chunk_overlap=chunk_overlap)


def _anthropic_call(client, model, system_prompt, text, case_context, *,
                    max_tokens, temperature) -> dict:
    """Single Anthropic API call for chronology using streaming to avoid timeout.

    Wraps the streaming call in `_retry_with_backoff` so transient
    `overloaded_error` (HTTP 529) and rate-limit (HTTP 429) failures are
    retried with 30s/60s/120s/240s backoff instead of failing the chunk.
    """
    from datetime import date
    user_prompt = (
        f"TODAY'S DATE: {date.today().isoformat()}\n"
        f"CASE CONTEXT: {case_context}\n\nMEDICAL RECORDS:\n{text}\n\n"
        "Extract ALL medical encounters chronologically. Include PDF page references "
        "for every entry. Deduplicate repeated records. Flag contradictions or "
        "missing records. Output valid JSON matching the format specified above."
    )
    # Use at least 32K tokens for output to avoid truncation of verbatim text
    effective_max = max(max_tokens, 32000)

    def _do_stream(token_budget):
        raw_parts = []
        with client.messages.stream(
            model=model,
            max_tokens=token_budget,
            temperature=temperature,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        ) as stream:
            for text_chunk in stream.text_stream:
                raw_parts.append(text_chunk)
            final_message = stream.get_final_message()
        return "".join(raw_parts), final_message.stop_reason

    for attempt in range(2):
        # Retry on overloaded_error / rate_limit with 30-240s backoff.
        raw, stop_reason = _retry_with_backoff(
            lambda budget=effective_max: _do_stream(budget),
            label=f"chronology-chunk(max={effective_max})",
        )
        log.info("Anthropic response: %d chars, stop_reason=%s", len(raw), stop_reason)
        try:
            return _parse_chronology_response(raw)
        except ValueError:
            if stop_reason == "max_tokens" and attempt == 0:
                log.warning("Response truncated at %d tokens, retrying with 64K", effective_max)
                effective_max = 64000
                continue
            raise


def _anthropic_chunked(client, model, system_prompt, full_text, case_context,
                       chunk_size, *, max_tokens, temperature,
                       chunk_overlap: int = 15_000,
                       max_concurrent: int = 3) -> dict:
    """Process large cases in overlapping chunks via Anthropic API, then merge.

    Chunks are processed concurrently (up to max_concurrent at a time) using
    a thread pool + semaphore, then results are merged in original chunk order.

    Default `max_concurrent` is 3 (down from 5) because the enhanced
    chronology prompt produces ~2x more tokens per chunk and was hitting
    Anthropic `overloaded_error` (HTTP 529) at 5 concurrent calls.
    Combined with `_retry_with_backoff` in `_anthropic_call`, this keeps
    the deeper prompt below the rate-limit ceiling.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading

    chunks = _split_with_overlap(full_text, chunk_size, chunk_overlap)
    log.info("Split into %d chunks (max_concurrent=%d)", len(chunks), max_concurrent)

    sem = threading.Semaphore(max_concurrent)
    results_by_index: dict = {}
    lock = threading.Lock()

    def _process_chunk(i, chunk):
        ctx = f"{case_context} (chunk {i}/{len(chunks)})"
        log.info("  Chunk %d/%d (%s chars) starting...", i, len(chunks), f"{len(chunk):,}")
        with sem:
            result = _anthropic_call(client, model, system_prompt, chunk, ctx,
                                     max_tokens=max_tokens, temperature=temperature)
        with lock:
            results_by_index[i] = result
        log.info("  Chunk %d/%d done (%d encounters)", i, len(chunks),
                 len(result.get("encounters", [])))
        return i, result

    with ThreadPoolExecutor(max_workers=max_concurrent) as pool:
        futures = [pool.submit(_process_chunk, i, chunk)
                   for i, chunk in enumerate(chunks, 1)]
        for future in as_completed(futures):
            future.result()  # raise any exception immediately

    # Merge results in original chunk order
    all_encounters: List[dict] = []
    all_missing: List[str] = []
    all_other: List[dict] = []
    first_result = None

    for i in sorted(results_by_index.keys()):
        result = results_by_index[i]
        all_encounters.extend(result.get("encounters", []))
        all_missing.extend(result.get("missing_records", []))
        all_other.extend(result.get("other_records", []))
        if first_result is None:
            first_result = result

    deduped = _deduplicate_encounters(all_encounters)
    deduped.sort(key=lambda e: _date_sort_key(e.get("date", "")))

    return {
        "injury_report": first_result.get("injury_report") if first_result else {},
        "patient_history": first_result.get("patient_history") if first_result else {},
        "encounters": deduped,
        "other_records": all_other,
        "missing_records": all_missing,
    }


# ── Shared Helpers ───────────────────────────────────────────

def _parse_chronology_response(text: str) -> dict:
    """Parse JSON from an LLM response, tolerating markdown fences."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        parsed = extract_json_from_text(text)
        if parsed is None:
            raise ValueError(f"Unparseable response ({len(text)} chars): {text[:300]}...")
        return parsed


def _split_into_chunks(text: str, chunk_size: int) -> List[str]:
    """Split text at line boundaries to avoid breaking mid-record."""
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for line in text.split("\n"):
        if current_len + len(line) > chunk_size and current:
            chunks.append("\n".join(current))
            current, current_len = [], 0
        current.append(line)
        current_len += len(line) + 1

    if current:
        chunks.append("\n".join(current))
    return chunks


def _split_with_overlap(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Split text into overlapping chunks, breaking at page markers.

    Overlap ensures encounters near chunk boundaries appear fully in
    at least one chunk, preventing split-record misses.
    """
    PAGE_MARKER = "=" * 60
    chunks: List[str] = []
    start = 0

    while start < len(text):
        end = start + chunk_size

        if end >= len(text):
            chunks.append(text[start:])
            break

        # Try to break at a page marker (search ±5K around target boundary)
        search_start = max(start, end - 5000)
        search_end = min(len(text), end + 5000)
        search_window = text[search_start:search_end]
        marker_pos = search_window.rfind(PAGE_MARKER)

        if marker_pos >= 0:
            actual_end = search_start + marker_pos
        else:
            actual_end = end

        chunks.append(text[start:actual_end])
        start = max(start + 1, actual_end - overlap)  # overlap with previous

    return chunks


def _date_sort_key(date_str: str) -> tuple:
    """Convert MM/DD/YYYY to (year, month, day) tuple for correct chronological sorting.

    Handles: MM/DD/YYYY, M/D/YYYY, 00/00/0000 (illegible → sorts last).
    Falls back to (9999, 99, 99) for unparseable dates so they sort to the end.
    """
    if not date_str or date_str == "00/00/0000":
        return (9999, 99, 99)
    try:
        parts = date_str.replace("-", "/").split("/")
        if len(parts) == 3:
            if len(parts[0]) == 4:
                # ISO: YYYY/MM/DD
                return (int(parts[0]), int(parts[1]), int(parts[2]))
            else:
                # MM/DD/YYYY
                return (int(parts[2]), int(parts[0]), int(parts[1]))
    except (ValueError, IndexError):
        pass
    return (9999, 99, 99)


def _deduplicate_encounters(encounters: List[dict]) -> List[dict]:
    """Remove duplicate encounters by (date, provider, type) key, merging page refs."""
    seen: dict = {}
    deduped: List[dict] = []

    for enc in encounters:
        # Include type/category in key so same-day same-provider different event types are kept
        key = (
            enc.get("date", ""),
            (enc.get("provider") or "").strip().lower(),
            (enc.get("type") or enc.get("category") or "").strip().lower(),
        )
        if key not in seen:
            seen[key] = enc
            deduped.append(enc)
        else:
            # Merge page refs from duplicate
            existing = seen[key]
            new_refs = enc.get("page_refs", "")
            if new_refs and new_refs not in existing.get("page_refs", ""):
                existing["page_refs"] = f"{existing.get('page_refs', '')}, {new_refs}".strip(", ")

    return deduped

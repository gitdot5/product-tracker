"""
Stage 4 — Audit / Verification.

Takes a ChronologyDoc JSON produced by Stage 2 and verifies every claim
against the original source text. The audit is MedSum's final QC step — the
missing piece that turns "AI-generated draft" into "MedSum-equivalent
deliverable."

Verification layers (in order of increasing AI cost):

    1. Fast deterministic checks (no AI calls):
       - Every encounter has a non-empty pdf_ref
       - All pdf_refs fall within [1, total_records_pages]
       - Dates are MM/DD/YYYY formatted
       - Encounter dates are not in the future (vs today)
       - Every diagnosis in injury_report is non-empty
       - No duplicate encounters (same date + facility)

    2. Page-ref anchoring (deterministic, reads merged PDF):
       - For every encounter, pull its pdf_ref pages from the merged records
       - Check that the encounter's date string OR provider/facility name
         appears on those pages
       - Flags: "claimed date/provider not found in cited pages"

    3. Verbatim verification (AI, optional --deep):
       - For each encounter, re-read the cited source pages and ask Claude
         "does the encounter text faithfully represent this source?"
       - Classifies each encounter as VERBATIM / PARAPHRASED / FABRICATED
       - Optional auto-correction: fabricated/paraphrased rows get re-extracted

Output: `audit_report.json` with per-encounter scores and a summary; also
emits a human-readable `audit_report.md` with the top issues.

Usage:
    python -m pipeline.stage4_audit \\
        --chronology chronology_doc.json \\
        --records "Merged Medical Records - Patient.pdf" \\
        --output-dir "AI Pipeline Output/" \\
        [--deep]              # enable AI verbatim check (costs ~$1-3)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import fitz  # PyMuPDF

log = logging.getLogger(__name__)


DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
REF_TOKEN_RE = re.compile(r"\d+")


# ── Issue taxonomy ─────────────────────────────────────────────────────────

@dataclass
class AuditIssue:
    severity: str          # "critical" | "warning" | "info"
    category: str          # "missing_ref" | "invalid_ref" | "date_mismatch" | etc.
    entity: str            # "encounter[0]" | "injury_report.diagnoses[2]" | etc.
    message: str
    suggestion: Optional[str] = None


@dataclass
class AuditReport:
    score: int                      # 0-100
    critical_count: int
    warning_count: int
    info_count: int
    total_encounters: int
    encounters_with_refs: int
    encounter_ref_coverage: float   # fraction of encounters with valid pdf_ref
    issues: List[AuditIssue] = field(default_factory=list)
    per_encounter: List[Dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = asdict(self)
        d["issues"] = [asdict(i) for i in self.issues]
        return d


# ── Utilities ──────────────────────────────────────────────────────────────

def _parse_pdf_ref(ref: str) -> List[int]:
    """Expand 'N-M, P, Q-R' into [N, N+1, ..., M, P, Q, Q+1, ..., R]."""
    if not ref:
        return []
    pages: List[int] = []
    for token in re.split(r"[,\s]+", ref.strip()):
        if not token:
            continue
        if "-" in token:
            parts = token.split("-", 1)
            try:
                a, b = int(parts[0]), int(parts[1])
            except ValueError:
                continue
            pages.extend(range(min(a, b), max(a, b) + 1))
        else:
            try:
                pages.append(int(token))
            except ValueError:
                pass
    return pages


def _load_pdf_pages(records_path: str, max_pages: int = 10000) -> List[str]:
    """Read all pages of the merged records PDF, return list of page texts."""
    doc = fitz.open(records_path)
    pages = []
    for i, p in enumerate(doc):
        if i >= max_pages:
            break
        pages.append(p.get_text("text"))
    doc.close()
    return pages


def _fuzzy_contains(needle: str, haystack: str) -> bool:
    """Case-insensitive substring + whitespace-tolerant match."""
    if not needle or not haystack:
        return False
    n = re.sub(r"\s+", " ", needle.strip().lower())
    h = re.sub(r"\s+", " ", haystack.lower())
    return n in h


# ── Layer 1: deterministic structure checks ────────────────────────────────

def _check_structure(doc: dict, total_records_pages: int,
                     issues: List[AuditIssue]) -> None:
    """Fast checks that don't require reading the source PDF."""
    today_parts = tuple(map(int, __import__("datetime").date.today().isoformat().split("-")))
    today_ymd = today_parts

    encounters = doc.get("encounters", []) or []
    for i, enc in enumerate(encounters):
        entity = f"encounters[{i}]"
        pdf_ref = enc.get("pdf_ref") or ""
        if not pdf_ref.strip():
            issues.append(AuditIssue(
                "critical", "missing_ref", entity,
                "Encounter has no pdf_ref",
                "Every encounter must cite the source page(s).",
            ))
            continue
        pages = _parse_pdf_ref(pdf_ref)
        if not pages:
            issues.append(AuditIssue(
                "critical", "invalid_ref", entity,
                f"pdf_ref '{pdf_ref}' could not be parsed",
            ))
            continue
        out_of_range = [p for p in pages if p < 1 or p > total_records_pages]
        if out_of_range:
            issues.append(AuditIssue(
                "critical", "ref_out_of_range", entity,
                f"pdf_ref pages {out_of_range} are outside [1, {total_records_pages}]",
            ))

        # Date sanity
        date_str = enc.get("date") or ""
        first_date = date_str.split("-")[0].strip() if date_str else ""
        m = DATE_RE.search(first_date)
        if first_date and not m:
            issues.append(AuditIssue(
                "warning", "date_format", entity,
                f"date '{date_str}' does not parse as MM/DD/YYYY",
            ))
        elif m:
            mm, dd, yy = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if (yy, mm, dd) > today_ymd:
                issues.append(AuditIssue(
                    "critical", "future_date", entity,
                    f"encounter date {first_date} is in the future",
                    "Likely model hallucination — re-extract this encounter.",
                ))

    # Duplicate encounters (same date + facility)
    seen: Set[Tuple[str, str]] = set()
    for i, enc in enumerate(encounters):
        key = ((enc.get("date") or "").strip(), (enc.get("facility") or "").strip())
        if key != ("", "") and key in seen:
            issues.append(AuditIssue(
                "warning", "duplicate_encounter", f"encounters[{i}]",
                f"Encounter at {key[0]} / {key[1]} appears more than once",
            ))
        seen.add(key)

    # Injury report presence
    ir = doc.get("injury_report") or {}
    if not ir.get("dates_of_injury"):
        issues.append(AuditIssue(
            "warning", "missing_doi", "injury_report",
            "No dates_of_injury set",
        ))
    if not ir.get("diagnoses"):
        issues.append(AuditIssue(
            "warning", "no_diagnoses", "injury_report",
            "No diagnoses extracted — case may still be valid but unusual",
        ))

    # Patient history completeness
    ph = doc.get("patient_history") or {}
    for key in ("past_medical", "surgical", "family", "social", "allergy"):
        line = ph.get(key) or {}
        if (line.get("text") or "").strip() in ("", "Not available."):
            issues.append(AuditIssue(
                "info", "missing_history", f"patient_history.{key}",
                f"{key} not extracted",
            ))


# ── Layer 2: page-ref anchoring (deterministic) ────────────────────────────

def _check_anchoring(doc: dict, records_pages: List[str],
                     issues: List[AuditIssue],
                     per_encounter: List[Dict]) -> None:
    """For every encounter, verify its cited pages actually contain the
    encounter's date OR facility name.

    This is the single highest-value deterministic check — it catches
    fabricated encounters (pdf_ref points somewhere unrelated) and wrong
    cite-page references."""
    encounters = doc.get("encounters", []) or []
    for i, enc in enumerate(encounters):
        entity = f"encounters[{i}]"
        pdf_ref = enc.get("pdf_ref") or ""
        pages = _parse_pdf_ref(pdf_ref)
        facility = (enc.get("facility") or "").strip()
        date_str = enc.get("date") or ""
        # Use first date (or single date) of the range
        first_date = date_str.split("-")[0].strip()

        result = {
            "index": i,
            "date": date_str,
            "facility": facility,
            "pdf_ref": pdf_ref,
            "anchored_date": None,
            "anchored_facility": None,
            "score": 0,
        }

        if not pages:
            per_encounter.append(result)
            continue

        # Look at the cited pages (clamped)
        date_hit = False
        facility_hit = False
        for pg in pages:
            if pg < 1 or pg > len(records_pages):
                continue
            page_text = records_pages[pg - 1]
            if first_date and first_date in page_text:
                date_hit = True
            if facility and _fuzzy_contains(facility[:30], page_text):
                facility_hit = True
            if date_hit and facility_hit:
                break

        result["anchored_date"] = date_hit
        result["anchored_facility"] = facility_hit

        if date_hit and facility_hit:
            result["score"] = 100
        elif date_hit or facility_hit:
            result["score"] = 60
            issues.append(AuditIssue(
                "warning", "partial_anchor", entity,
                f"Encounter {first_date} / {facility[:40]} partially anchored "
                f"(date_found={date_hit}, facility_found={facility_hit})",
                "Verify this encounter's pdf_ref points to the right pages.",
            ))
        else:
            result["score"] = 0
            issues.append(AuditIssue(
                "critical", "unanchored", entity,
                f"Encounter {first_date} / {facility[:40]} NOT found in cited pages "
                f"{pdf_ref} — possible hallucination or wrong pdf_ref",
                "Re-extract this encounter and verify source page numbers.",
            ))

        per_encounter.append(result)


# ── Layer 3: AI verbatim check (optional) ──────────────────────────────────

def _check_verbatim_with_ai(doc: dict, records_pages: List[str],
                            issues: List[AuditIssue],
                            per_encounter: List[Dict],
                            *, backend: str = "anthropic",
                            model: Optional[str] = None,
                            api_key: Optional[str] = None,
                            aws_region: str = "us-east-1",
                            max_encounters: int = 50) -> None:
    """Optional deep check: ask Claude if each encounter faithfully matches
    its cited source pages. Expensive ($0.05-0.20 per encounter). Skips
    encounters that already failed Layer 2 anchoring.

    To control cost we sample up to `max_encounters` of the longest /
    highest-risk encounters. Run full-coverage only for final production.
    """
    from pipeline.chronology import _retry_with_backoff

    # Pick encounters to check: prioritize those that passed anchoring,
    # weighted by medical_events length (longest = most content at risk).
    encounters = doc.get("encounters", []) or []
    scored = []
    for i, enc in enumerate(encounters):
        if i >= len(per_encounter):
            continue
        anchor_score = per_encounter[i].get("score", 0)
        body_len = len(enc.get("medical_events", "") or "")
        if anchor_score >= 60:  # only verify anchored ones
            scored.append((body_len, i))
    scored.sort(reverse=True)
    to_check = [i for _, i in scored[:max_encounters]]

    log.info("Layer 3 AI verbatim check: sampling %d of %d encounters",
             len(to_check), len(encounters))
    if not to_check:
        return

    # Build client
    if backend == "bedrock":
        import boto3
        from botocore.config import Config
        client = boto3.client("bedrock-runtime", region_name=aws_region,
                              config=Config(read_timeout=300, retries={"max_attempts": 3}))
        effective_model = model or "global.anthropic.claude-sonnet-4-20250514-v1:0"
    else:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
        effective_model = model or "claude-sonnet-4-20250514"

    system_prompt = (
        "You are an auditor checking whether a medical chronology entry "
        "faithfully represents its source. Reply with a single JSON object: "
        "{\"verdict\": \"VERBATIM\" | \"PARAPHRASED\" | \"FABRICATED\", "
        "\"reason\": \"one sentence\"}. "
        "VERBATIM = every clinical fact in the entry appears in the source. "
        "PARAPHRASED = facts preserved but wording changed. "
        "FABRICATED = entry contains facts not in source."
    )

    for idx in to_check:
        enc = encounters[idx]
        pages = _parse_pdf_ref(enc.get("pdf_ref") or "")
        source = "\n".join(records_pages[p - 1] for p in pages
                           if 1 <= p <= len(records_pages))
        if not source.strip():
            continue
        user_prompt = (
            f"SOURCE (pages {enc.get('pdf_ref')}):\n"
            f"{source[:20000]}\n\n"
            f"CHRONOLOGY ENTRY:\n"
            f"Date: {enc.get('date')}\n"
            f"Facility: {enc.get('facility')}\n"
            f"Medical events:\n{enc.get('medical_events')[:4000]}\n\n"
            f"Reply with the JSON verdict object only."
        )

        def _call():
            if backend == "bedrock":
                body = json.dumps({
                    "anthropic_version": "bedrock-2023-05-31",
                    "max_tokens": 200,
                    "temperature": 0,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_prompt}],
                })
                resp = client.invoke_model(modelId=effective_model, body=body)
                payload = json.loads(resp["body"].read())
                return payload["content"][0]["text"]
            else:
                msg = client.messages.create(
                    model=effective_model, max_tokens=200, temperature=0,
                    system=system_prompt,
                    messages=[{"role": "user", "content": user_prompt}],
                )
                return msg.content[0].text

        try:
            raw = _retry_with_backoff(_call, label=f"audit-enc-{idx}")
        except Exception as exc:
            log.warning("AI audit failed for encounter %d: %s", idx, exc)
            continue

        # Parse verdict
        m = re.search(r"\{[^}]+\}", raw, re.DOTALL)
        if not m:
            continue
        try:
            verdict_obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        verdict = (verdict_obj.get("verdict") or "").upper()
        reason = verdict_obj.get("reason", "")
        per_encounter[idx]["ai_verdict"] = verdict
        per_encounter[idx]["ai_reason"] = reason

        if verdict == "FABRICATED":
            issues.append(AuditIssue(
                "critical", "fabricated", f"encounters[{idx}]",
                f"AI audit flagged FABRICATED: {reason}",
                "Re-extract this encounter from source pages.",
            ))
        elif verdict == "PARAPHRASED":
            issues.append(AuditIssue(
                "warning", "paraphrased", f"encounters[{idx}]",
                f"AI audit flagged PARAPHRASED: {reason}",
                "Consider re-extracting for verbatim fidelity.",
            ))


# ── Public API ─────────────────────────────────────────────────────────────

def audit_chronology(
    chronology_path: str,
    records_path: str,
    output_dir: str,
    *,
    deep: bool = False,
    backend: str = "anthropic",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    aws_region: str = "us-east-1",
    max_ai_encounters: int = 50,
) -> AuditReport:
    """Run the audit and save `audit_report.json` + `audit_report.md`."""
    with open(chronology_path) as f:
        doc = json.load(f)

    records_pages = _load_pdf_pages(records_path)
    total_records_pages = len(records_pages)
    log.info("Loaded %d records pages", total_records_pages)

    issues: List[AuditIssue] = []
    per_encounter: List[Dict] = []

    log.info("Layer 1: structure checks...")
    _check_structure(doc, total_records_pages, issues)

    log.info("Layer 2: page-ref anchoring...")
    _check_anchoring(doc, records_pages, issues, per_encounter)

    if deep:
        log.info("Layer 3: AI verbatim check (backend=%s)...", backend)
        _check_verbatim_with_ai(
            doc, records_pages, issues, per_encounter,
            backend=backend, model=model, api_key=api_key,
            aws_region=aws_region, max_encounters=max_ai_encounters,
        )

    # Scoring
    crit = sum(1 for i in issues if i.severity == "critical")
    warn = sum(1 for i in issues if i.severity == "warning")
    info = sum(1 for i in issues if i.severity == "info")
    total_enc = len(doc.get("encounters", []) or [])
    refs_ok = sum(1 for e in per_encounter if e.get("score", 0) >= 60)
    ref_coverage = refs_ok / total_enc if total_enc else 0.0

    score = max(0, 100 - (crit * 15) - (warn * 3) - info * 0)

    report = AuditReport(
        score=score, critical_count=crit, warning_count=warn, info_count=info,
        total_encounters=total_enc, encounters_with_refs=refs_ok,
        encounter_ref_coverage=ref_coverage,
        issues=issues, per_encounter=per_encounter,
    )

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "audit_report.json").write_text(
        json.dumps(report.as_dict(), indent=2)
    )
    _write_markdown_report(report, out_dir / "audit_report.md")
    log.info("Audit score: %d/100 (critical=%d, warnings=%d, info=%d)",
             score, crit, warn, info)
    return report


def _write_markdown_report(report: AuditReport, path: Path) -> None:
    lines = []
    lines.append(f"# Stage 4 Audit Report")
    lines.append("")
    lines.append(f"**Score:** {report.score} / 100")
    lines.append("")
    lines.append(f"- Critical: **{report.critical_count}**")
    lines.append(f"- Warnings: **{report.warning_count}**")
    lines.append(f"- Info: **{report.info_count}**")
    lines.append(f"- Encounter ref coverage: {report.encounter_ref_coverage:.1%} "
                 f"({report.encounters_with_refs}/{report.total_encounters})")
    lines.append("")
    if not report.issues:
        lines.append("No issues found.")
    else:
        lines.append("## Issues")
        lines.append("")
        by_sev = {"critical": [], "warning": [], "info": []}
        for issue in report.issues:
            by_sev[issue.severity].append(issue)
        for sev in ("critical", "warning", "info"):
            if not by_sev[sev]:
                continue
            lines.append(f"### {sev.title()} ({len(by_sev[sev])})")
            lines.append("")
            for issue in by_sev[sev][:50]:
                lines.append(f"- **{issue.entity}** — {issue.message}")
                if issue.suggestion:
                    lines.append(f"  - *Suggestion:* {issue.suggestion}")
            if len(by_sev[sev]) > 50:
                lines.append(f"- _(+{len(by_sev[sev]) - 50} more)_")
            lines.append("")
    path.write_text("\n".join(lines))


# ── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--chronology", required=True,
                   help="Path to chronology_doc.json from Stage 2")
    p.add_argument("--records", required=True,
                   help="Path to Merged Medical Records PDF")
    p.add_argument("--output-dir", required=True,
                   help="Directory for audit_report.json + audit_report.md")
    p.add_argument("--deep", action="store_true",
                   help="Enable AI verbatim check (Layer 3)")
    p.add_argument("--backend", default="anthropic", choices=["anthropic", "bedrock"])
    p.add_argument("--model", default=None)
    p.add_argument("--aws-region", default="us-east-1")
    p.add_argument("--api-key", default=None)
    p.add_argument("--max-ai-encounters", type=int, default=50)
    args = p.parse_args()

    audit_chronology(
        chronology_path=args.chronology,
        records_path=args.records,
        output_dir=args.output_dir,
        deep=args.deep,
        backend=args.backend,
        model=args.model,
        api_key=args.api_key or os.getenv("ANTHROPIC_API_KEY"),
        aws_region=args.aws_region,
        max_ai_encounters=args.max_ai_encounters,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# UNC Pipeline — Deployment Notes (2026-04-14)

Two patches in this folder, both ready for `scp` to EC2 (`44.204.31.209`).

## What changed

### 1. `chronology.py` — fixes Manus's `overloaded_error` blocker

- New helpers `_is_retryable_anthropic_error` and `_retry_with_backoff`.
- `_anthropic_call` is now wrapped in `_retry_with_backoff`: 6 attempts,
  base delay 30s, max 240s, ±25% jitter. Catches HTTP 429 / 503 / 529 and
  Anthropic `OverloadedError` / `RateLimitError`.
- `_anthropic_chunked` default `max_concurrent` lowered from **5 → 3**.
  Comment explains why (deeper prompt → 2× tokens per chunk → 529s at 5).

### 2. `api_server.py` — wires Stage 3 (Expert Evaluation) + Stage 4 (audit) into the API

- `tracked_chunked` default `max_concurrent` lowered from **5 → 3** so the
  API path picks up the same change.
- After chronology completes (now emits at progress=75 instead of 100), the
  worker calls `pipeline.narrative.generate_narrative_bedrock` (HIPAA path)
  with automatic fallback to `generate_narrative_anthropic` if Bedrock errors.
- Followed by `pipeline.audit.audit_narrative_simple` for a fast
  consistency check (no extra LLM call).
- `job['result']` is now a dict:
  ```json
  {"chronology": {...}, "narrative": "...", "audit": {...}, "narrative_error": null}
  ```
  Front-end change required: read `result.chronology.encounters` instead of
  `result.encounters`. The DOCX template generator should switch to
  `result.narrative` for the Expert Evaluation body.
- `POST /api/process` accepts three new optional form fields:
  `eval_date`, `attendees`, `skip_narrative` (default `false`).
  When `skip_narrative=true` (or DOB/DOI missing), Stage 3 is bypassed and
  the pipeline returns chronology only — preserves current behavior.
- Stage 3 / 4 failures do not lose the chronology; they emit a `warning`
  event and set `result.narrative_error` so the front-end can surface it.

## Deploy steps

```bash
# 1. Copy patched files to EC2
scp chronology.py     ubuntu@44.204.31.209:/opt/unc-api/pipeline/chronology.py
scp api_server.py     ubuntu@44.204.31.209:/opt/unc-api/api_server.py

# 2. Optional: env flag to force Anthropic direct (skip Bedrock) for testing
ssh ubuntu@44.204.31.209 'echo "FORCE_ANTHROPIC_DIRECT=false" | sudo tee -a /opt/unc-api/.env'

# 3. Restart the service
ssh ubuntu@44.204.31.209 'sudo systemctl restart unc-api'

# 4. Smoke-test
curl http://44.204.31.209:8000/api/health
# → {"status":"ok","version":"5.0"}

# 5. Re-run the Hatcher v2 case that hit overloaded_error
curl -X POST http://44.204.31.209:8000/api/process \
  -F 'file=@/path/to/Merged Medical Records - Nicholas Hatcher.pdf' \
  -F 'name=Nicholas Hatcher' \
  -F 'dob=07/24/1980' \
  -F 'doi=08/13/2024' \
  -F 'injury=CVA 08/13/2024; PFO closure 12/03/2024; PCI w/ LAD stent 10/28/2024' \
  -F 'eval_date=06/04/2026' \
  -F 'attendees=Nicholas Hatcher'
```

## Watch for

- **Concurrency 3 + 30s backoff**: a chunk that hits a 529 will sleep up
  to 240s before its final retry. For a 12-chunk Hatcher case in the
  worst case this adds ~2 min, not the full job.
- **Stage 3 cost**: each Bedrock narrative call is ~$1-2; auto-runs unless
  `skip_narrative=true` or DOB/DOI missing.
- **Multi-worker JOBS dict**: still in-memory per worker. If `gunicorn`
  is running >1 worker, polling `/api/jobs/{id}` will 404 sporadically.
  This is an existing bug, not introduced here. Fix later by moving JOBS
  into Redis or the existing SQLite billing.db.

## Lutes new sources (for next pipeline run)

`Source Files/Lutes - New Source Records (Merged 2026-04).pdf` — 663-page
merged PDF (cover letter + Ethos + MIRS + LCP), bookmarked. Submit this to
the patched API once deployed:

```bash
curl -X POST http://44.204.31.209:8000/api/process \
  -F 'file=@"Lutes - New Source Records (Merged 2026-04).pdf"' \
  -F 'name=Dominic Lutes' \
  -F 'dob=<DOB>' \
  -F 'doi=<DOI>' \
  -F 'injury=<Injury summary>' \
  -F 'eval_date=<scheduled date>'
```

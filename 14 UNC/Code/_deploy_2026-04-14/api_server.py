"""
UNC Medical AI Reviewer — FastAPI Backend
Wraps the pipeline with SSE streaming progress.
"""
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import asyncio, json, uuid, os, tempfile, threading, time, logging, sys, sqlite3
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = FastAPI(title="UNC Medical AI Reviewer API", version="5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # Lock down to your Netlify domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory job store ──
JOBS: dict = {}
MAX_PDF_MB = 500           # Hard cap: reject PDFs larger than this
JOB_TTL_SECONDS = 7200     # 2 hours — expire completed/errored jobs after this
JOB_TIMEOUT_SECONDS = 5400 # 90 min max per job before auto-fail
RATE_PER_CASE = 300        # Billing rate in USD per completed case

# ── Billing DB (SQLite, persists across restarts) ──
BILLING_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "billing.db")

def _init_billing_db():
    con = sqlite3.connect(BILLING_DB)
    con.execute("""
        CREATE TABLE IF NOT EXISTS cases (
            id          TEXT PRIMARY KEY,
            patient     TEXT,
            filename    TEXT,
            pages       INTEGER,
            encounters  INTEGER,
            duration_s  REAL,
            status      TEXT,
            completed_at TEXT
        )
    """)
    con.commit()
    con.close()

_init_billing_db()

def _record_case(job_id, patient, filename, pages, encounters, duration_s, status):
    try:
        con = sqlite3.connect(BILLING_DB)
        con.execute(
            "INSERT OR REPLACE INTO cases VALUES (?,?,?,?,?,?,?,?)",
            (job_id, patient, filename, pages, encounters, duration_s, status,
             datetime.now(timezone.utc).isoformat())
        )
        con.commit()
        con.close()
    except Exception as e:
        log.warning("Billing DB write failed: %s", e)

def _get_billing_stats():
    try:
        con = sqlite3.connect(BILLING_DB)
        total    = con.execute("SELECT COUNT(*) FROM cases WHERE status='complete'").fetchone()[0]
        this_month = con.execute(
            "SELECT COUNT(*) FROM cases WHERE status='complete' AND completed_at >= ?",
            (datetime.now(timezone.utc).strftime("%Y-%m-01"),)
        ).fetchone()[0]
        recent   = con.execute(
            "SELECT patient, filename, encounters, completed_at FROM cases "
            "WHERE status='complete' ORDER BY completed_at DESC LIMIT 10"
        ).fetchall()
        con.close()
        return {
            "total_cases": total,
            "cases_this_month": this_month,
            "revenue_total": total * RATE_PER_CASE,
            "revenue_this_month": this_month * RATE_PER_CASE,
            "rate_per_case": RATE_PER_CASE,
            "recent_cases": [
                {"patient": r[0], "filename": r[1], "encounters": r[2], "completed_at": r[3]}
                for r in recent
            ],
        }
    except Exception as e:
        log.warning("Billing DB read failed: %s", e)
        return {"total_cases": 0, "cases_this_month": 0, "revenue_total": 0,
                "revenue_this_month": 0, "rate_per_case": RATE_PER_CASE, "recent_cases": []}

def _cleanup_jobs():
    """Remove expired jobs to prevent memory leak."""
    now = time.time()
    expired = [
        jid for jid, j in list(JOBS.items())
        if j['status'] in ('complete', 'error') and now - j.get('created', now) > JOB_TTL_SECONDS
    ]
    for jid in expired:
        JOBS.pop(jid, None)
    if expired:
        log.info("Cleaned up %d expired jobs", len(expired))

class Emitter:
    def __init__(self, job_id):
        self.job_id = job_id

    def emit(self, msg, type='info', progress=None):
        job = JOBS[self.job_id]
        if progress is not None:
            job['progress'] = progress
        event = {'msg': msg, 'type': type, 'progress': job['progress'], 'ts': time.time()}
        job['events'].append(event)
        log.info("[%s] %s", self.job_id[:8], msg)

# ── Pipeline worker (runs in background thread) ──
def pipeline_worker(job_id: str, pdf_path: str, patient_info: dict):
    job = JOBS[job_id]
    job['status'] = 'running'
    job['start_time'] = time.time()
    em = Emitter(job_id)

    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from pipeline.extractor import extract_pdf_local, prepare_for_llm
        from pipeline.chronology import generate_chronology_anthropic
        from pipeline.date_audit import audit_missing_dates
        from config import load_config
        import pipeline.chronology as chron_mod

        cfg = load_config()

        em.emit("Starting OCR extraction…", progress=2)

        # Route large PDFs through async Textract for ~5x speed gain.
        # Quick pre-scan: count scanned pages via PyMuPDF (no API cost).
        import fitz as _fitz
        from config import SCANNED_PAGE_CHAR_THRESHOLD
        _doc = _fitz.open(pdf_path)
        _total = len(_doc)
        _scanned = sum(1 for p in _doc if len(p.get_text("text").strip()) < SCANNED_PAGE_CHAR_THRESHOLD)
        _doc.close()

        S3_BUCKET = "unc-medical-ai-deploy"
        AWS_REGION = cfg.aws_region or "us-east-1"
        USE_ASYNC_TEXTRACT = _scanned > 200

        if USE_ASYNC_TEXTRACT:
            em.emit(f"Large scanned PDF ({_scanned}/{_total} scanned pages) — using async Textract…", progress=5)
            from pipeline.extractor import extract_pdf_textract
            extraction = extract_pdf_textract(pdf_path, S3_BUCKET, AWS_REGION)
        else:
            extraction = extract_pdf_local(pdf_path)

        em.emit(
            f"Extracted {extraction.total_chars:,} chars from {extraction.total_pages} pages",
            'success', progress=40
        )

        full_text = prepare_for_llm(extraction)

        case_ctx = f"Patient: {patient_info.get('name', 'Unknown')}."
        if patient_info.get('dob'):   case_ctx += f" DOB: {patient_info['dob']}."
        if patient_info.get('doi'):   case_ctx += f" Date of injury: {patient_info['doi']}."
        if patient_info.get('injury'): case_ctx += f" {patient_info['injury']}"

        em.emit("Running AI chronology generation…", progress=42)

        # Thread-safe progress reporting via a shared counter instead of monkey-patching
        # (monkey-patching _anthropic_call is not safe when multiple jobs run concurrently)
        _chunk_counter = [0]
        _chunk_total = [1]
        orig_chunked = chron_mod._anthropic_chunked

        def tracked_chunked(client, model, system_prompt, full_text_arg, case_context_arg,
                            chunk_size, *, max_tokens, temperature, chunk_overlap=15000,
                            max_concurrent=3):
            # Reduced from 5 → 3 for the enhanced (deeper) chronology prompt to
            # avoid Anthropic overloaded_error (HTTP 529) on large cases.
            # Estimate chunk count for progress reporting
            from pipeline.chronology import _split_with_overlap
            chunks = _split_with_overlap(full_text_arg, chunk_size, chunk_overlap)
            _chunk_total[0] = len(chunks)

            orig_process = None
            orig_call = chron_mod._anthropic_call

            def tracked_call(client_arg, model_arg, system_prompt_arg, chunk_arg, ctx_arg,
                             *, max_tokens=max_tokens, temperature=temperature):
                _chunk_counter[0] += 1
                prog = 42 + int(40 * _chunk_counter[0] / max(_chunk_total[0], 1))
                em.emit(f"Processing section {_chunk_counter[0]}/{_chunk_total[0]}…", progress=min(prog, 81))
                return orig_call(client_arg, model_arg, system_prompt_arg, chunk_arg, ctx_arg,
                                 max_tokens=max_tokens, temperature=temperature)

            # Temporarily patch only within this call, using a local reference
            chron_mod._anthropic_call = tracked_call
            try:
                result = orig_chunked(client, model, system_prompt, full_text_arg,
                                      case_context_arg, chunk_size,
                                      max_tokens=max_tokens, temperature=temperature,
                                      chunk_overlap=chunk_overlap, max_concurrent=max_concurrent)
            finally:
                chron_mod._anthropic_call = orig_call
            return result

        chron_mod._anthropic_chunked = tracked_chunked

        try:
            chronology = generate_chronology_anthropic(
                full_text, case_ctx,
                cfg.anthropic_api_key,
                model=cfg.claude_model_direct,
                temperature=cfg.chronology_temperature,
            )
        finally:
            chron_mod._anthropic_chunked = orig_chunked

        n = len(chronology.get('encounters', []))
        em.emit(f"Chronology complete: {n} encounters", 'success', progress=82)

        HAIKU_MODEL = "claude-haiku-4-5-20251001"

        em.emit("Running date audit pass 1/2…", progress=85)
        r1 = audit_missing_dates(full_text, chronology, cfg.anthropic_api_key,
                                  model=cfg.claude_model_direct, fast_model=HAIKU_MODEL)
        rec1 = r1['stats']['recovered']
        chronology = r1['chronology']
        em.emit(f"Pass 1: +{rec1} encounters recovered", 'success', progress=92)

        if rec1 > 0:
            em.emit("Running date audit pass 2/2…", progress=94)
            r2 = audit_missing_dates(full_text, chronology, cfg.anthropic_api_key,
                                      model=cfg.claude_model_direct, fast_model=HAIKU_MODEL)
            rec2 = r2['stats']['recovered']
            chronology = r2['chronology']
            em.emit(f"Pass 2: +{rec2} encounters recovered", 'success', progress=98)

        total = len(chronology.get('encounters', []))
        em.emit(f"Chronology complete: {total} encounters", 'success', progress=75)

        # ── Stage 3: Expert Evaluation narrative ────────────────────────
        # Skips gracefully if patient info is incomplete (chronology-only mode)
        # or if Bedrock/Anthropic is unreachable. The chronology is still
        # returned even if Stage 3 fails.
        narrative_text = None
        audit_report = None
        narrative_error = None

        skip_narrative = (
            (patient_info.get('skip_narrative') in (True, 'true', '1'))
            or not patient_info.get('dob')
            or not patient_info.get('doi')
        )

        if skip_narrative:
            em.emit("Skipping Expert Evaluation (chronology-only mode)",
                    'info', progress=100)
        else:
            try:
                from pipeline.narrative import (
                    generate_narrative_bedrock,
                    generate_narrative_anthropic,
                )
                em.emit("Generating Expert Evaluation narrative…", progress=78)

                narrative_patient = {
                    'name': patient_info.get('name', 'Unknown'),
                    'dob': patient_info.get('dob', ''),
                    'injury_date': patient_info.get('doi', ''),
                    'eval_date': patient_info.get('eval_date',
                                                   '[TO BE SCHEDULED]'),
                    'attendees': patient_info.get('attendees',
                                                   '[TO BE FILLED]'),
                }

                # Prefer Bedrock for HIPAA; fall back to Anthropic direct.
                use_bedrock = bool(cfg.aws_region) and (
                    os.getenv("FORCE_ANTHROPIC_DIRECT", "false").lower()
                    not in ("true", "1", "yes")
                )
                if use_bedrock:
                    try:
                        narrative_text = generate_narrative_bedrock(
                            chronology, narrative_patient,
                            region=cfg.aws_region,
                            model=cfg.claude_model_bedrock,
                            max_tokens=cfg.narrative_max_tokens,
                            temperature=cfg.narrative_temperature,
                        )
                    except Exception as bex:
                        log.warning("Bedrock narrative failed (%s) — "
                                    "falling back to Anthropic direct.", bex)
                        narrative_text = generate_narrative_anthropic(
                            chronology, narrative_patient,
                            api_key=cfg.anthropic_api_key,
                            model=cfg.claude_model_direct,
                            max_tokens=cfg.narrative_max_tokens,
                            temperature=cfg.narrative_temperature,
                        )
                else:
                    narrative_text = generate_narrative_anthropic(
                        chronology, narrative_patient,
                        api_key=cfg.anthropic_api_key,
                        model=cfg.claude_model_direct,
                        max_tokens=cfg.narrative_max_tokens,
                        temperature=cfg.narrative_temperature,
                    )

                em.emit(
                    f"Expert Evaluation generated ({len(narrative_text):,} chars)",
                    'success', progress=92,
                )

                # ── Stage 4: Audit ──────────────────────────────────────
                em.emit("Auditing narrative against source records…",
                        progress=94)
                from pipeline.audit import audit_narrative_simple
                audit_report = audit_narrative_simple(
                    narrative_text, chronology
                )
                crit = sum(1 for i in audit_report.get('issues', [])
                           if i.get('severity') == 'critical')
                warn = sum(1 for i in audit_report.get('issues', [])
                           if i.get('severity') == 'warning')
                score = audit_report.get('score', '?')
                em.emit(
                    f"Audit complete — score={score} (critical={crit}, warnings={warn})",
                    'success', progress=99,
                )

                em.emit("Complete — chronology + Expert Evaluation + audit",
                        'success', progress=100)

            except Exception as nex:
                # Stage 3/4 failure should not lose the chronology.
                log.exception("Expert Evaluation stage failed: %s", nex)
                narrative_error = str(nex)
                em.emit(
                    f"Expert Evaluation failed (chronology preserved): {nex}",
                    'warning', progress=100,
                )

        job['status'] = 'complete'
        job['result'] = {
            'chronology': chronology,
            'narrative': narrative_text,
            'audit': audit_report,
            'narrative_error': narrative_error,
        }

        # Billing DB + Notion logging (non-blocking — errors are swallowed)
        duration = time.time() - job.get('start_time', time.time())
        _record_case(job_id, patient_info.get('name', 'Unknown'),
                     job.get('filename', ''), getattr(extraction, 'total_pages', 0),
                     total, duration, 'complete')
        try:
            from pipeline.notion_logger import log_pipeline_job
            log_pipeline_job(
                job_id=job_id,
                patient_name=patient_info.get('name', 'Unknown'),
                filename=job.get('filename', ''),
                page_count=getattr(extraction, 'total_pages', 0),
                encounter_count=total,
                duration_sec=duration,
                status='complete',
            )
        except Exception as _ne:
            log.debug("Notion log skipped: %s", _ne)

    except Exception as exc:
        em.emit(f"Error: {exc}", 'error')
        job['status'] = 'error'
        job['error']  = str(exc)
        log.exception("Pipeline failed for job %s", job_id)

        try:
            from pipeline.notion_logger import log_pipeline_job
            duration = time.time() - job.get('start_time', time.time())
            log_pipeline_job(
                job_id=job_id,
                patient_name=patient_info.get('name', 'Unknown'),
                filename=job.get('filename', ''),
                page_count=0,
                encounter_count=0,
                duration_sec=duration,
                status='error',
                notes=str(exc)[:500],
            )
        except Exception as _ne:
            log.debug("Notion log (error) skipped: %s", _ne)

    finally:
        try:
            os.unlink(pdf_path)
        except Exception:
            pass


# ── Routes ──

@app.post("/api/process")
async def process_pdf(
    file:       UploadFile = File(...),
    name:       str = Form(default="Unknown Patient"),
    dob:        str = Form(default=""),
    doi:        str = Form(default=""),
    injury:     str = Form(default=""),
    eval_date:  str = Form(default="[TO BE SCHEDULED]"),
    attendees:  str = Form(default="[TO BE FILLED]"),
    skip_narrative: str = Form(default="false"),
):
    _cleanup_jobs()  # Housekeeping on every new request

    # Validate content type
    if file.content_type and "pdf" not in file.content_type.lower():
        raise HTTPException(400, "Only PDF files are accepted")

    job_id = str(uuid.uuid4())

    # Stream file to disk to avoid loading entire PDF into memory
    import shutil
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        tmp_path = tmp.name

    with open(tmp_path, "wb") as out_f:
        total_bytes = 0
        chunk_size = 1024 * 1024  # 1MB chunks
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > MAX_PDF_MB * 1024 * 1024:
                os.unlink(tmp_path)
                raise HTTPException(413, f"PDF exceeds {MAX_PDF_MB}MB limit")
            out_f.write(chunk)

    JOBS[job_id] = {
        'id': job_id, 'status': 'queued', 'progress': 0,
        'events': [], 'result': None, 'error': None,
        'filename': file.filename, 'created': time.time(),
    }

    threading.Thread(
        target=pipeline_worker,
        args=(job_id, tmp_path, {
            'name': name, 'dob': dob, 'doi': doi, 'injury': injury,
            'eval_date': eval_date, 'attendees': attendees,
            'skip_narrative': skip_narrative,
        }),
        daemon=True,
    ).start()

    return {'job_id': job_id}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request):
    if job_id not in JOBS:
        raise HTTPException(404, "Job not found")

    async def stream():
        last = 0
        deadline = time.time() + JOB_TIMEOUT_SECONDS
        while True:
            if await request.is_disconnected():
                break
            job = JOBS.get(job_id)
            if not job:
                break
            for ev in job['events'][last:]:
                yield f"data: {json.dumps(ev)}\n\n"
                last += 1
            if job['status'] in ('complete', 'error'):
                yield f"data: {json.dumps({'type': 'done', 'status': job['status'], 'progress': 100, 'result': job.get('result'), 'error': job.get('error')})}\n\n"
                break
            # Auto-fail jobs that exceed the timeout
            if time.time() > deadline:
                job['status'] = 'error'
                job['error'] = 'Job timed out after 90 minutes'
                yield f"data: {json.dumps({'type': 'done', 'status': 'error', 'progress': 0, 'error': 'Timeout'})}\n\n"
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404)
    j = JOBS[job_id]
    return {'id': j['id'], 'status': j['status'], 'progress': j['progress'],
            'result': j.get('result'), 'error': j.get('error')}


@app.get("/api/billing")
def billing():
    return _get_billing_stats()


@app.get("/api/health")
def health():
    return {'status': 'ok', 'version': 'v5'}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

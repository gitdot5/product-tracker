#!/bin/bash
# One-shot runner for Jon Witting end-to-end MedSum pipeline.
# Logs everything to /tmp/jon_run.log so Claude can poll progress.

set -uo pipefail

LOG=/tmp/jon_run.log
echo "=== Jon Witting pipeline run — $(date) ===" | tee "$LOG"

cd "/Users/gittran/Desktop/product-tracker/14 UNC/Code"

python3 run_medsum_pipeline.py \
    --case-dir "/Users/gittran/Downloads/Jon Witting PID 24689" \
    --name "Jon Witting" \
    --doi "03/08/2022 and 02/11/2025" \
    --injury "MVA x2 (03/08/2022 and 02/11/2025); low back pain s/p lumbar caudal ESI 04/08/2025 and L3-S1 TLIF 04/29/2025; TBI with persistent symptoms s/p IN PRP" \
    --output-dir "AI Pipeline Output" \
    --audit \
    2>&1 | tee -a "$LOG"

RC=${PIPESTATUS[0]}
echo "=== Exit code: $RC ===" | tee -a "$LOG"
echo "=== Done at $(date) ===" | tee -a "$LOG"
exit $RC

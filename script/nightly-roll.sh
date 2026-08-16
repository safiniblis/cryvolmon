#!/usr/bin/env bash
# Cryvolmon nightly roll (run by worker-daily-summary.timer at 21:30 UTC):
#  1. Batch-review every done task still flagged needsManagerReview (one call).
#  2. Enqueue the daily summary, which folds the review verdicts in via the
#     changelog automatically.
set -uo pipefail

cd /opt/cryvolmon || exit 1

echo "=== nightly roll: batch review ==="
node /opt/cryvolmon/script/daily-review.mjs

echo "=== nightly roll: enqueue daily summary ==="
exec /bin/bash /opt/cryvolmon/script/enqueue-daily-summary.sh

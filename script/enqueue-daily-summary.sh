#!/usr/bin/env bash
# Enqueue the nightly Cryvolmon summary job (called by worker-daily-summary.timer).
# Assembles a self-contained prompt from today's changelog, worker results, and
# live model-health index, then POSTs it to the worker queue on localhost.
set -uo pipefail

DATA_DIR=/opt/cryvolmon/data

if [ -f /etc/cryvolmon.env ]; then
  set -a; source /etc/cryvolmon.env; set +a
fi
TOKEN="${COUNCIL_WRITE_TOKEN:-}"

DAY=$(date -u '+%Y-%m-%d')

if [ -z "$TOKEN" ]; then
  echo "ERROR: COUNCIL_WRITE_TOKEN not set in /etc/cryvolmon.env" >&2
  exit 1
fi

CHANGELOG=""
if [ -f "$DATA_DIR/changelog.md" ]; then
  CHANGELOG=$(grep -F "$DAY" "$DATA_DIR/changelog.md" | tail -200 || true)
fi

RESULTS=""
if [ -d "$DATA_DIR/worker-results" ]; then
  for f in "$DATA_DIR"/worker-results/*.md; do
    [ -f "$f" ] || continue
    mtime=$(date -u -r "$f" '+%Y-%m-%d')
    if [ "$mtime" = "$DAY" ]; then
      name=$(basename "$f")
      body=$(head -c 2000 "$f")
      RESULTS+="### ${name}${NL:-}$body${NL:-}${NL:-}"
    fi
  done
fi

INDEX="unknown"
if [ -f "$DATA_DIR/council-free-index.json" ]; then
  INDEX=$(node -e '
    const i = require(process.argv[1]);
    const now = Date.now();
    const entries = Object.values(i.models || {});
    const healthy = entries.filter((e) => e && e.ok === true && now - e.checkedAt < 15 * 60e3);
    const stale = entries.filter((e) => !(e && e.ok === true) || now - e.checkedAt >= 15 * 60e3);
    const h = healthy.map((e) => `${e.provider}/${e.model} ${e.ms}ms`).join("\n");
    const s = stale.map((e) => `${e.provider}/${e.model}`).join(", ");
    console.log(`healthy: ${healthy.length}\n${h || "(none)"}\nstale/down: ${s || "(none)"}`);
  ' "$DATA_DIR/council-free-index.json" 2>/dev/null || true)
fi

PROMPT=$(printf 'Nightly summary job for Cryvolmon (%s UTC).\n\nProduce a concise operational daily summary from the material below: what ran, model health, worker tasks completed, notable events, anomalies, and recommended actions. Keep it under 600 words, plain markdown, no preamble.\n\n=== CHANGELOG (today) ===\n%s\n\n=== WORKER RESULTS (today) ===\n%s\n\n=== MODEL HEALTH ===\n%s\n' "$DAY" "${CHANGELOG:-none}" "${RESULTS:-none}" "${INDEX:-unknown}")
PROMPT="${PROMPT:0:16000}"

curl -sS -X POST http://127.0.0.1:5000/api/worker/tasks \
  -H "Content-Type: application/json" \
  -H "x-council-write-token: $TOKEN" \
  -d "$(node -e 'const p = process.argv[1], d = process.argv[2]; process.stdout.write(JSON.stringify({ title: "Nightly summary " + d, type: "daily-summary", prompt: p, maxOutputTokens: 1200, review: "none" }))' "$PROMPT" "$DAY")" \
  && echo " -> enqueued"

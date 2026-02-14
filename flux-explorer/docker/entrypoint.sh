#!/bin/sh
# Flux Explorer Entrypoint Script
# Starts Next.js server (price cache initialization handled inside the app)

set -e

echo "=== Flux Explorer Startup ==="

API_URL="${SERVER_API_URL:-http://127.0.0.1:42067}"
WAIT_FOR_API_READY="${WAIT_FOR_API_READY:-1}"
WAIT_FOR_API_READY_INTERVAL_SECS="${WAIT_FOR_API_READY_INTERVAL_SECS:-2}"
WAIT_FOR_API_READY_LOG_EVERY="${WAIT_FOR_API_READY_LOG_EVERY:-15}"

if [ "$WAIT_FOR_API_READY" = "1" ] || [ "$WAIT_FOR_API_READY" = "true" ]; then
  echo "Waiting for API readiness at ${API_URL}/ready..."
  attempt=0
  while true; do
    attempt=$((attempt + 1))
    if node -e "fetch(process.env.URL,{cache:'no-store'}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" URL="${API_URL}/ready"; then
      echo "API is ready."
      break
    fi
    if [ $((attempt % WAIT_FOR_API_READY_LOG_EVERY)) -eq 0 ]; then
      echo "Still waiting for API readiness at ${API_URL}/ready..."
    fi
    sleep "$WAIT_FOR_API_READY_INTERVAL_SECS"
  done
fi

echo "Starting Next.js server on port ${PORT:-42069}..."

node server.js &
PID=$!

node -e "fetch(process.env.URL).catch(()=>undefined)" URL="http://127.0.0.1:${PORT:-42069}/api/rich-list?page=1&pageSize=100&minBalance=1"

wait $PID

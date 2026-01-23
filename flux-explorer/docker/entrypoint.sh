#!/bin/sh
# Flux Explorer Entrypoint Script
# Starts Next.js server (price cache initialization handled inside the app)

set -e

echo "=== Flux Explorer Startup ==="

echo "Starting Next.js server on port ${PORT:-42069}..."

node server.js &
PID=$!

API_URL="${SERVER_API_URL:-http://127.0.0.1:42067}"

for i in 1 2 3 4 5; do
  if node -e "fetch(process.env.URL).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" URL="$API_URL/api/v1/status"; then
    break
  fi
  sleep 1
done

node -e "fetch(process.env.URL).catch(()=>undefined)" URL="http://127.0.0.1:${PORT:-42069}/api/rich-list?page=1&pageSize=100&minBalance=1"

wait $PID

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
  # Try multiple candidates because Flux internal DNS aliases can vary between environments.
  API_CANDIDATES="${API_URL}"
  API_CANDIDATES="${API_CANDIDATES} http://api:42067"
  API_CANDIDATES="${API_CANDIDATES} http://explorer-api:42067"
  API_CANDIDATES="${API_CANDIDATES} http://127.0.0.1:42067"

  echo "Waiting for API readiness..."
  attempt=0
  while true; do
    attempt=$((attempt + 1))
    for base in $API_CANDIDATES; do
      if URL="${base}/ready" node -e "fetch(process.env.URL,{cache:'no-store'}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"; then
        API_URL="$base"
        export SERVER_API_URL="$API_URL"
        echo "API is ready at ${API_URL}/ready"
        break 2
      fi
    done

    if [ $((attempt % WAIT_FOR_API_READY_LOG_EVERY)) -eq 0 ]; then
      echo "Still waiting for API readiness..."
      CANDS="$API_CANDIDATES" node -e "\
const bases=(process.env.CANDS||'').split(' ').filter(Boolean);\
const run=async()=>{\
  for (const base of bases){\
    try{\
      const r=await fetch(base+'/ready',{cache:'no-store'});\
      console.log('[ready]',base,'status',r.status);\
    }catch(e){\
      const code=e?.cause?.code||e?.code||e?.name||'error';\
      console.log('[ready]',base,'error',code);\
    }\
  }\
};\
run();\
" || true
    fi
    sleep "$WAIT_FOR_API_READY_INTERVAL_SECS"
  done
fi

echo "Starting Next.js server on port ${PORT:-42069}..."

node server.js &
PID=$!

URL="http://127.0.0.1:${PORT:-42069}/api/rich-list?page=1&pageSize=100&minBalance=1" node -e "fetch(process.env.URL).catch(()=>undefined)"

wait $PID

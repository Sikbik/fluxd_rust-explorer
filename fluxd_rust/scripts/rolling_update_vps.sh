#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: rolling_update_vps.sh [options]

Pragmatic rolling update procedure for the VPS Docker Compose stack.

Docker Compose does not provide true rolling updates for single-instance services.
This script implements a safe stop/build/start sequence with health gating.

Options:
  --compose-file PATH   Compose file (default: docker-compose.vps.yml)
  --timeout-secs N      Health wait timeout (default: 180)
  --public-url URL      Public explorer URL for final smoke (optional)
  --skip-build          Skip docker build/up --build (useful if images already built)
  -h, --help            Show help

USAGE
}

COMPOSE_FILE="docker-compose.vps.yml"
TIMEOUT_SECS="180"
PUBLIC_URL=""
SKIP_BUILD="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      COMPOSE_FILE="${2:-}"; shift 2;;
    --timeout-secs)
      TIMEOUT_SECS="${2:-}"; shift 2;;
    --public-url)
      PUBLIC_URL="${2:-}"; shift 2;;
    --skip-build)
      SKIP_BUILD="1"; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2;;
  esac
done

wait_http_200() {
  local name="$1"
  local url="$2"

  local start
  start="$(date +%s)"

  while true; do
    local code
    code="$(curl -sS -o /dev/null --max-time 5 -w "%{http_code}" "$url" || true)"
    if [[ "$code" == "200" ]]; then
      echo "OK: $name"
      return 0
    fi

    local now
    now="$(date +%s)"
    if [[ $((now - start)) -ge "$TIMEOUT_SECS" ]]; then
      echo "FAIL: timeout waiting for $name ($url)" >&2
      return 1
    fi

    sleep 2
  done
}

echo "== Pre-flight: daemon smoke =="
if [[ -x "./fluxd_rust/target/release/fluxd" ]]; then
  ./fluxd_rust/scripts/remote_smoke_test.sh --profile high
else
  echo "Skipping remote_smoke_test.sh (no local fluxd binary)"
fi

echo

echo "== Update: restart stack =="
if [[ "$SKIP_BUILD" != "1" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d --build
else
  docker compose -f "$COMPOSE_FILE" up -d
fi

echo

echo "== Health gating =="
wait_http_200 "fluxd dashboard /healthz" "http://127.0.0.1:8080/healthz"
wait_http_200 "explorer-api /ready" "http://127.0.0.1:42067/ready"
wait_http_200 "flux-explorer /" "http://127.0.0.1:42069/"

echo

echo "== Cache warmup (local) =="
for path in \
  "/api/v1/status" \
  "/api/v1/blocks/latest?limit=6" \
  "/api/v1/supply" \
  "/api/v1/richlist?page=1&pageSize=100&minBalance=1"; do
  curl -sS --max-time 10 "http://127.0.0.1:42067${path}" >/dev/null || true
done

echo

echo "== Optional: public smoke =="
if [[ -n "$PUBLIC_URL" ]]; then
  ./fluxd_rust/scripts/vps_deploy_smoke_checklist.sh --public-url "$PUBLIC_URL" --api-url "$PUBLIC_URL"
fi

echo

echo "OK: rolling update complete"
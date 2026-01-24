#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: vps_deploy_smoke_checklist.sh [options]

Runs a repeatable end-to-end deploy smoke checklist on a VPS.

This script is intentionally conservative and read-only: it does not mutate chainstate,
does not restart services, and does not require Docker.

Options:
  --public-url URL      Public explorer base URL (e.g. https://explorer.example.com)
  --api-url URL         Public explorer-api base URL if exposed separately (defaults to <public-url>)
  --daemon-dashboard URL  Daemon dashboard base URL (default: http://127.0.0.1:8080)
  --timeout-secs N      Curl timeout seconds (default: 10)
  -h, --help            Show help

USAGE
}

PUBLIC_URL=""
API_URL=""
DAEMON_DASHBOARD_URL="http://127.0.0.1:8080"
TIMEOUT_SECS="10"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url)
      PUBLIC_URL="${2:-}";
      shift 2
      ;;
    --api-url)
      API_URL="${2:-}";
      shift 2
      ;;
    --daemon-dashboard)
      DAEMON_DASHBOARD_URL="${2:-}";
      shift 2
      ;;
    --timeout-secs)
      TIMEOUT_SECS="${2:-}";
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "--public-url is required" >&2
  exit 2
fi

if [[ -z "$API_URL" ]]; then
  API_URL="$PUBLIC_URL"
fi

curl_json() {
  local url="$1"
  curl -sS --fail --max-time "$TIMEOUT_SECS" "$url"
}

curl_status() {
  local url="$1"
  curl -sS --max-time "$TIMEOUT_SECS" -o /dev/null -w "%{http_code}" "$url"
}

assert_http_200() {
  local name="$1"
  local url="$2"
  local code
  code="$(curl_status "$url")"
  if [[ "$code" != "200" ]]; then
    echo "FAIL: $name ($url) returned HTTP $code" >&2
    exit 1
  fi
  echo "OK: $name"
}

assert_json_has_keys() {
  local name="$1"
  local url="$2"
  shift 2
  local keys=("$@")

  local body
  body="$(curl_json "$url")"

  python3 - "$name" "${keys[*]}" <<'PY'
import json
import sys

name = sys.argv[1]
keys = sys.argv[2].split()
obj = json.loads(sys.stdin.read() or "{}")
missing = [k for k in keys if k not in obj]
if missing:
  raise SystemExit(f"FAIL: {name} missing keys: {missing}")
print(f"OK: {name} keys present")
PY
}

echo "== Public Explorer Smoke =="
assert_http_200 "UI /" "$PUBLIC_URL/"
assert_http_200 "UI /rich-list" "$PUBLIC_URL/rich-list"

echo

echo "== Public API Smoke =="
assert_http_200 "API /health" "$API_URL/health"
assert_json_has_keys "API /api/v1/status" "$API_URL/api/v1/status" daemon indexer
assert_http_200 "API /api/v1/blocks/latest" "$API_URL/api/v1/blocks/latest"
assert_http_200 "API /api/v1/supply" "$API_URL/api/v1/supply"
assert_http_200 "API /api/v1/richlist" "$API_URL/api/v1/richlist"

echo

echo "== Daemon Dashboard Smoke (internal) =="
assert_http_200 "fluxd /healthz" "$DAEMON_DASHBOARD_URL/healthz"
assert_http_200 "fluxd /metrics" "$DAEMON_DASHBOARD_URL/metrics"
assert_http_200 "fluxd /stats" "$DAEMON_DASHBOARD_URL/stats"

echo

echo "OK: smoke checklist completed"
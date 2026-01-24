#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: alert_checks.sh [options]

Cron-friendly health checks for a running fluxd instance.

Checks:
  - Disk space for a filesystem path
  - Connected peers (via RPC getpeerinfo)
  - Mempool stuck (using /stats + persisted state)
  - Reorg detected (height/hash regression using /stats + persisted state)

Options:
  --rpc-url URL                 Base RPC URL (default: $FLUXD_RPC_URL or http://127.0.0.1:16124)
  --rpc-addr HOST:PORT          RPC addr (used when --rpc-url not set) (default: 127.0.0.1:16124)
  --rpc-auth-mode MODE          cookie|basic|none (default: $FLUXD_RPC_AUTH_MODE or basic)
  --rpc-user USER               Basic auth user (default: $FLUXD_RPC_USER)
  --rpc-pass PASS               Basic auth pass (default: $FLUXD_RPC_PASS)
  --data-dir DIR                Data dir containing rpc.cookie (for cookie auth)
  --cookie-file PATH            Path to rpc.cookie (overrides --data-dir)

  --dashboard-url URL            Base dashboard URL (default: http://127.0.0.1:8080)
  --dashboard-addr HOST:PORT     Dashboard addr (used when --dashboard-url not set) (default: 127.0.0.1:8080)

  --disk-path PATH               Filesystem path to check with df (default: $FLUXD_ALERT_DISK_PATH or $DATA_DIR or /)
  --disk-free-pct-min PCT        Fail when percent-free < PCT (default: $FLUXD_ALERT_DISK_FREE_PCT_MIN or 5)
  --disk-free-bytes-min BYTES    Fail when free bytes < BYTES (default: $FLUXD_ALERT_DISK_FREE_BYTES_MIN or 0)

  --min-peers N                  Minimum connected peers (default: $FLUXD_ALERT_MIN_PEERS or 4)

  --state-file PATH              Persisted state file (default: $FLUXD_ALERT_STATE_FILE or /tmp/fluxd_alert_state.json)
  --state-max-age-secs N         Ignore prior state if older than N seconds (default: $FLUXD_ALERT_STATE_MAX_AGE_SECS or 600)

  --mempool-stuck-min-size N     Only evaluate mempool-stuck when size >= N (default: $FLUXD_ALERT_MEMPOOL_STUCK_MIN_SIZE or 1)
  --mempool-accept-min-delta N   Require relay_accept delta >= N to avoid stuck (default: $FLUXD_ALERT_MEMPOOL_ACCEPT_MIN_DELTA or 1)

  --p2p-probe 0|1                Enable P2P mempool probe (default: $FLUXD_ALERT_P2P_PROBE or 0)
  --p2p-addr HOST:PORT           P2P addr for probe (default: $FLUXD_ALERT_P2P_ADDR or 127.0.0.1:16125)
  --p2p-timeout-secs N           P2P probe timeout (default: $FLUXD_ALERT_P2P_TIMEOUT_SECS or 8)

  -h, --help                     Show help

Environment variables:
  - RPC connection: FLUXD_RPC_URL, FLUXD_RPC_AUTH_MODE, FLUXD_RPC_USER, FLUXD_RPC_PASS
  - Alerting config: FLUXD_ALERT_* (see option defaults above)

Exit codes:
  0 = all checks OK
  1 = at least one check failed
  2 = script usage/config error
USAGE
}

RPC_ADDR="${FLUXD_ALERT_RPC_ADDR:-127.0.0.1:16124}"
RPC_URL="${FLUXD_RPC_URL:-}"
RPC_AUTH_MODE="${FLUXD_RPC_AUTH_MODE:-basic}"
RPC_USER="${FLUXD_RPC_USER:-}"
RPC_PASS="${FLUXD_RPC_PASS:-}"
DATA_DIR=""
COOKIE_FILE=""

DASHBOARD_ADDR="${FLUXD_ALERT_DASHBOARD_ADDR:-127.0.0.1:8080}"
DASHBOARD_URL="${FLUXD_ALERT_DASHBOARD_URL:-}"

DISK_PATH="${FLUXD_ALERT_DISK_PATH:-}"
DISK_FREE_PCT_MIN="${FLUXD_ALERT_DISK_FREE_PCT_MIN:-5}"
DISK_FREE_BYTES_MIN="${FLUXD_ALERT_DISK_FREE_BYTES_MIN:-0}"

MIN_PEERS="${FLUXD_ALERT_MIN_PEERS:-4}"

STATE_FILE="${FLUXD_ALERT_STATE_FILE:-/tmp/fluxd_alert_state.json}"
STATE_MAX_AGE_SECS="${FLUXD_ALERT_STATE_MAX_AGE_SECS:-600}"

MEMPOOL_STUCK_MIN_SIZE="${FLUXD_ALERT_MEMPOOL_STUCK_MIN_SIZE:-1}"
MEMPOOL_ACCEPT_MIN_DELTA="${FLUXD_ALERT_MEMPOOL_ACCEPT_MIN_DELTA:-1}"

P2P_PROBE="${FLUXD_ALERT_P2P_PROBE:-0}"
P2P_ADDR="${FLUXD_ALERT_P2P_ADDR:-127.0.0.1:16125}"
P2P_TIMEOUT_SECS="${FLUXD_ALERT_P2P_TIMEOUT_SECS:-8}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc-url)
      RPC_URL="${2:-}"; shift 2;;
    --rpc-addr)
      RPC_ADDR="${2:-}"; shift 2;;
    --rpc-auth-mode)
      RPC_AUTH_MODE="${2:-}"; shift 2;;
    --rpc-user)
      RPC_USER="${2:-}"; shift 2;;
    --rpc-pass)
      RPC_PASS="${2:-}"; shift 2;;
    --data-dir)
      DATA_DIR="${2:-}"; shift 2;;
    --cookie-file)
      COOKIE_FILE="${2:-}"; shift 2;;
    --dashboard-url)
      DASHBOARD_URL="${2:-}"; shift 2;;
    --dashboard-addr)
      DASHBOARD_ADDR="${2:-}"; shift 2;;
    --disk-path)
      DISK_PATH="${2:-}"; shift 2;;
    --disk-free-pct-min)
      DISK_FREE_PCT_MIN="${2:-}"; shift 2;;
    --disk-free-bytes-min)
      DISK_FREE_BYTES_MIN="${2:-}"; shift 2;;
    --min-peers)
      MIN_PEERS="${2:-}"; shift 2;;
    --state-file)
      STATE_FILE="${2:-}"; shift 2;;
    --state-max-age-secs)
      STATE_MAX_AGE_SECS="${2:-}"; shift 2;;
    --mempool-stuck-min-size)
      MEMPOOL_STUCK_MIN_SIZE="${2:-}"; shift 2;;
    --mempool-accept-min-delta)
      MEMPOOL_ACCEPT_MIN_DELTA="${2:-}"; shift 2;;
    --p2p-probe)
      P2P_PROBE="${2:-}"; shift 2;;
    --p2p-addr)
      P2P_ADDR="${2:-}"; shift 2;;
    --p2p-timeout-secs)
      P2P_TIMEOUT_SECS="${2:-}"; shift 2;;
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

if [[ -z "$RPC_URL" ]]; then
  RPC_URL="http://${RPC_ADDR}"
fi
if [[ -z "$DASHBOARD_URL" ]]; then
  DASHBOARD_URL="http://${DASHBOARD_ADDR}"
fi

if [[ -z "$COOKIE_FILE" && -n "$DATA_DIR" ]]; then
  COOKIE_FILE="${DATA_DIR%/}/rpc.cookie"
fi

if [[ -z "$DISK_PATH" ]]; then
  if [[ -n "$DATA_DIR" ]]; then
    DISK_PATH="$DATA_DIR"
  else
    DISK_PATH="/"
  fi
fi

rpc_auth_args=()
case "$RPC_AUTH_MODE" in
  none)
    ;;
  basic)
    if [[ -z "$RPC_USER" || -z "$RPC_PASS" ]]; then
      echo "Missing --rpc-user/--rpc-pass (or FLUXD_RPC_USER/FLUXD_RPC_PASS)" >&2
      exit 2
    fi
    rpc_auth_args=(-u "${RPC_USER}:${RPC_PASS}")
    ;;
  cookie)
    if [[ -z "$COOKIE_FILE" ]]; then
      echo "Missing --data-dir or --cookie-file for cookie auth" >&2
      exit 2
    fi
    if [[ ! -f "$COOKIE_FILE" ]]; then
      echo "rpc.cookie not found: $COOKIE_FILE" >&2
      exit 2
    fi
    COOKIE="$(cat "$COOKIE_FILE")"
    rpc_auth_args=(-u "$COOKIE")
    ;;
  *)
    echo "Invalid --rpc-auth-mode: $RPC_AUTH_MODE" >&2
    exit 2
    ;;
esac

rpc_get() {
  local method="$1"
  curl -sS --fail "${rpc_auth_args[@]}" "${RPC_URL%/}/daemon/${method}"
}

dash_get() {
  local path="$1"
  curl -sS --fail "${DASHBOARD_URL%/}${path}"
}

now_secs() {
  python3 -c 'import time; print(int(time.time()))'
}

parse_peer_count() {
  python3 -c 'import json,sys; obj=json.load(sys.stdin); peers=obj.get("result", []) or []; print(len(peers) if isinstance(peers, list) else 0)'
}

parse_stats_fields() {
  python3 -c 'import json,sys; obj=json.load(sys.stdin); out={
    "ts": int(obj.get("unix_time_secs") or 0),
    "best_block_height": int(obj.get("best_block_height") or 0),
    "best_header_height": int(obj.get("best_header_height") or 0),
    "best_block_hash": str(obj.get("best_block_hash") or ""),
    "best_header_hash": str(obj.get("best_header_hash") or ""),
    "mempool_size": int(obj.get("mempool_size") or 0),
    "mempool_bytes": int(obj.get("mempool_bytes") or 0),
    "mempool_max_bytes": int(obj.get("mempool_max_bytes") or 0),
    "mempool_relay_accept": int(obj.get("mempool_relay_accept") or 0),
    "mempool_relay_reject": int(obj.get("mempool_relay_reject") or 0),
    "verify_blocks": int(obj.get("verify_blocks") or 0),
    "commit_blocks": int(obj.get("commit_blocks") or 0),
  };
  print(json.dumps(out, sort_keys=True))'
}

load_state() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
if not p.is_file():
    print("{}")
    raise SystemExit(0)
try:
    obj = json.loads(p.read_text())
except Exception:
    print("{}")
    raise SystemExit(0)
if not isinstance(obj, dict):
    print("{}")
    raise SystemExit(0)
print(json.dumps(obj, sort_keys=True))
PY
}

write_state() {
  local path="$1"
  local content="$2"
  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"
  printf '%s' "$content" >"$path"
}

get_int_field() {
  local json_in="$1"
  local key="$2"
  python3 - "$key" <<'PY'
import json
import sys

key = sys.argv[1]
try:
  obj = json.loads(sys.stdin.read() or "{}")
except Exception:
  obj = {}
value = obj.get(key, 0)
try:
  print(int(value or 0))
except Exception:
  print(0)
PY
}

get_str_field() {
  local json_in="$1"
  local key="$2"
  python3 - "$key" <<'PY'
import json
import sys

key = sys.argv[1]
try:
  obj = json.loads(sys.stdin.read() or "{}")
except Exception:
  obj = {}
value = obj.get(key, "")
print(value if isinstance(value, str) else "")
PY
}

failures=()

if ! dash_get "/healthz" >/dev/null 2>&1; then
  failures+=("FAIL: dashboard /healthz not reachable at ${DASHBOARD_URL%/}/healthz")
fi

if ! df -PB1 "$DISK_PATH" >/dev/null 2>&1; then
  failures+=("FAIL: disk path not readable: ${DISK_PATH}")
else
  df_line="$(df -PB1 "$DISK_PATH" | tail -n 1)"
  disk_avail_bytes="$(printf '%s' "$df_line" | awk '{print $4}')"
  disk_size_bytes="$(printf '%s' "$df_line" | awk '{print $2}')"
  disk_free_pct="$(python3 - "$disk_avail_bytes" "$disk_size_bytes" <<'PY'
import sys
avail=int(sys.argv[1])
size=int(sys.argv[2])
if size <= 0:
  print(0)
else:
  print(int((avail * 100) / size))
PY
)"

  if [[ "$disk_free_pct" -lt "$DISK_FREE_PCT_MIN" ]]; then
    failures+=("FAIL: disk_free_pct=${disk_free_pct} (min ${DISK_FREE_PCT_MIN}) path=${DISK_PATH}")
  fi
  if [[ "$DISK_FREE_BYTES_MIN" != "0" && "$disk_avail_bytes" -lt "$DISK_FREE_BYTES_MIN" ]]; then
    failures+=("FAIL: disk_free_bytes=${disk_avail_bytes} (min ${DISK_FREE_BYTES_MIN}) path=${DISK_PATH}")
  fi
fi

peerinfo=""
if ! peerinfo="$(rpc_get "getpeerinfo")"; then
  failures+=("FAIL: RPC getpeerinfo failed")
else
  peers="$(printf '%s' "$peerinfo" | parse_peer_count)"
  if [[ "$peers" -lt "$MIN_PEERS" ]]; then
    failures+=("FAIL: peers=${peers} (min ${MIN_PEERS})")
  fi
fi

stats_raw=""
stats_state=""
if ! stats_raw="$(dash_get "/stats")"; then
  failures+=("FAIL: dashboard /stats failed")
else
  stats_state="$(printf '%s' "$stats_raw" | parse_stats_fields)"
fi

prev_state="$(load_state "$STATE_FILE")"
prev_ts="$(printf '%s' "$prev_state" | get_int_field "$prev_state" "ts")"
cur_ts="$(printf '%s' "$stats_state" | get_int_field "$stats_state" "ts")"

have_prev=0
if [[ "$prev_ts" -gt 0 && "$cur_ts" -gt 0 ]]; then
  age=$((cur_ts - prev_ts))
  if [[ "$age" -ge 0 && "$age" -le "$STATE_MAX_AGE_SECS" ]]; then
    have_prev=1
  fi
fi

if [[ "$have_prev" == "1" ]]; then
  prev_height="$(printf '%s' "$prev_state" | get_int_field "$prev_state" "best_block_height")"
  cur_height="$(printf '%s' "$stats_state" | get_int_field "$stats_state" "best_block_height")"
  prev_hash="$(printf '%s' "$prev_state" | get_str_field "$prev_state" "best_block_hash")"
  cur_hash="$(printf '%s' "$stats_state" | get_str_field "$stats_state" "best_block_hash")"

  if [[ "$cur_height" -lt "$prev_height" ]]; then
    failures+=("FAIL: reorg_detected height ${prev_height}->${cur_height}")
  elif [[ "$cur_height" -eq "$prev_height" && -n "$prev_hash" && -n "$cur_hash" && "$cur_hash" != "$prev_hash" ]]; then
    failures+=("FAIL: reorg_detected hash changed at height ${cur_height}")
  fi

  cur_mempool_size="$(printf '%s' "$stats_state" | get_int_field "$stats_state" "mempool_size")"
  prev_mempool_size="$(printf '%s' "$prev_state" | get_int_field "$prev_state" "mempool_size")"
  cur_relay_accept="$(printf '%s' "$stats_state" | get_int_field "$stats_state" "mempool_relay_accept")"
  prev_relay_accept="$(printf '%s' "$prev_state" | get_int_field "$prev_state" "mempool_relay_accept")"

  relay_accept_delta=$((cur_relay_accept - prev_relay_accept))

  if [[ "$cur_height" -gt "$prev_height" && "$cur_mempool_size" -ge "$MEMPOOL_STUCK_MIN_SIZE" && "$cur_mempool_size" -eq "$prev_mempool_size" ]]; then
    failures+=("FAIL: mempool_stuck size=${cur_mempool_size} blocks ${prev_height}->${cur_height}")
  elif [[ "$cur_mempool_size" -ge "$MEMPOOL_STUCK_MIN_SIZE" && "$relay_accept_delta" -lt "$MEMPOOL_ACCEPT_MIN_DELTA" && -n "${peers:-}" && "${peers:-0}" -gt 0 ]]; then
    failures+=("FAIL: mempool_stuck relay_accept_delta=${relay_accept_delta} size=${cur_mempool_size}")
  fi

  if [[ "$P2P_PROBE" == "1" && "$cur_mempool_size" -ge "$MEMPOOL_STUCK_MIN_SIZE" ]]; then
    if ! python3 -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
      failures+=("FAIL: python3 missing")
    elif ! "$(dirname "${BASH_SOURCE[0]}")/p2p_mempool_probe.sh" --addr "$P2P_ADDR" --timeout-secs "$P2P_TIMEOUT_SECS" >/dev/null 2>&1; then
      failures+=("FAIL: p2p_mempool_probe_failed addr=${P2P_ADDR}")
    fi
  fi
fi

if [[ -n "$stats_state" ]]; then
  write_state "$STATE_FILE" "$stats_state"
fi

if [[ ${#failures[@]} -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi

echo "OK"

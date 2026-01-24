#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: backup_volumes.sh [options]

Creates backups of the Docker named volumes used by the explorer stack.

Options:
  --compose-file PATH   Compose file to stop/start (default: docker-compose.vps.yml)
  --project NAME        Compose project name / volume prefix (default: explorer-rust)
  --out-dir DIR         Backup output directory (default: /srv/backups/explorer-rust)

  --fluxd-only          Only back up the fluxd-data volume
  --explorer-only       Only back up the explorer-data volume

  --compression MODE    gz|none (default: gz; avoid gz on low disk)
  --skip-stop           Do not stop the stack (NOT recommended for fluxd-data)
  -h, --help            Show help

Exit codes:
  0 = backups written
  1 = backup failed
  2 = invalid arguments
USAGE
}

COMPOSE_FILE="docker-compose.vps.yml"
PROJECT_NAME="explorer-rust"
OUT_DIR="/srv/backups/explorer-rust"
SKIP_STOP="0"
COMPRESSION="gz"
FLUXD_ONLY="0"
EXPLORER_ONLY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      COMPOSE_FILE="${2:-}"; shift 2;;
    --project)
      PROJECT_NAME="${2:-}"; shift 2;;
    --out-dir)
      OUT_DIR="${2:-}"; shift 2;;
    --compression)
      COMPRESSION="${2:-}"; shift 2;;
    --skip-stop)
      SKIP_STOP="1"; shift;;
    --fluxd-only)
      FLUXD_ONLY="1"; shift;;
    --explorer-only)
      EXPLORER_ONLY="1"; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2;;
  esac
done

if [[ "$COMPRESSION" != "gz" && "$COMPRESSION" != "none" ]]; then
  echo "Invalid --compression: $COMPRESSION" >&2
  exit 2
fi

if [[ "$FLUXD_ONLY" == "1" && "$EXPLORER_ONLY" == "1" ]]; then
  echo "--fluxd-only and --explorer-only are mutually exclusive" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"

date_tag="$(date +%F)"
fluxd_vol="${PROJECT_NAME}_fluxd-data"
explorer_vol="${PROJECT_NAME}_explorer-data"

stopped="0"
cleanup() {
  local exit_code=$?

  if [[ "$SKIP_STOP" != "1" && "$stopped" == "1" ]]; then
    docker compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1 || true
  fi

  exit "$exit_code"
}
trap cleanup EXIT

if [[ "$SKIP_STOP" != "1" ]]; then
  docker compose -f "$COMPOSE_FILE" down
  stopped="1"
fi

backup_volume() {
  local volume="$1"
  local prefix="$2"

  local archive_tmp
  local archive_final

  if [[ "$COMPRESSION" == "gz" ]]; then
    archive_final="${OUT_DIR%/}/${prefix}-${date_tag}.tar.gz"
    archive_tmp="${archive_final}.tmp"
    docker run --rm \
      -v "${volume}:/source:ro" \
      -v "${OUT_DIR}:/backup" \
      busybox \
      sh -lc "tar czf /backup/$(basename "${archive_tmp}") -C /source ."
  else
    archive_final="${OUT_DIR%/}/${prefix}-${date_tag}.tar"
    archive_tmp="${archive_final}.tmp"
    docker run --rm \
      -v "${volume}:/source:ro" \
      -v "${OUT_DIR}:/backup" \
      busybox \
      sh -lc "tar cf /backup/$(basename "${archive_tmp}") -C /source ."
  fi

  mv -f "$archive_tmp" "$archive_final"
  echo "OK: wrote ${archive_final}"
}

if [[ "$EXPLORER_ONLY" != "1" ]]; then
  backup_volume "$fluxd_vol" "fluxd-data"
fi

if [[ "$FLUXD_ONLY" != "1" ]]; then
  backup_volume "$explorer_vol" "explorer-data"
fi

if [[ "$SKIP_STOP" != "1" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d
fi

if [[ -n "$(ls -1 "$OUT_DIR" 2>/dev/null | head -n 1)" ]]; then
  echo "OK: backups available in ${OUT_DIR}"
else
  echo "FAIL: no backups written to ${OUT_DIR}" >&2
  exit 1
fi

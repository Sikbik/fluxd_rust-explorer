#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: backup_volumes.sh [options]

Creates tar.gz backups of the Docker named volumes used by the explorer stack.

This script is designed for VPS usage (Docker Compose). It stops the stack for
consistency, then restarts it.

Options:
  --compose-file PATH   Compose file to stop/start (default: docker-compose.vps.yml)
  --project NAME        Compose project name / volume prefix (default: explorer-rust)
  --out-dir DIR         Backup output directory (default: /srv/backups/explorer-rust)
  --skip-stop           Do not stop the stack (NOT recommended for fluxd-data)
  -h, --help            Show help

USAGE
}

COMPOSE_FILE="docker-compose.vps.yml"
PROJECT_NAME="explorer-rust"
OUT_DIR="/srv/backups/explorer-rust"
SKIP_STOP="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      COMPOSE_FILE="${2:-}"; shift 2;;
    --project)
      PROJECT_NAME="${2:-}"; shift 2;;
    --out-dir)
      OUT_DIR="${2:-}"; shift 2;;
    --skip-stop)
      SKIP_STOP="1"; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2;;
  esac
done

mkdir -p "$OUT_DIR"

date_tag="$(date +%F)"
fluxd_vol="${PROJECT_NAME}_fluxd-data"
explorer_vol="${PROJECT_NAME}_explorer-data"

if [[ "$SKIP_STOP" != "1" ]]; then
  docker compose -f "$COMPOSE_FILE" down
fi

docker run --rm \
  -v "${fluxd_vol}:/source:ro" \
  -v "${OUT_DIR}:/backup" \
  busybox \
  sh -lc "tar czf /backup/fluxd-data-${date_tag}.tar.gz -C /source ."

docker run --rm \
  -v "${explorer_vol}:/source:ro" \
  -v "${OUT_DIR}:/backup" \
  busybox \
  sh -lc "tar czf /backup/explorer-data-${date_tag}.tar.gz -C /source ."

if [[ "$SKIP_STOP" != "1" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d
fi

echo "OK: wrote backups to ${OUT_DIR}"
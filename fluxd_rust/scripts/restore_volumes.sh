#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: restore_volumes.sh [options]

Restores Docker named volumes from backups created by backup_volumes.sh.

Options:
  --compose-file PATH        Compose file to stop/start (default: docker-compose.vps.yml)
  --project NAME             Compose project name / volume prefix (default: explorer-rust)
  --backup-dir DIR           Directory containing tar/tar.gz backups (default: /srv/backups/explorer-rust)
  --date YYYY-MM-DD          Backup date tag to restore (required)

  --fluxd-only               Only restore fluxd-data
  --explorer-only            Only restore explorer-data

  --skip-start               Do not restart compose stack after restore
  -h, --help                 Show help

Exit codes:
  0 = restore complete
  1 = restore failed
  2 = invalid arguments
USAGE
}

COMPOSE_FILE="docker-compose.vps.yml"
PROJECT_NAME="explorer-rust"
BACKUP_DIR="/srv/backups/explorer-rust"
DATE_TAG=""
FLUXD_ONLY="0"
EXPLORER_ONLY="0"
SKIP_START="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      COMPOSE_FILE="${2:-}"; shift 2;;
    --project)
      PROJECT_NAME="${2:-}"; shift 2;;
    --backup-dir)
      BACKUP_DIR="${2:-}"; shift 2;;
    --date)
      DATE_TAG="${2:-}"; shift 2;;
    --fluxd-only)
      FLUXD_ONLY="1"; shift;;
    --explorer-only)
      EXPLORER_ONLY="1"; shift;;
    --skip-start)
      SKIP_START="1"; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2;;
  esac
done

if [[ -z "$DATE_TAG" ]]; then
  echo "Missing --date" >&2
  exit 2
fi

if [[ "$FLUXD_ONLY" == "1" && "$EXPLORER_ONLY" == "1" ]]; then
  echo "--fluxd-only and --explorer-only are mutually exclusive" >&2
  exit 2
fi

fluxd_vol="${PROJECT_NAME}_fluxd-data"
explorer_vol="${PROJECT_NAME}_explorer-data"

fluxd_tar="${BACKUP_DIR%/}/fluxd-data-${DATE_TAG}.tar"
fluxd_tgz="${BACKUP_DIR%/}/fluxd-data-${DATE_TAG}.tar.gz"
explorer_tar="${BACKUP_DIR%/}/explorer-data-${DATE_TAG}.tar"
explorer_tgz="${BACKUP_DIR%/}/explorer-data-${DATE_TAG}.tar.gz"

pick_archive() {
  local tar_path="$1"
  local tgz_path="$2"
  if [[ -f "$tgz_path" ]]; then
    echo "$tgz_path"
    return 0
  fi
  if [[ -f "$tar_path" ]]; then
    echo "$tar_path"
    return 0
  fi
  return 1
}

restore_volume() {
  local volume="$1"
  local archive="$2"

  docker volume create "$volume" >/dev/null

  docker run --rm \
    -v "${volume}:/restore" \
    -v "$(dirname "$archive"):/backup" \
    busybox \
    sh -lc "rm -rf /restore/* && tar xf /backup/$(basename \"$archive\") -C /restore"
}

docker compose -f "$COMPOSE_FILE" down

if [[ "$EXPLORER_ONLY" != "1" ]]; then
  archive="$(pick_archive "$fluxd_tar" "$fluxd_tgz")" || {
    echo "Missing fluxd backup archive for ${DATE_TAG} in ${BACKUP_DIR}" >&2
    exit 1
  }
  restore_volume "$fluxd_vol" "$archive"
  echo "OK: restored ${fluxd_vol} from $(basename "$archive")"
fi

if [[ "$FLUXD_ONLY" != "1" ]]; then
  archive="$(pick_archive "$explorer_tar" "$explorer_tgz")" || {
    echo "Missing explorer backup archive for ${DATE_TAG} in ${BACKUP_DIR}" >&2
    exit 1
  }
  restore_volume "$explorer_vol" "$archive"
  echo "OK: restored ${explorer_vol} from $(basename "$archive")"
fi

if [[ "$SKIP_START" != "1" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d
fi

echo "OK: restore complete"

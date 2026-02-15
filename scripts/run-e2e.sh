#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_NAME="${E2E_PROJECT_NAME:-explore-e2e}"
KEEP_CONTAINERS="${KEEP_E2E_CONTAINERS:-0}"

export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/docker-config}"
mkdir -p "$DOCKER_CONFIG"

compose() {
  docker compose -p "$PROJECT_NAME" -f docker-compose.e2e.yml "$@"
}

cleanup() {
  if [ "$KEEP_CONTAINERS" = "1" ]; then
    echo "Keeping e2e containers (KEEP_E2E_CONTAINERS=1)."
    return
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

compose up --build --abort-on-container-exit --exit-code-from e2e --remove-orphans

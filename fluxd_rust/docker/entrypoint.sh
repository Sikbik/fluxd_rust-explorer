#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-}"
BOOTSTRAP_FORMAT="${BOOTSTRAP_FORMAT:-auto}"
BOOTSTRAP_RESET_ON_INCOMPLETE="${BOOTSTRAP_RESET_ON_INCOMPLETE:-1}"
BOOTSTRAP_PROGRESS="${BOOTSTRAP_PROGRESS:-1}"

if [ -n "$BOOTSTRAP_URL" ]; then
  BOOTSTRAP_URL_SAFE="${BOOTSTRAP_URL%%\?*}"
  BOOTSTRAP_DONE="${DATA_DIR}/.bootstrap_done"
  BOOTSTRAP_IN_PROGRESS="${DATA_DIR}/.bootstrap_in_progress"
  NEED_BOOTSTRAP=0

  if [ -f "$BOOTSTRAP_DONE" ]; then
    echo "Bootstrap: already completed (marker present)."
    NEED_BOOTSTRAP=0
  elif [ -f "$BOOTSTRAP_IN_PROGRESS" ]; then
    echo "Bootstrap: previous run interrupted; will retry."
    NEED_BOOTSTRAP=1
  else
    if [ ! -d "${DATA_DIR}/db" ] || [ -z "$(ls -A "${DATA_DIR}/db" 2>/dev/null)" ]; then
      echo "Bootstrap: db is empty; will download ${BOOTSTRAP_URL_SAFE}"
      NEED_BOOTSTRAP=1
    else
      echo "Bootstrap: db exists; skipping bootstrap."
    fi
  fi

  if [ "$NEED_BOOTSTRAP" -eq 1 ]; then
    if [ -f "$BOOTSTRAP_IN_PROGRESS" ] && [ "$BOOTSTRAP_RESET_ON_INCOMPLETE" = "1" ]; then
      echo "Bootstrap: resetting db/blocks from interrupted bootstrap."
      rm -rf "${DATA_DIR}/db" "${DATA_DIR}/blocks"
    elif [ -f "$BOOTSTRAP_IN_PROGRESS" ]; then
      echo "Bootstrap previously interrupted. Set BOOTSTRAP_RESET_ON_INCOMPLETE=1 to retry."
      exit 1
    fi

    mkdir -p "$DATA_DIR"
    : > "$BOOTSTRAP_IN_PROGRESS"

    FORMAT="$BOOTSTRAP_FORMAT"
    if [ "$FORMAT" = "auto" ]; then
      case "$BOOTSTRAP_URL" in
        *.tar.gz|*.tgz) FORMAT="tar.gz" ;;
        *.tar) FORMAT="tar" ;;
        *.tar.zst|*.tzst) FORMAT="tar.zst" ;;
        *) FORMAT="tar.gz" ;;
      esac
    fi

    echo "Bootstrap: starting (${FORMAT}) from ${BOOTSTRAP_URL_SAFE}..."
    START_TS="$(date +%s 2>/dev/null || echo 0)"
    CURL_FLAGS="-fL --retry 5 --retry-delay 2 --retry-all-errors"
    if [ "$FORMAT" = "tar.gz" ]; then
      if [ "$BOOTSTRAP_PROGRESS" = "1" ] || [ "$BOOTSTRAP_PROGRESS" = "true" ]; then
        curl $CURL_FLAGS "$BOOTSTRAP_URL" | dd bs=4M status=progress | tar -xzf - -C "$DATA_DIR"
      else
        curl $CURL_FLAGS "$BOOTSTRAP_URL" | tar -xzf - -C "$DATA_DIR"
      fi
    elif [ "$FORMAT" = "tar" ]; then
      if [ "$BOOTSTRAP_PROGRESS" = "1" ] || [ "$BOOTSTRAP_PROGRESS" = "true" ]; then
        curl $CURL_FLAGS "$BOOTSTRAP_URL" | dd bs=4M status=progress | tar -xf - -C "$DATA_DIR"
      else
        curl $CURL_FLAGS "$BOOTSTRAP_URL" | tar -xf - -C "$DATA_DIR"
      fi
    elif [ "$FORMAT" = "tar.zst" ]; then
      if command -v zstd >/dev/null 2>&1; then
        if [ "$BOOTSTRAP_PROGRESS" = "1" ] || [ "$BOOTSTRAP_PROGRESS" = "true" ]; then
          curl $CURL_FLAGS "$BOOTSTRAP_URL" | dd bs=4M status=progress | zstd -d -c | tar -xf - -C "$DATA_DIR"
        else
          curl $CURL_FLAGS "$BOOTSTRAP_URL" | zstd -d -c | tar -xf - -C "$DATA_DIR"
        fi
      else
        echo "Bootstrap format tar.zst requires zstd."
        exit 1
      fi
    else
      echo "Unsupported BOOTSTRAP_FORMAT: $FORMAT"
      exit 1
    fi

    rm -f "$BOOTSTRAP_IN_PROGRESS"
    touch "$BOOTSTRAP_DONE"
    END_TS="$(date +%s 2>/dev/null || echo 0)"
    if [ "$START_TS" -gt 0 ] && [ "$END_TS" -gt 0 ]; then
      echo "Bootstrap: completed in $((END_TS - START_TS))s."
    else
      echo "Bootstrap: completed."
    fi
  fi
fi

exec /usr/local/bin/fluxd-cli "$@"

#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-}"
BOOTSTRAP_FORMAT="${BOOTSTRAP_FORMAT:-auto}"
BOOTSTRAP_RESET_ON_INCOMPLETE="${BOOTSTRAP_RESET_ON_INCOMPLETE:-1}"

if [ -n "$BOOTSTRAP_URL" ]; then
  BOOTSTRAP_DONE="${DATA_DIR}/.bootstrap_done"
  BOOTSTRAP_IN_PROGRESS="${DATA_DIR}/.bootstrap_in_progress"
  NEED_BOOTSTRAP=0

  if [ -f "$BOOTSTRAP_DONE" ]; then
    NEED_BOOTSTRAP=0
  elif [ -f "$BOOTSTRAP_IN_PROGRESS" ]; then
    NEED_BOOTSTRAP=1
  else
    if [ ! -d "${DATA_DIR}/db" ] || [ -z "$(ls -A "${DATA_DIR}/db" 2>/dev/null)" ]; then
      NEED_BOOTSTRAP=1
    fi
  fi

  if [ "$NEED_BOOTSTRAP" -eq 1 ]; then
    if [ -f "$BOOTSTRAP_IN_PROGRESS" ] && [ "$BOOTSTRAP_RESET_ON_INCOMPLETE" = "1" ]; then
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

    if [ "$FORMAT" = "tar.gz" ]; then
      curl -fsSL "$BOOTSTRAP_URL" | tar -xzf - -C "$DATA_DIR"
    elif [ "$FORMAT" = "tar" ]; then
      curl -fsSL "$BOOTSTRAP_URL" | tar -xf - -C "$DATA_DIR"
    elif [ "$FORMAT" = "tar.zst" ]; then
      if command -v zstd >/dev/null 2>&1; then
        curl -fsSL "$BOOTSTRAP_URL" | zstd -d -c | tar -xf - -C "$DATA_DIR"
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
  fi
fi

exec /usr/local/bin/fluxd-cli "$@"

#!/bin/sh
set -eu

# Local setting only. Missing config is safe; unreadable/invalid config is not.
if mode=$(git config --local --get erp.hooksMode); then
  :
else
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "Cannot read erp.hooksMode; refusing unguarded hook execution." >&2
    exit "$status"
  fi
  mode=required
fi

case "$mode" in
  portable)
    # Explicit opt-in for an ordinary developer machine, never a shared host.
    exec "$@"
    ;;
  required) ;;
  *)
    echo "Invalid erp.hooksMode: expected required or portable. Hook blocked." >&2
    exit 1
    ;;
esac

# A present but empty override is an error, not a request for the default path.
guard=${RTK_HEAVY_GUARD-${HOME:-}/.codex/rtk-heavy-guard}
if ! command -v rtk >/dev/null 2>&1; then
  echo "Required rtk is unavailable. Restore PATH/tooling; hook blocked." >&2
  exit 1
fi
if [ -z "$guard" ] || [ ! -f "$guard" ] || [ ! -x "$guard" ]; then
  echo "Required resource guard is missing or not executable. Check RTK_HEAVY_GUARD; hook blocked." >&2
  exit 1
fi

# Propagate rejection/abort/checker status. Never retry without the guard.
exec rtk nice -n 10 "$guard" -- "$@"

#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
PROJECT_ENV="${ORDER_SSE_PROJECT_ENV:-/home/ovhtest/projects/erp_dev/.env}"
GUARD="/home/ovhtest/.codex/rtk-heavy-guard"
CORE1_LOCK="/tmp/codex-rtk-heavy-core.1.lock"
CORE2_LOCK="/tmp/codex-rtk-heavy-core.2.lock"

if [[ ! -r "$PROJECT_ENV" ]]; then
  rtk proxy printf 'Order SSE project env is not readable: %s\n' "$PROJECT_ENV" >&2
  exit 75
fi
if [[ ! -x "$GUARD" ]]; then
  rtk proxy printf 'RTK heavy guard is not executable: %s\n' "$GUARD" >&2
  exit 75
fi

exec rtk flock --no-fork --nonblock --conflict-exit-code 75 "$CORE1_LOCK" \
  rtk flock --no-fork --nonblock --conflict-exit-code 75 "$CORE2_LOCK" \
  rtk nice -n 10 taskset -c 0 "$GUARD" -- \
  env DOTENV_CONFIG_PATH="$PROJECT_ENV" \
  NODE_OPTIONS="-r dotenv/config" \
  node "$SCRIPT_DIR/order-sse-rollout.js" "$@"

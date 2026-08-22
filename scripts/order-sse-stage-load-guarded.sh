#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROJECT_ENV="${ORDER_SSE_PROJECT_ENV:-/home/ovhtest/projects/erp_dev/.env}"
LOG_ROOT="${ORDER_SSE_STAGE_LOAD_LOG_ROOT:-/home/ovhtest/projects/erp_dev/spec_erp/logs/order-sse-load}"
GUARD="/home/ovhtest/.codex/rtk-heavy-guard"
CORE1_LOCK="/tmp/codex-rtk-heavy-core.1.lock"
CORE2_LOCK="/tmp/codex-rtk-heavy-core.2.lock"
STAGE_LOAD_LOCK="/tmp/erp-order-sse-shared-stage-load.lock"
RUN_ID="${ORDER_SSE_STAGE_LOAD_RUN_ID:-$(rtk date -u +%Y%m%dt%H%M%Sz)-stage-load}"
ORDER_ID="${ORDER_SSE_STAGE_LOAD_ORDER_ID:-11569}"
CLEANUP_UNIT="order-sse-stage-load-cleanup-${RUN_ID}"
CLEANUP_FALLBACK_ARMED=0
CLEANUP_REQUIRED=0
CLEANUP_STARTED=0

if [[ ! -r "$PROJECT_ENV" ]]; then
  rtk proxy printf 'Order SSE project env is not readable: %s\n' "$PROJECT_ENV" >&2
  exit 75
fi
if [[ ! -x "$GUARD" ]]; then
  rtk proxy printf 'RTK heavy guard is not executable: %s\n' "$GUARD" >&2
  exit 75
fi
if [[ ! -e /home/ovhtest/projects/erp_dev/.shared-host-no-sse-load ]]; then
  rtk proxy printf 'Shared-host safety marker is missing\n' >&2
  exit 75
fi
if [[ "$(rtk nproc)" != "4" ]]; then
  rtk proxy printf 'Shared-stage SSE load requires exactly four online CPUs\n' >&2
  exit 75
fi
if ! rtk grep -q '^ERP_WORKER_PASSWORD=' "$PROJECT_ENV"; then
  rtk proxy printf 'ERP_WORKER_PASSWORD is missing from project env\n' >&2
  exit 75
fi
if ! rtk grep -q -E '^(HASURA_JWT_SECRET|JWT_ACCESS_SECRET)=' "$PROJECT_ENV"; then
  rtk proxy printf 'JWT signing secret is missing from project env\n' >&2
  exit 75
fi

read -r CANONICAL_SHA _ < <(rtk git -C "$REPO_ROOT" ls-remote origin refs/heads/feat/backend-erp-stage1)
rtk git -C "$REPO_ROOT" fetch --quiet origin feat/backend-erp-stage1
EXPECTED_SHA="${ORDER_SSE_EXPECTED_STAGE_SHA:-$CANONICAL_SHA}"
if [[ "$EXPECTED_SHA" != "$CANONICAL_SHA" ]]; then
  rtk proxy printf 'Expected SHA is not canonical stage: expected=%s canonical=%s\n' "$EXPECTED_SHA" "$CANONICAL_SHA" >&2
  exit 75
fi
LIVE_BACKEND_SHA="$(rtk node -e '
fetch("https://backend-test.mebelkz.app/health/ready")
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((body) => process.stdout.write(String(body?.deployment?.gitCommitSha || "")))
  .catch((error) => {
    process.stderr.write(`Backend SHA preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  });
')"
EXPECTED_BACKEND_SHA="${ORDER_SSE_EXPECTED_BACKEND_SHA:-$LIVE_BACKEND_SHA}"
if [[ ! "$EXPECTED_BACKEND_SHA" =~ ^[0-9a-f]{40}$ || "$EXPECTED_BACKEND_SHA" != "$LIVE_BACKEND_SHA" ]]; then
  rtk proxy printf 'Expected backend SHA is invalid or not currently deployed\n' >&2
  exit 75
fi
if ! rtk git -C "$REPO_ROOT" merge-base --is-ancestor "$EXPECTED_BACKEND_SHA" "$EXPECTED_SHA"; then
  rtk proxy printf 'Deployed backend SHA is not an ancestor of canonical stage\n' >&2
  exit 75
fi
if ! rtk git -C "$REPO_ROOT" diff --quiet "$EXPECTED_BACKEND_SHA..$EXPECTED_SHA" -- backend; then
  rtk proxy printf 'Canonical stage contains backend changes missing from the deployed backend image\n' >&2
  exit 75
fi

export ORDER_SSE_LOAD_APPROVE_SHARED_STAGE=true
export ERP_WORKER_LOGIN=packer

LOAD_ARGS=(
  --target-env shared-stage
  --backend-url https://backend-test.mebelkz.app/api/v1
  --log-root "$LOG_ROOT"
  --clients 200
  --connections-per-user 3
  --reconnect-rounds 2
  --round-seconds 180
  --ramp-clients 25,50,100,200
  --stage-step-seconds 45
  --open-batch-size 5
  --open-batch-delay-ms 250
  --expected-stage-sha "$EXPECTED_SHA"
  --expected-backend-sha "$EXPECTED_BACKEND_SHA"
  --run-id "$RUN_ID"
  --seed-user-id 83
  --order-id "$ORDER_ID"
)

cleanup() {
  local exit_status=$?
  if [[ "$CLEANUP_STARTED" == "1" ]]; then
    return "$exit_status"
  fi
  CLEANUP_STARTED=1
  trap - EXIT INT TERM
  if [[ "$CLEANUP_REQUIRED" != "1" ]]; then
    return "$exit_status"
  fi
  if rtk node --env-file="$PROJECT_ENV" "$SCRIPT_DIR/order-sse-load.js" \
    --target-env shared-stage \
    --cleanup-run-id "$RUN_ID"; then
    if [[ "$CLEANUP_FALLBACK_ARMED" == "1" ]]; then
      rtk systemctl --user stop "${CLEANUP_UNIT}.timer" "${CLEANUP_UNIT}.service" >/dev/null 2>&1 || true
      rtk systemctl --user reset-failed "${CLEANUP_UNIT}.service" >/dev/null 2>&1 || true
    fi
  else
    exit_status=1
  fi
  return "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

exec 9>"$STAGE_LOAD_LOCK"
if ! rtk flock --nonblock 9; then
  rtk proxy printf 'Another shared-stage SSE load owns the stage lock\n' >&2
  exit 75
fi

rtk node --env-file="$PROJECT_ENV" "$SCRIPT_DIR/order-sse-load.js" \
  "${LOAD_ARGS[@]}" \
  --preflight-only

rtk systemd-run --user \
  --unit="$CLEANUP_UNIT" \
  --on-active=30m \
  --collect \
  --property=KillMode=mixed \
  --property=TimeoutStartSec=60s \
  --setenv=PATH="$PATH" \
  --setenv=ORDER_SSE_LOAD_APPROVE_SHARED_STAGE=true \
  "$(rtk which node)" --env-file="$PROJECT_ENV" "$SCRIPT_DIR/order-sse-load.js" \
    --target-env shared-stage \
    --cleanup-run-id "$RUN_ID"
CLEANUP_FALLBACK_ARMED=1
CLEANUP_REQUIRED=1

# Idempotent exact-run cleanup before admission; never touches another run id.
rtk node --env-file="$PROJECT_ENV" "$SCRIPT_DIR/order-sse-load.js" \
  --target-env shared-stage \
  --cleanup-run-id "$RUN_ID"

rtk mpstat -P ALL 1 1

set +e
rtk flock --no-fork --nonblock --conflict-exit-code 75 "$CORE1_LOCK" \
  rtk flock --no-fork --nonblock --conflict-exit-code 75 "$CORE2_LOCK" \
  rtk nice -n 10 taskset -c 0 "$GUARD" -- \
  node --env-file="$PROJECT_ENV" "$SCRIPT_DIR/order-sse-load.js" \
    "${LOAD_ARGS[@]}"
LOAD_STATUS=$?
set -e

read -r FINAL_CANONICAL_SHA _ < <(rtk git -C "$REPO_ROOT" ls-remote origin refs/heads/feat/backend-erp-stage1)
if [[ "$FINAL_CANONICAL_SHA" != "$EXPECTED_SHA" ]]; then
  rtk proxy printf 'Canonical stage SHA changed during load: expected=%s final=%s\n' \
    "$EXPECTED_SHA" "$FINAL_CANONICAL_SHA" >&2
  LOAD_STATUS=1
fi

exit "$LOAD_STATUS"

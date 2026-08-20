#!/usr/bin/env bash
set -Eeuo pipefail

readonly STATE_DIR="${HOME}/.local/state/erp-order-sse"
readonly LOG_ROOT="/home/ovhtest/projects/erp_dev/spec_erp/logs/order-sse-continuous"
readonly EXPECTED_SHA="${ORDER_SSE_EXPECTED_STAGE_SHA:?ORDER_SSE_EXPECTED_STAGE_SHA is required}"
readonly RUNNER_DIR="${ORDER_SSE_RUNNER_DIR:?ORDER_SSE_RUNNER_DIR is required}"
child_pid=""

if [[ "$RUNNER_DIR" != /* || ! -r "$RUNNER_DIR/candidate.sha" ]]; then
  printf 'Order SSE candidate bundle is missing or invalid.\n' >&2
  exit 75
fi
IFS= read -r bundled_sha <"$RUNNER_DIR/candidate.sha" || bundled_sha=""
if [[ "$bundled_sha" != "$EXPECTED_SHA" ]]; then
  printf 'Order SSE candidate bundle SHA mismatch.\n' >&2
  exit 75
fi
for required_file in order-sse-guarded-run.sh order-sse-rollout.js order-sse-rollout-lib.js; do
  if [[ ! -r "$RUNNER_DIR/$required_file" ]]; then
    printf 'Order SSE candidate bundle file missing: %s\n' "$required_file" >&2
    exit 75
  fi
done

forward_signal() {
  local signal="$1"
  if [[ -n "$child_pid" ]]; then
    kill -s "$signal" "$child_pid" 2>/dev/null || true
  fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

mkdir -p "$STATE_DIR" "$LOG_ROOT"
find "$LOG_ROOT" -maxdepth 1 -type f \
  \( -name '*.jsonl' -o -name '*.summary.json' \) \
  -mtime +30 -delete
find "$STATE_DIR" -maxdepth 1 -type f -name 'skips-*.jsonl' -mtime +30 -delete

set +e
ORDER_SSE_ROLLOUT_APPROVE_STAGE=true \
  "$RUNNER_DIR/order-sse-guarded-run.sh" \
  --mode accelerated-soak \
  --apply \
  --expected-stage-sha "$EXPECTED_SHA" \
  --samples 1 \
  --sample-interval-seconds 60 \
  --auth-refresh-every 1 \
  --log-root "$LOG_ROOT" &
child_pid=$!

while true; do
  wait "$child_pid"
  status=$?
  if ! kill -0 "$child_pid" 2>/dev/null; then
    break
  fi
done
set -e
trap - TERM INT

if [[ "$status" == "75" ]]; then
  printf '{"at":"%s","event":"monitor_skipped","reason":"guard_admission_denied","expectedStageSha":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXPECTED_SHA" \
    >>"$STATE_DIR/skips-$(date -u +%Y-%m-%d).jsonl"
  exit 0
fi

exit "$status"

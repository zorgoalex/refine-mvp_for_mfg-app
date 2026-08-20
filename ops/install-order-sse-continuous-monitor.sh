#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_DIR="$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)"
readonly UNIT_SOURCE="$REPO_DIR/ops/systemd"
readonly UNIT_TARGET="${HOME}/.config/systemd/user"
readonly STATE_DIR="${HOME}/.local/state/erp-order-sse"
readonly BUNDLE_ROOT="${HOME}/.local/libexec/erp-order-sse"
readonly SHA="${1:-}"

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'usage: %s <40-hex-stage-sha>\n' "$0" >&2
  exit 64
fi

if systemctl --user is-enabled --quiet order-sse-continuous-monitor.timer; then
  printf 'Disable the monitor timer before changing its expected SHA.\n' >&2
  exit 75
fi

if systemctl --user is-active --quiet order-sse-continuous-monitor.timer \
  || systemctl --user is-active --quiet order-sse-continuous-monitor.service; then
  printf 'Stop the active monitor timer/service before changing its expected SHA.\n' >&2
  exit 75
fi

actual_sha="$(git -C "$REPO_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
if [[ "$actual_sha" != "$SHA" ]]; then
  printf 'Installer checkout SHA must equal requested stage SHA.\n' >&2
  exit 75
fi
if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=normal)" ]]; then
  printf 'Installer checkout must be clean before creating exact-SHA bundle.\n' >&2
  exit 75
fi

candidate_dir="$BUNDLE_ROOT/candidates/$SHA"
mkdir -p "$UNIT_TARGET" "$STATE_DIR" "$candidate_dir"
install -m 0555 "$REPO_DIR/scripts/order-sse-guarded-run.sh" "$candidate_dir/"
install -m 0555 "$REPO_DIR/scripts/order-sse-rollout.js" "$candidate_dir/"
install -m 0444 "$REPO_DIR/scripts/order-sse-rollout-lib.js" "$candidate_dir/"
[[ ! -e "$candidate_dir/candidate.sha" ]] || chmod 0600 "$candidate_dir/candidate.sha"
printf '%s\n' "$SHA" >"$candidate_dir/candidate.sha"
chmod 0444 "$candidate_dir/candidate.sha"
install -m 0555 "$REPO_DIR/ops/order-sse-continuous-once.sh" "$BUNDLE_ROOT/"
install -m 0644 "$UNIT_SOURCE/order-sse-continuous-monitor.service" "$UNIT_TARGET/"
install -m 0644 "$UNIT_SOURCE/order-sse-continuous-monitor.timer" "$UNIT_TARGET/"
printf 'ORDER_SSE_EXPECTED_STAGE_SHA=%s\nORDER_SSE_RUNNER_DIR=%s\n' \
  "$SHA" "$candidate_dir" >"$STATE_DIR/continuous.env"
chmod 0600 "$STATE_DIR/continuous.env"
systemctl --user daemon-reload
printf 'Prepared only. Start later with: systemctl --user enable --now order-sse-continuous-monitor.timer\n'
printf 'Before changing the stage SHA: systemctl --user disable --now order-sse-continuous-monitor.timer\n'

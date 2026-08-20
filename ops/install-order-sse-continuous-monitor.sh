#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_DIR="$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)"
readonly UNIT_SOURCE="$REPO_DIR/ops/systemd"
readonly UNIT_TARGET="${HOME}/.config/systemd/user"
readonly STATE_DIR="${HOME}/.local/state/erp-order-sse"
readonly SHA="${1:-}"

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'usage: %s <40-hex-stage-sha>\n' "$0" >&2
  exit 64
fi

if systemctl --user is-active --quiet order-sse-continuous-monitor.timer; then
  printf 'Stop the active timer before changing its expected SHA.\n' >&2
  exit 75
fi

mkdir -p "$UNIT_TARGET" "$STATE_DIR"
install -m 0644 "$UNIT_SOURCE/order-sse-continuous-monitor.service" "$UNIT_TARGET/"
install -m 0644 "$UNIT_SOURCE/order-sse-continuous-monitor.timer" "$UNIT_TARGET/"
printf 'ORDER_SSE_EXPECTED_STAGE_SHA=%s\n' "$SHA" >"$STATE_DIR/continuous.env"
chmod 0600 "$STATE_DIR/continuous.env"
systemctl --user daemon-reload
printf 'Prepared only. Start later with: systemctl --user enable --now order-sse-continuous-monitor.timer\n'
printf 'Before changing the stage SHA: systemctl --user disable --now order-sse-continuous-monitor.timer\n'

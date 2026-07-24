#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$SCRIPT_PATH/../.." && pwd)"

ENV_FILE="${ENV_FILE:-$ROOT/.env}"
VPS_FILE="${VPS_FILE:-$ROOT/repo_erp/ops/templates/docker-compose.vps.yml}"
PROJECT="${COMPOSE_PROJECT_NAME_OVERRIDE:-erp_test}"

err() { printf 'cnc-telegram-worker: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
cnc-telegram-worker.sh

Usage:
  repo_erp/ops/cnc-telegram-worker.sh up
  repo_erp/ops/cnc-telegram-worker.sh login
  repo_erp/ops/cnc-telegram-worker.sh backfill [days]
  repo_erp/ops/cnc-telegram-worker.sh logs
  repo_erp/ops/cnc-telegram-worker.sh ps
EOF
}

load_profile() {
  local line raw
  line="$(grep -E '^[[:space:]]*COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  raw="${line#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  if [[ ",$raw," == *",cnc-telegram,"* ]]; then
    export COMPOSE_PROFILES="$raw"
  elif [[ -n "$raw" ]]; then
    export COMPOSE_PROFILES="$raw,cnc-telegram"
  else
    export COMPOSE_PROFILES="cnc-telegram"
  fi
}

compose() {
  ( cd "$ROOT" && docker compose \
      --project-directory "$ROOT" \
      -p "$PROJECT" \
      --env-file "$ENV_FILE" \
      -f "$VPS_FILE" \
      "$@" )
}

[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE"
[[ -f "$VPS_FILE" ]] || die "compose template not found at $VPS_FILE"
load_profile

cmd="${1:-}"
[[ -n "$cmd" ]] || { usage; exit 2; }
shift || true

case "$cmd" in
  up)
    compose up -d --build glm-ocr-model-init glm-ocr-llama glm-ocr-runner cnc-telegram-worker
    ;;
  login)
    compose run --rm cnc-telegram-worker login
    ;;
  backfill)
    days="${1:-7}"
    compose run --rm cnc-telegram-worker once --days "$days"
    ;;
  logs)
    compose logs -f cnc-telegram-worker glm-ocr-runner glm-ocr-llama
    ;;
  ps)
    compose ps glm-ocr-model-init glm-ocr-llama glm-ocr-runner cnc-telegram-worker
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    die "unknown command '$cmd' (try: up, login, backfill, logs, ps)"
    ;;
esac

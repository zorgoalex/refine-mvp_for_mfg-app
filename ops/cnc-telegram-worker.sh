#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$SCRIPT_PATH/../.." && pwd)"

ENV_FILE="${ENV_FILE:-$ROOT/.env}"
VPS_FILE="${VPS_FILE:-$ROOT/repo_erp/ops/templates/docker-compose.vps.yml}"
PROJECT="${COMPOSE_PROJECT_NAME_OVERRIDE:-}"
COMPOSE_FILE_ARGS=()

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

env_value() {
  local name="$1" line raw
  line="$(grep -E "^[[:space:]]*${name}=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  raw="${line#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  printf '%s' "$raw"
}

preflight_worker_role() {
  local stack_env role allow
  stack_env="$(env_value ERP_STACK_ENV)"
  stack_env="${stack_env:-test}"
  role="$(env_value CNC_TELEGRAM_WORKER_ROLE)"
  if [[ -z "$role" && "$stack_env" == "prod" ]]; then
    role="writer"
  else
    role="${role:-disabled}"
  fi
  allow="$(env_value CNC_TELEGRAM_ALLOW_NON_PROD_WRITER)"
  allow="${allow:-false}"

  if [[ "$role" != "writer" ]]; then
    err "CNC Telegram worker is disabled (ERP_STACK_ENV=$stack_env, CNC_TELEGRAM_WORKER_ROLE=$role)"
    return 1
  fi
  if [[ "$stack_env" != "prod" && "$allow" != "true" ]]; then
    die "refusing Telegram writer on ERP_STACK_ENV=$stack_env; set ERP_STACK_ENV=prod or CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=true for a deliberate one-off run"
  fi
}

prepare_compose_file_args() {
  local stack_env overlay
  COMPOSE_FILE_ARGS=(-f "$VPS_FILE")
  stack_env="$(env_value ERP_STACK_ENV)"
  stack_env="${stack_env:-test}"
  overlay="$ROOT/repo_erp/ops/templates/docker-compose.${stack_env}.yml"
  if [[ -f "$overlay" ]]; then
    COMPOSE_FILE_ARGS+=(-f "$overlay")
  fi
}

compose() {
  ( cd "$ROOT" && docker compose \
      --project-directory "$ROOT" \
      -p "$PROJECT" \
      --env-file "$ENV_FILE" \
      "${COMPOSE_FILE_ARGS[@]}" \
      "$@" )
}

[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE"
[[ -f "$VPS_FILE" ]] || die "compose template not found at $VPS_FILE"
PROJECT="${PROJECT:-$(env_value COMPOSE_PROJECT_NAME)}"
PROJECT="${PROJECT:-erp_test}"
prepare_compose_file_args
load_profile

cmd="${1:-}"
[[ -n "$cmd" ]] || { usage; exit 2; }
shift || true

case "$cmd" in
  up)
    preflight_worker_role || exit 0
    compose up -d --build glm-ocr-model-init glm-ocr-llama glm-ocr-runner cnc-telegram-worker
    ;;
  login)
    compose run --rm cnc-telegram-worker login
    ;;
  backfill)
    preflight_worker_role || exit 0
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

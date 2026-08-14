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
  repo_erp/ops/cnc-telegram-worker.sh up-glm
  repo_erp/ops/cnc-telegram-worker.sh login
  repo_erp/ops/cnc-telegram-worker.sh backfill [days]
  repo_erp/ops/cnc-telegram-worker.sh svg-refresh-backfill [days] [--write] [--date YYYY-MM-DD]
  repo_erp/ops/cnc-telegram-worker.sh logs
  repo_erp/ops/cnc-telegram-worker.sh logs-glm
  repo_erp/ops/cnc-telegram-worker.sh ps
  repo_erp/ops/cnc-telegram-worker.sh ps-glm
EOF
}

profile_enabled() {
  local needle="$1" csv="${COMPOSE_PROFILES:-}" part
  local -a parts
  IFS=',' read -ra parts <<< "$csv"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [[ "$part" == "$needle" ]] && return 0
  done
  return 1
}

enable_profile() {
  local name="$1"
  profile_enabled "$name" && return 0
  if [[ -n "${COMPOSE_PROFILES:-}" ]]; then
    export COMPOSE_PROFILES="${COMPOSE_PROFILES},${name}"
  else
    export COMPOSE_PROFILES="$name"
  fi
}

load_profile() {
  local line raw
  line="$(grep -E '^[[:space:]]*COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  raw="${line#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  export COMPOSE_PROFILES="$raw"
  enable_profile cnc-telegram
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

  case "$role" in
    disabled)
      err "CNC Telegram worker is disabled (ERP_STACK_ENV=$stack_env, CNC_TELEGRAM_WORKER_ROLE=$role)"
      return 1
      ;;
    reader)
      ;;
    writer)
      if [[ "$stack_env" != "prod" && "$allow" != "true" ]]; then
        die "refusing Telegram writer on ERP_STACK_ENV=$stack_env; set ERP_STACK_ENV=prod or CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=true for a deliberate one-off run"
      fi
      ;;
    *)
      die "CNC_TELEGRAM_WORKER_ROLE must be one of: disabled, reader, writer"
      ;;
  esac
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

stop_glm() {
  local containers
  containers="$(compose ps -aq glm-ocr-model-init glm-ocr-llama glm-ocr-runner)"
  [[ -n "$containers" ]] || return 0
  err "stopping unused GLM-OCR fallback containers (model cache is preserved)"
  compose stop glm-ocr-runner glm-ocr-llama glm-ocr-model-init
  compose rm -f glm-ocr-runner glm-ocr-llama glm-ocr-model-init
}

start_glm() {
  local client_timeout runner_timeout
  enable_profile cnc-telegram-glm
  client_timeout="${GLM_OCR_CLIENT_TIMEOUT_SECONDS:-$(env_value GLM_OCR_CLIENT_TIMEOUT_SECONDS)}"
  client_timeout="${client_timeout:-660}"
  runner_timeout="${GLM_OCR_TIMEOUT_SECONDS:-$(env_value GLM_OCR_TIMEOUT_SECONDS)}"
  runner_timeout="${runner_timeout:-600}"
  [[ "$client_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "GLM_OCR_CLIENT_TIMEOUT_SECONDS must be a positive integer"
  [[ "$runner_timeout" =~ ^[1-9][0-9]*$ ]] \
    || die "GLM_OCR_TIMEOUT_SECONDS must be a positive integer"
  (( 10#$client_timeout > 10#$runner_timeout )) \
    || die "GLM_OCR_CLIENT_TIMEOUT_SECONDS must exceed GLM_OCR_TIMEOUT_SECONDS"
  export CNC_ENABLE_GLM_OCR="true"
  export CNC_OCR_COMMAND="python -m cnc_telegram_worker.glm_ocr_client --image {image}"
  export CNC_OCR_COMMAND_TIMEOUT_SECONDS="$((10#$client_timeout + 60))"
  export CNC_OCR_ENGINE="glm-ocr-0.9b-q8"
  # Do not let the worker persist a warning-only GLM fingerprint during model
  # startup. The runner healthcheck also verifies that llama is reachable.
  compose up -d --build --wait --wait-timeout 1800 glm-ocr-runner
  compose up -d --build cnc-telegram-worker
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
    if ! profile_enabled cnc-telegram-glm; then
      stop_glm
    fi
    preflight_worker_role || exit 0
    if profile_enabled cnc-telegram-glm; then
      start_glm
    else
      compose up -d --build cnc-telegram-worker
    fi
    ;;
  up-glm)
    preflight_worker_role || exit 0
    start_glm
    ;;
  login)
    compose run --rm cnc-telegram-worker login
    ;;
  backfill)
    preflight_worker_role || exit 0
    days="${1:-7}"
    compose run --rm cnc-telegram-worker once --days "$days"
    ;;
  svg-refresh-backfill)
    preflight_worker_role || exit 0
    if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
      days="$1"
      shift
    else
      days="7"
    fi
    compose run --rm cnc-telegram-worker svg-refresh-backfill --days "$days" "$@"
    ;;
  logs)
    compose logs -f cnc-telegram-worker
    ;;
  logs-glm)
    enable_profile cnc-telegram-glm
    compose logs -f cnc-telegram-worker glm-ocr-runner glm-ocr-llama
    ;;
  ps)
    compose ps cnc-telegram-worker
    ;;
  ps-glm)
    enable_profile cnc-telegram-glm
    compose ps glm-ocr-model-init glm-ocr-llama glm-ocr-runner cnc-telegram-worker
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    die "unknown command '$cmd' (try: up, up-glm, login, backfill, svg-refresh-backfill, logs, logs-glm, ps, ps-glm)"
    ;;
esac

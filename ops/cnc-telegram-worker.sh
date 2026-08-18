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
  repo_erp/ops/cnc-telegram-worker.sh backfill [days]  # disabled; use approved once directly
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

assert_serve_command_source() {
  local file
  for file in "${COMPOSE_FILE_ARGS[@]}"; do
    [[ "$file" == "-f" ]] && continue
    if grep -Eq 'command:[[:space:]]*\["daemon"\]' "$file"; then
      die "refusing worker deployment: Compose command daemon is forbidden after Phase A"
    fi
  done
  grep -Eq 'command:[[:space:]]*\["serve"\]' "$VPS_FILE" \
    || die "refusing worker deployment: Compose worker command must be serve"
}

ensure_worker_image_revision() {
  local revision candidate
  revision=""
  for candidate in "$ROOT/repo_erp" "$SCRIPT_PATH/.."; do
    if revision="$(git -C "$candidate" rev-parse --verify HEAD 2>/dev/null)" && [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
      break
    fi
    revision=""
  done
  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    revision="${CNC_TELEGRAM_WORKER_IMAGE_REVISION:-$(env_value CNC_TELEGRAM_WORKER_IMAGE_REVISION)}"
  fi
  [[ "$revision" =~ ^[0-9a-f]{7,64}$ ]] \
    || die "refusing worker deployment: CNC_TELEGRAM_WORKER_IMAGE_REVISION must be an immutable git revision"
  export CNC_TELEGRAM_WORKER_IMAGE_REVISION="$revision"
}

assert_rendered_serve_command() {
  local rendered
  rendered="$(compose config --format json 2>/dev/null)" \
    || die "refusing worker deployment: failed to render merged Compose config"
  python3 -c 'import json, sys
data = json.load(sys.stdin)
command = data.get("services", {}).get("cnc-telegram-worker", {}).get("command")
if command != ["serve"]:
    raise SystemExit(f"rendered worker command must be exactly [serve], got {command!r}")
' <<<"$rendered" \
    || die "refusing worker deployment: rendered worker command must be exactly serve"
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
assert_serve_command_source

cmd="${1:-}"
[[ -n "$cmd" ]] || { usage; exit 2; }
shift || true

case "$cmd" in
  up)
    ensure_worker_image_revision
    assert_rendered_serve_command
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
    ensure_worker_image_revision
    assert_rendered_serve_command
    preflight_worker_role || exit 0
    start_glm
    ;;
  login)
    compose run --rm cnc-telegram-worker login
    ;;
  backfill)
    die "backfill helper is disabled after Phase A; run `once --days 1..31 --scan-request-id <approved-id>` directly"
    ;;
  svg-refresh-backfill)
    die "svg-refresh-backfill is disabled after Phase A; history reads require the Phase B persisted scan flow"
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

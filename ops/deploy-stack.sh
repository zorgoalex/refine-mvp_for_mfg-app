#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$REPO_DIR"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
CNC_TELEGRAM_OVERLAY="$REPO_DIR/ops/templates/docker-compose.cnc-telegram-worker.yml"
COMPOSE_FILE_ARGS=()
PULL=1
BUILD=1
FORCE_RECREATE=0
SKIP_CHECK=0
BUILD_ONLY=0
ENV_FILE_ARG_SET=0
COMPOSE_FILE_ARG_SET=0

usage() {
  cat <<'EOF'
deploy-stack.sh

Deploy or update the ERP VPS Docker stack.

Usage:
  ops/deploy-stack.sh [--project-dir PATH] [--env-file PATH] [--compose-file PATH] [--no-pull]
                      [--no-build] [--build-only] [--force-recreate] [--skip-check]
EOF
}

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

load_compose_profiles() {
  local line raw
  line="$(grep -E '^[[:space:]]*COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  raw="${line#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  export COMPOSE_PROFILES="$raw"
}

compose_profile_enabled() {
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

prepare_compose_file_args() {
  COMPOSE_FILE_ARGS=(-f "$COMPOSE_FILE")
  if compose_profile_enabled cnc-telegram && ! grep -qE '^[[:space:]]+cnc-telegram-worker:' "$COMPOSE_FILE"; then
    [[ -f "$CNC_TELEGRAM_OVERLAY" ]] || fail "CNC Telegram overlay not found: $CNC_TELEGRAM_OVERLAY"
    COMPOSE_FILE_ARGS+=(-f "$CNC_TELEGRAM_OVERLAY")
    log "Using CNC Telegram worker overlay for existing Compose file"
  fi
}

docker_compose() {
  docker compose --env-file "$ENV_FILE" "${COMPOSE_FILE_ARGS[@]}" "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; ENV_FILE_ARG_SET=1; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; COMPOSE_FILE_ARG_SET=1; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --no-build) BUILD=0; shift ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --force-recreate) FORCE_RECREATE=1; shift ;;
    --skip-check) SKIP_CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
[[ "$ENV_FILE_ARG_SET" == "0" ]] && ENV_FILE="$PROJECT_DIR/.env"
[[ "$COMPOSE_FILE_ARG_SET" == "0" ]] && COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
load_compose_profiles

if [[ ! -f "$COMPOSE_FILE" ]]; then
  cp "$REPO_DIR/ops/templates/docker-compose.vps.yml" "$COMPOSE_FILE"
  log "Created $COMPOSE_FILE from template"
fi
prepare_compose_file_args

mkdir -p \
  "$PROJECT_DIR/config/postgres" \
  "$PROJECT_DIR/data/postgres/main" \
  "$PROJECT_DIR/data/postgres/hasura_md" \
  "$PROJECT_DIR/data/traefik" \
  "$PROJECT_DIR/backups" \
  "$PROJECT_DIR/restore"

if [[ ! -f "$PROJECT_DIR/config/postgres/pg_hba.conf" ]]; then
  cp "$REPO_DIR/ops/templates/pg_hba.vps.conf" "$PROJECT_DIR/config/postgres/pg_hba.conf"
  log "Created config/postgres/pg_hba.conf from template"
fi

if [[ "$SKIP_CHECK" == "0" ]]; then
  "$REPO_DIR/ops/check-env.sh" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE"
fi

cd "$PROJECT_DIR"

if [[ "$PULL" == "1" ]]; then
  log "Pulling base images"
  docker_compose pull traefik postgresdb hasura_metadata_db hasura
fi

if [[ "$BUILD_ONLY" == "1" ]]; then
  [[ "$BUILD" == "1" ]] || fail "--build-only cannot be combined with --no-build"
  log "Building source images"
  docker_compose build
  exit 0
fi

up_args=(up -d)
[[ "$BUILD" == "1" ]] && up_args+=(--build)
[[ "$FORCE_RECREATE" == "1" ]] && up_args+=(--force-recreate)

log "Starting stack"
docker_compose "${up_args[@]}"

log "Current services"
docker_compose ps

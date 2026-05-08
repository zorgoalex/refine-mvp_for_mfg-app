#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
PULL=1
BUILD=1
FORCE_RECREATE=0
SKIP_CHECK=0

usage() {
  cat <<'EOF'
deploy-stack.sh

Deploy or update the ERP VPS Docker stack.

Usage:
  ops/deploy-stack.sh [--env-file PATH] [--compose-file PATH] [--no-pull]
                      [--no-build] [--force-recreate] [--skip-check]
EOF
}

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --no-build) BUILD=0; shift ;;
    --force-recreate) FORCE_RECREATE=1; shift ;;
    --skip-check) SKIP_CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  cp "$PROJECT_DIR/ops/templates/docker-compose.vps.yml" "$COMPOSE_FILE"
  log "Created $COMPOSE_FILE from template"
fi

mkdir -p \
  "$PROJECT_DIR/config/postgres" \
  "$PROJECT_DIR/data/postgres/main" \
  "$PROJECT_DIR/data/postgres/hasura_md" \
  "$PROJECT_DIR/data/traefik" \
  "$PROJECT_DIR/backups" \
  "$PROJECT_DIR/restore"

if [[ ! -f "$PROJECT_DIR/config/postgres/pg_hba.conf" ]]; then
  cp "$PROJECT_DIR/ops/templates/pg_hba.vps.conf" "$PROJECT_DIR/config/postgres/pg_hba.conf"
  log "Created config/postgres/pg_hba.conf from template"
fi

if [[ "$SKIP_CHECK" == "0" ]]; then
  "$PROJECT_DIR/ops/check-env.sh" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE"
fi

cd "$PROJECT_DIR"

if [[ "$PULL" == "1" ]]; then
  log "Pulling base images"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull traefik postgresdb hasura_metadata_db hasura
fi

up_args=(up -d)
[[ "$BUILD" == "1" ]] && up_args+=(--build)
[[ "$FORCE_RECREATE" == "1" ]] && up_args+=(--force-recreate)

log "Starting stack"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "${up_args[@]}"

log "Current services"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

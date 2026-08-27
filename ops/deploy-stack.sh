#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$REPO_DIR"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
CNC_TELEGRAM_OVERLAY="$REPO_DIR/ops/templates/docker-compose.cnc-telegram-worker.yml"
BACKEND_IDENTITY_OVERLAY="$REPO_DIR/ops/templates/docker-compose.backend-build-identity.yml"
STACK_ENV_OVERLAY=""
COMPOSE_FILE_ARGS=()
PULL=1
BUILD=1
FORCE_RECREATE=0
SKIP_CHECK=0
BUILD_ONLY=0
ENV_FILE_ARG_SET=0
COMPOSE_FILE_ARG_SET=0

resolve_backend_build_sha() {
  local revision requested requested_context backend_context resolved_context requested_image expected_image
  revision="$(git -C "$REPO_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "cannot resolve immutable backend build SHA"
  [[ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=normal)" ]] \
    || fail "repository must be clean before publishing BACKEND_BUILD_SHA"
  requested="${BACKEND_BUILD_SHA:-}"
  if [[ -n "$requested" && "$requested" != "$revision" ]]; then
    fail "BACKEND_BUILD_SHA does not match exact repository HEAD"
  fi
  backend_context="$(cd "$REPO_DIR/backend" && pwd -P)"
  requested_context="${BACKEND_BUILD_CONTEXT:-}"
  if [[ -n "$requested_context" ]]; then
    if [[ "$requested_context" = /* ]]; then
      resolved_context="$(cd "$requested_context" 2>/dev/null && pwd -P || true)"
    else
      resolved_context="$(cd "$PROJECT_DIR/$requested_context" 2>/dev/null && pwd -P || true)"
    fi
    [[ "$resolved_context" == "$backend_context" ]] \
      || fail "BACKEND_BUILD_CONTEXT must resolve to this exact repository backend"
  fi
  export BACKEND_BUILD_SHA="$revision"
  export BACKEND_BUILD_CONTEXT="$backend_context"
  expected_image="erp-backend:${revision}"
  requested_image="${BACKEND_BUILD_IMAGE:-}"
  if [[ -n "$requested_image" && "$requested_image" != "$expected_image" ]]; then
    fail "BACKEND_BUILD_IMAGE does not match exact repository HEAD"
  fi
  export BACKEND_BUILD_IMAGE="$expected_image"
}

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

env_file_value() {
  local name="$1" line raw
  line="$(grep -E "^[[:space:]]*${name}=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  raw="${line#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  printf '%s' "$raw"
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

require_compose_override_support() {
  local raw version major minor patch
  raw="$(docker compose version --short 2>/dev/null)" \
    || fail "docker compose is required for the CNC Telegram overlay"
  version="${raw#v}"
  version="${version%%-*}"
  IFS='.' read -r major minor patch <<< "$version"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]]; then
    fail "cannot parse docker compose version '$raw'; CNC Telegram overlay requires >= 2.24.4"
  fi
  if (( major < 2 || (major == 2 && minor < 24) || (major == 2 && minor == 24 && patch < 4) )); then
    fail "docker compose >= 2.24.4 is required for CNC Telegram profile overrides (found $raw)"
  fi
}

prepare_compose_file_args() {
  local stack_env
  COMPOSE_FILE_ARGS=(-f "$COMPOSE_FILE")
  if compose_profile_enabled cnc-telegram; then
    require_compose_override_support
    [[ -f "$CNC_TELEGRAM_OVERLAY" ]] || fail "CNC Telegram overlay not found: $CNC_TELEGRAM_OVERLAY"
    COMPOSE_FILE_ARGS+=(-f "$CNC_TELEGRAM_OVERLAY")
    log "Using CNC Telegram overlay to enforce worker and GLM fallback profiles"
  fi
  stack_env="$(env_file_value ERP_STACK_ENV)"
  stack_env="${stack_env:-test}"
  STACK_ENV_OVERLAY="$REPO_DIR/ops/templates/docker-compose.${stack_env}.yml"
  if [[ -f "$STACK_ENV_OVERLAY" ]]; then
    COMPOSE_FILE_ARGS+=(-f "$STACK_ENV_OVERLAY")
    log "Using $stack_env Compose overlay"
  fi
  [[ -f "$BACKEND_IDENTITY_OVERLAY" ]] \
    || fail "Backend build identity overlay not found: $BACKEND_IDENTITY_OVERLAY"
  COMPOSE_FILE_ARGS+=(-f "$BACKEND_IDENTITY_OVERLAY")
}

docker_compose() {
  docker compose --env-file "$ENV_FILE" "${COMPOSE_FILE_ARGS[@]}" "$@"
}

assert_backend_image_revision() {
  local image_ref image_revision
  image_ref="$(docker_compose config --format json 2>/dev/null \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["backend"]["image"])' \
    2>/dev/null || true)"
  [[ -n "$image_ref" ]] || fail "cannot resolve the rendered backend image reference"
  image_revision="$(docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "$image_ref" 2>/dev/null || true)"
  [[ "$image_revision" == "$BACKEND_BUILD_SHA" ]] \
    || fail "backend image revision does not match exact repository HEAD"
}

ensure_worker_build_identity() {
  local revision worker_context requested_context resolved_context
  revision="$(git -C "$REPO_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    revision="${CNC_TELEGRAM_WORKER_IMAGE_REVISION:-$(env_file_value CNC_TELEGRAM_WORKER_IMAGE_REVISION)}"
  fi
  [[ "$revision" =~ ^[0-9a-f]{7,64}$ ]] \
    || fail "CNC_TELEGRAM_WORKER_IMAGE_REVISION must be an immutable git revision"
  worker_context="$(cd "$REPO_DIR/cnc-telegram-worker" && pwd -P)"
  requested_context="${CNC_TELEGRAM_WORKER_BUILD_CONTEXT:-}"
  if [[ -n "$requested_context" ]]; then
    if [[ "$requested_context" = /* ]]; then
      resolved_context="$(cd "$requested_context" 2>/dev/null && pwd -P || true)"
    else
      resolved_context="$(cd "$PROJECT_DIR/$requested_context" 2>/dev/null && pwd -P || true)"
    fi
    [[ "$resolved_context" == "$worker_context" ]] \
      || fail "CNC_TELEGRAM_WORKER_BUILD_CONTEXT must resolve to this exact repository worker"
  fi
  export CNC_TELEGRAM_WORKER_IMAGE_REVISION="$revision"
  export CNC_TELEGRAM_WORKER_BUILD_CONTEXT="$worker_context"
}

assert_rendered_worker_serve_command() {
  local rendered
  rendered="$(docker_compose config --format json 2>/dev/null)" \
    || fail "failed to render merged Compose config"
  python3 -c 'import json, sys
data = json.load(sys.stdin)
command = data.get("services", {}).get("cnc-telegram-worker", {}).get("command")
if command != ["serve"]:
    raise SystemExit(f"rendered worker command must be exactly [serve], got {command!r}")
' <<<"$rendered" \
    || fail "rendered CNC Telegram worker command must be exactly serve"
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
resolve_backend_build_sha

if [[ ! -f "$COMPOSE_FILE" ]]; then
  cp "$REPO_DIR/ops/templates/docker-compose.vps.yml" "$COMPOSE_FILE"
  log "Created $COMPOSE_FILE from template"
fi
prepare_compose_file_args
if compose_profile_enabled cnc-telegram; then
  ensure_worker_build_identity
  assert_rendered_worker_serve_command
fi

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
  assert_backend_image_revision
  exit 0
fi

if [[ "$BUILD" == "1" ]]; then
  log "Building source images"
  docker_compose build
fi
assert_backend_image_revision

up_args=(up -d)
[[ "$FORCE_RECREATE" == "1" ]] && up_args+=(--force-recreate)

log "Starting stack"
docker_compose "${up_args[@]}"

log "Current services"
docker_compose ps

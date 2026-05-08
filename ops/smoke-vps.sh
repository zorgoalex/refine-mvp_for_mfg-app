#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
SKIP_DOCKER=0

usage() {
  cat <<'EOF'
smoke-vps.sh

Run post-deploy checks against Hasura, backend, and Hasura CORS.

Usage:
  ops/smoke-vps.sh [--env-file PATH] [--compose-file PATH] [--skip-docker]
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
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

require() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "$name is required"
}

require HASURA_FQDN
require BACKEND_FQDN
require FRONTEND_ORIGIN

check_url() {
  local url="$1"
  local expected="$2"
  local code
  code="$(curl -fsS -o /tmp/erp-smoke-body.$$ -w '%{http_code}' --max-time 20 "$url" || true)"
  if [[ "$code" != "$expected" ]]; then
    printf 'Response body:\n' >&2
    cat /tmp/erp-smoke-body.$$ >&2 || true
    rm -f /tmp/erp-smoke-body.$$
    fail "$url returned HTTP $code, expected $expected"
  fi
  rm -f /tmp/erp-smoke-body.$$
  log "OK $url -> $code"
}

check_hasura_cors() {
  local headers
  local body
  local code
  headers="$(mktemp)"
  body="$(mktemp)"
  code="$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 20 \
    -X OPTIONS "https://${HASURA_FQDN}/v1/graphql" \
    -H "Origin: ${FRONTEND_ORIGIN}" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type,authorization' || true)"

  if [[ "$code" != "204" ]]; then
    cat "$headers" >&2 || true
    cat "$body" >&2 || true
    rm -f "$headers" "$body"
    fail "Hasura CORS preflight returned HTTP $code, expected 204"
  fi

  if ! grep -iq "^access-control-allow-origin: ${FRONTEND_ORIGIN}$" "$headers"; then
    cat "$headers" >&2 || true
    rm -f "$headers" "$body"
    fail "Hasura CORS does not allow ${FRONTEND_ORIGIN}"
  fi

  rm -f "$headers" "$body"
  log "OK Hasura CORS allows ${FRONTEND_ORIGIN}"
}

check_url "https://${HASURA_FQDN}/healthz" "200"
check_url "https://${BACKEND_FQDN}/health/live" "200"
check_hasura_cors

if [[ "$SKIP_DOCKER" == "0" && -f "$COMPOSE_FILE" ]] && command -v docker >/dev/null 2>&1; then
  cd "$PROJECT_DIR"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T hasura printenv HASURA_GRAPHQL_CORS_DOMAIN | grep -F "$FRONTEND_ORIGIN" >/dev/null \
    || fail "Running Hasura container does not contain FRONTEND_ORIGIN in HASURA_GRAPHQL_CORS_DOMAIN"
fi

log "Smoke checks passed"

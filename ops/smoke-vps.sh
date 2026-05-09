#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
SKIP_DOCKER=0
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-12}"
SMOKE_DELAY_SECONDS="${SMOKE_DELAY_SECONDS:-5}"

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
  local attempt

  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
    code="$(curl -fsS -o /tmp/erp-smoke-body.$$ -w '%{http_code}' --max-time 20 "$url" || true)"
    if [[ "$code" == "$expected" ]]; then
      rm -f /tmp/erp-smoke-body.$$
      log "OK $url -> $code"
      return 0
    fi

    if [[ "$attempt" -lt "$SMOKE_ATTEMPTS" ]]; then
      log "Waiting for $url -> got HTTP $code, expected $expected (attempt $attempt/$SMOKE_ATTEMPTS)"
      sleep "$SMOKE_DELAY_SECONDS"
    fi
  done

  printf 'Response body:\n' >&2
  cat /tmp/erp-smoke-body.$$ >&2 || true
  rm -f /tmp/erp-smoke-body.$$
  fail "$url returned HTTP $code, expected $expected"
}

check_hasura_cors() {
  local headers
  local body
  local code
  local attempt

  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
    headers="$(mktemp)"
    body="$(mktemp)"
    code="$(curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 20 \
      -X OPTIONS "https://${HASURA_FQDN}/v1/graphql" \
      -H "Origin: ${FRONTEND_ORIGIN}" \
      -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: content-type,authorization' || true)"

    if [[ "$code" == "204" ]] && awk -v origin="$FRONTEND_ORIGIN" '
      BEGIN { found = 0 }
      {
        line = $0
        sub(/\r$/, "", line)
        split(line, parts, ":")
        name = tolower(parts[1])
        value = substr(line, length(parts[1]) + 2)
        sub(/^[[:space:]]+/, "", value)
        if (name == "access-control-allow-origin" && value == origin) {
          found = 1
        }
      }
      END { exit found ? 0 : 1 }
    ' "$headers"; then
      rm -f "$headers" "$body"
      log "OK Hasura CORS allows ${FRONTEND_ORIGIN}"
      return 0
    fi

    if [[ "$attempt" -lt "$SMOKE_ATTEMPTS" ]]; then
      log "Waiting for Hasura CORS preflight -> got HTTP $code (attempt $attempt/$SMOKE_ATTEMPTS)"
      rm -f "$headers" "$body"
      sleep "$SMOKE_DELAY_SECONDS"
    fi
  done

  cat "$headers" >&2 || true
  cat "$body" >&2 || true
  rm -f "$headers" "$body"
  if [[ "$code" != "204" ]]; then
    fail "Hasura CORS preflight returned HTTP $code, expected 204"
  fi
  fail "Hasura CORS does not allow ${FRONTEND_ORIGIN}"
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

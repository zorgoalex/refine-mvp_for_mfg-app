#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
SKIP_DOCKER=0
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-12}"
SMOKE_DELAY_SECONDS="${SMOKE_DELAY_SECONDS:-5}"
ENV_FILE_ARG_SET=0
COMPOSE_FILE_ARG_SET=0

usage() {
  cat <<'EOF'
smoke-vps.sh

Run post-deploy checks against Hasura, backend, and Hasura CORS.

Usage:
  ops/smoke-vps.sh [--project-dir PATH] [--env-file PATH] [--compose-file PATH] [--skip-docker]
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
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; ENV_FILE_ARG_SET=1; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; COMPOSE_FILE_ARG_SET=1; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
[[ "$ENV_FILE_ARG_SET" == "0" ]] && ENV_FILE="$PROJECT_DIR/.env"
[[ "$COMPOSE_FILE_ARG_SET" == "0" ]] && COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"
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

check_live_schema() {
  local query
  local result

  [[ "${BACKEND_ENABLE_DEADLINES:-false}" == "true" ]] || return 0

  query="
    SELECT json_build_object(
      'deadlineEventsIdempotencyKey',
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'deadline_events'
          AND column_name = 'idempotency_key'
      ),
      'deadlineEventsIdempotencyIndex',
      EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'deadline_events'
          AND indexname = 'uq_deadline_events_idempotency_key'
      )
    )::text;
  "

  result="$(
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgresdb \
      psql -U "$PG_USER" -d "$PG_DB" -tA -v ON_ERROR_STOP=1 -c "$query"
  )"

  case "$result" in
    *'"deadlineEventsIdempotencyKey" : true'*|*'"deadlineEventsIdempotencyKey":true'*)
      ;;
    *)
      fail "Live DB schema drift: deadline_events.idempotency_key is missing while BACKEND_ENABLE_DEADLINES=true"
      ;;
  esac

  case "$result" in
    *'"deadlineEventsIdempotencyIndex" : true'*|*'"deadlineEventsIdempotencyIndex":true'*)
      ;;
    *)
      fail "Live DB schema drift: uq_deadline_events_idempotency_key is missing while BACKEND_ENABLE_DEADLINES=true"
      ;;
  esac

  log "OK live DB deadline_events idempotency schema"
}

# Audit log normalized dimensions are required whenever the backend runs:
# AuditService writes them on every command and GET /api/v1/audit selects them.
# Migrations 004 (source/related_order_id/.../stage_code) and 012
# (related_payment_id/related_deadline_id) must be applied to the target DB or
# the audit write/read paths fail at first request. Checked unconditionally.
check_audit_schema() {
  local query
  local result
  local cols="ARRAY['source','related_order_id','related_client_id','related_payment_id','related_deadline_id','related_production_event_id','status_field','status_id','status_name','status_code','stage_code']"

  query="
    SELECT json_build_object(
      'auditLogDimensions',
      (SELECT bool_and(
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'audit_log'
             AND column_name = t.col
         ))
       FROM unnest($cols) AS t(col)),
      'missing',
      COALESCE((
        SELECT string_agg(t.col, ',')
        FROM unnest($cols) AS t(col)
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'audit_log'
            AND column_name = t.col
        )
      ), '')
    )::text;
  "

  result="$(
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgresdb \
      psql -U "$PG_USER" -d "$PG_DB" -tA -v ON_ERROR_STOP=1 -c "$query"
  )"

  case "$result" in
    *'"auditLogDimensions" : true'*|*'"auditLogDimensions":true'*)
      ;;
    *)
      fail "Live DB schema drift: audit_log normalized dimension columns are missing (apply migrations 004 and 012). Result: $result"
      ;;
  esac

  log "OK live DB audit_log dimension schema"
}

check_url "https://${HASURA_FQDN}/healthz" "200"
check_url "https://${BACKEND_FQDN}/health/live" "200"
check_hasura_cors

if [[ "$SKIP_DOCKER" == "0" && -f "$COMPOSE_FILE" ]] && command -v docker >/dev/null 2>&1; then
  cd "$PROJECT_DIR"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
  check_live_schema
  check_audit_schema
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T hasura printenv HASURA_GRAPHQL_CORS_DOMAIN | grep -F "$FRONTEND_ORIGIN" >/dev/null \
    || fail "Running Hasura container does not contain FRONTEND_ORIGIN in HASURA_GRAPHQL_CORS_DOMAIN"
fi

log "Smoke checks passed"

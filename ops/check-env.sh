#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
DNS_CHECK=0
EXPECTED_IP=""

usage() {
  cat <<'EOF'
check-env.sh

Validate VPS .env before deploying/recreating containers.

Usage:
  ops/check-env.sh [--env-file PATH] [--compose-file PATH] [--dns] [--expected-ip IP]

--dns compares HASURA_FQDN and BACKEND_FQDN A records with the VPS public IP.
Use --expected-ip to avoid public-IP autodetection.
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
    --dns) DNS_CHECK=1; shift ;;
    --expected-ip) EXPECTED_IP="$2"; DNS_CHECK=1; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

errors=0

mark_error() {
  printf 'ERROR: %s\n' "$*" >&2
  errors=$((errors + 1))
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    mark_error "$name is required"
  elif [[ "$value" == *REPLACE_ME* || "$value" == *"<"* || "$value" == *">"* ]]; then
    mark_error "$name still contains a placeholder"
  fi
}

require_origin() {
  local name="$1"
  local value="${!name:-}"
  require_var "$name"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ ^https?://[^/]+$ ]] || mark_error "$name must be an origin like https://app.example.com, no path or trailing slash"
}

require_fqdn() {
  local name="$1"
  local value="${!name:-}"
  require_var "$name"
  [[ -z "$value" ]] && return 0
  [[ "$value" != http://* && "$value" != https://* && "$value" != */* ]] || mark_error "$name must be a hostname only, without scheme/path"
}

csv_contains() {
  local csv="$1"
  local needle="$2"
  IFS=',' read -ra parts <<< "$csv"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [[ "$part" == "$needle" ]] && return 0
  done
  return 1
}

require_var COMPOSE_PROJECT_NAME
require_var EDGE_NETWORK_NAME
require_fqdn HASURA_FQDN
require_fqdn BACKEND_FQDN
require_origin FRONTEND_ORIGIN
require_var LETSENCRYPT_EMAIL
require_var PG_DB
require_var PG_USER
require_var PG_PASSWORD
require_var HASURA_GRAPHQL_DATABASE_URL
require_var HASURA_MD_DB
require_var HASURA_MD_USER
require_var HASURA_MD_PASSWORD
require_var HASURA_ADMIN_SECRET
require_var HASURA_JWT_SECRET
require_var HASURA_GRAPHQL_CORS_DOMAIN
require_var BACKEND_REFRESH_TOKEN_PEPPER
require_var BACKEND_CORS_ALLOWED_ORIGINS

if [[ -n "${FRONTEND_ORIGIN:-}" ]]; then
  csv_contains "${HASURA_GRAPHQL_CORS_DOMAIN:-}" "$FRONTEND_ORIGIN" || mark_error "HASURA_GRAPHQL_CORS_DOMAIN must include FRONTEND_ORIGIN"
  csv_contains "${BACKEND_CORS_ALLOWED_ORIGINS:-}" "$FRONTEND_ORIGIN" || mark_error "BACKEND_CORS_ALLOWED_ORIGINS must include FRONTEND_ORIGIN"
fi

hasura_jwt_secret_value="${HASURA_JWT_SECRET:-}"
if [[ "${#hasura_jwt_secret_value}" -lt 32 ]]; then
  mark_error "HASURA_JWT_SECRET must be at least 32 characters"
fi

backend_refresh_token_pepper_value="${BACKEND_REFRESH_TOKEN_PEPPER:-}"
if [[ "${#backend_refresh_token_pepper_value}" -lt 32 ]]; then
  mark_error "BACKEND_REFRESH_TOKEN_PEPPER must be at least 32 characters"
fi

if [[ "${BACKEND_ENABLE_ORDER_EXPORT:-true}" == "true" && "${BACKEND_EXPORT_DISABLED:-true}" == "false" ]]; then
  require_var GAS_WEBAPP_URL
  require_var GAS_API_KEY
fi

if [[ "${BACKEND_ENABLE_VLM:-true}" == "true" && "${BACKEND_VLM_DISABLED:-true}" == "false" ]]; then
  require_var VLM_API_URL
  require_var AUTH0_M2M_DOMAIN
  require_var AUTH0_M2M_CLIENT_ID
  require_var AUTH0_M2M_CLIENT_SECRET
  require_var AUTH0_M2M_AUDIENCE
fi

if [[ "$DNS_CHECK" == "1" ]]; then
  if [[ -z "$EXPECTED_IP" ]]; then
    EXPECTED_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
  fi
  [[ -n "$EXPECTED_IP" ]] || mark_error "Could not determine public IP; pass --expected-ip"

  for fqdn in "${HASURA_FQDN:-}" "${BACKEND_FQDN:-}"; do
    [[ -n "$fqdn" ]] || continue
    resolved="$(getent ahostsv4 "$fqdn" | awk '{print $1}' | sort -u | paste -sd ',' -)"
    if [[ -z "$resolved" ]]; then
      mark_error "$fqdn has no A record"
    elif [[ ",$resolved," != *",$EXPECTED_IP,"* ]]; then
      mark_error "$fqdn resolves to [$resolved], expected $EXPECTED_IP"
    fi
  done
fi

if command -v docker >/dev/null 2>&1 && [[ -f "$COMPOSE_FILE" ]]; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
fi

if [[ "$errors" -gt 0 ]]; then
  fail "$errors env validation error(s)"
fi

log "Env validation passed"

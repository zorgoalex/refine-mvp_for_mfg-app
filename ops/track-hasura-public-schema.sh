#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
SCHEMA="public"
VERIFY=1

usage() {
  cat <<'EOF'
track-hasura-public-schema.sh

Track restored PostgreSQL tables/views in Hasura metadata.

Usage:
  ops/track-hasura-public-schema.sh [--env-file PATH] [--compose-file PATH] [--schema public] [--skip-verify]
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
    --schema) SCHEMA="$2"; shift 2 ;;
    --skip-verify) VERIFY=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"
[[ "$SCHEMA" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "Unsafe schema name: $SCHEMA"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ -n "${PG_DB:-}" ]] || fail "PG_DB is required in .env"
[[ -n "${PG_USER:-}" ]] || fail "PG_USER is required in .env"
[[ -n "${PG_PASSWORD:-}" ]] || fail "PG_PASSWORD is required in .env"
[[ -n "${HASURA_FQDN:-}" ]] || fail "HASURA_FQDN is required in .env"
[[ -n "${HASURA_ADMIN_SECRET:-}" ]] || fail "HASURA_ADMIN_SECRET is required in .env"

cd "$PROJECT_DIR"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
relations_file="$(mktemp)"
trap 'rm -f "$relations_file"' EXIT

wait_for_hasura() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 10 "https://${HASURA_FQDN}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  fail "Hasura did not become healthy at https://${HASURA_FQDN}/healthz"
}

log "Waiting for Hasura health"
wait_for_hasura

log "Reading PostgreSQL relations from schema $SCHEMA"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -Atc "
    SELECT table_schema || '.' || table_name
    FROM information_schema.tables
    WHERE table_schema = '${SCHEMA}'
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name;
  " > "$relations_file"

relation_count="$(grep -cve '^[[:space:]]*$' "$relations_file" || true)"
[[ "$relation_count" != "0" ]] || fail "No PostgreSQL relations found in schema $SCHEMA"

log "Tracking $relation_count PostgreSQL relations in Hasura"
HASURA_METADATA_URL="https://${HASURA_FQDN}/v1/metadata" \
HASURA_GRAPHQL_URL="https://${HASURA_FQDN}/v1/graphql" \
HASURA_ADMIN_SECRET="$HASURA_ADMIN_SECRET" \
RELATIONS_FILE="$relations_file" \
VERIFY="$VERIFY" \
python3 <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

metadata_url = os.environ["HASURA_METADATA_URL"]
graphql_url = os.environ["HASURA_GRAPHQL_URL"]
admin_secret = os.environ["HASURA_ADMIN_SECRET"]
relations_file = os.environ["RELATIONS_FILE"]
verify = os.environ.get("VERIFY") == "1"


def request_json(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-hasura-admin-secret": admin_secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read().decode("utf-8")
            return json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Hasura HTTP {error.code}: {details}") from error


def table_key(table):
    if isinstance(table, str):
        return ("public", table)
    if isinstance(table, dict):
        return (table.get("schema", "public"), table.get("name", ""))
    return ("", "")


relations = []
with open(relations_file, "r", encoding="utf-8") as handle:
    for line in handle:
        value = line.strip()
        if not value:
            continue
        schema, name = value.split(".", 1)
        relations.append((schema, name))

metadata = request_json(metadata_url, {"type": "export_metadata", "args": {}})
sources = metadata.get("metadata", metadata).get("sources", [])
source = next((item for item in sources if item.get("name") == "default"), None)
if not source:
    raise RuntimeError("Hasura source 'default' was not found in metadata")

tracked = {table_key(item.get("table")) for item in source.get("tables", [])}
created = 0
skipped = 0

for schema, name in relations:
    if (schema, name) in tracked:
        skipped += 1
        continue

    payload = {
        "type": "pg_track_table",
        "args": {
            "source": "default",
            "table": {"schema": schema, "name": name},
        },
    }

    try:
        request_json(metadata_url, payload)
        created += 1
    except RuntimeError as error:
        message = str(error).lower()
        if "already" in message and "track" in message:
            skipped += 1
            continue
        raise

request_json(metadata_url, {"type": "reload_metadata", "args": {"reload_sources": True}})
print(f"tracked_created={created}")
print(f"tracked_existing={skipped}")

if verify and ("public", "orders_view") in relations:
    result = request_json(
        graphql_url,
        {"query": "query VerifyOrdersView { orders_view_aggregate { aggregate { count } } }"},
    )
    if result.get("errors"):
        raise RuntimeError(json.dumps(result["errors"], ensure_ascii=False))

    count = (
        result.get("data", {})
        .get("orders_view_aggregate", {})
        .get("aggregate", {})
        .get("count")
    )
    print(f"orders_view_count={count}")
PY

log "Hasura public schema tracking complete"

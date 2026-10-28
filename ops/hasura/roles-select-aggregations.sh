#!/usr/bin/env bash
# Allow the row count (roles_aggregate) on `roles` for every role that already has
# SELECT on it. The Refine Hasura list asks for <resource>_aggregate together with the
# rows, so without it «Видимость экранов», the financial access matrix and notification
# recipients fail with "field 'roles_aggregate' not found". Columns and filters stay as
# they are; all permissions are recreated in one atomic bulk request pinned to the
# metadata resource_version that was read: if anyone changed metadata in between,
# Hasura answers 409 and nothing is applied (re-run to read the fresh permissions).
#
# Usage: roles-select-aggregations.sh [--dry-run] [--revert] [--tables a,b,c]
#   --revert  sets allow_aggregations back to false (rollback), same safety rules.
#   --tables  the tables to change (default: roles). 28.10: also the reference lists
#             movements_statuses, material_transaction_types, transaction_direction — their
#             lists failed for every role with "<table>_aggregate not found".

set -euo pipefail

DRY_RUN=false
TARGET=true
TABLES=roles
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --revert) TARGET=false ;;
    --tables)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'missing value for --tables\n' >&2; exit 2; }
      TABLES="$2"; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$TABLES" =~ ^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*$ ]] || { printf 'invalid --tables: %s\n' "$TABLES" >&2; exit 2; }

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

if [[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]]; then
  BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
  BASE_URL="${BASE_URL%/graphql}"
  METADATA_URL="${BASE_URL}/v1/metadata"
  ADMIN_SECRET="${HASURA_ADMIN_SECRET:-}"
elif [[ -n "${HASURA_GRAPHQL_ADMIN_SECRET:-}" ]]; then
  METADATA_URL="http://localhost:8080/v1/metadata"
  ADMIN_SECRET="${HASURA_GRAPHQL_ADMIN_SECRET}"
else
  fail "Set HASURA_GRAPHQL_ENDPOINT + HASURA_ADMIN_SECRET, or run inside Hasura container with HASURA_GRAPHQL_ADMIN_SECRET"
fi

[[ -n "${ADMIN_SECRET:-}" ]] || fail "Hasura admin secret is required"

hasura_api() {
  local payload="$1"
  curl -sSf \
    -H "Content-Type: application/json" \
    -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
    -d "$payload" \
    "${METADATA_URL}"
}

log "Fetching current Hasura metadata (with resource_version)..."
# The export (~300 KB) goes through a private temp file, not an environment variable: one environment string is
# limited to 128 KB on Linux ("Argument list too long" before anything is read).
METADATA_FILE="$(mktemp /tmp/roles-aggregations-metadata-XXXXXX.json)"
BULK_FILE="$(mktemp /tmp/roles-aggregations-bulk-XXXXXX.json)"
trap 'rm -f "$METADATA_FILE" "$BULK_FILE"' EXIT
chmod 600 "$METADATA_FILE" "$BULK_FILE"
hasura_api '{"type":"export_metadata","version":2,"args":{}}' > "$METADATA_FILE"
export _ROLES_TARGET="$TARGET"
export _ROLES_TABLES="$TABLES"
python3 - "$BULK_FILE" "$METADATA_FILE" <<'PY'
import json
import os
import sys

bulk_path = sys.argv[1]
with open(sys.argv[2]) as metadata_file:
    raw = metadata_file.read()
if not raw:
    print("ERROR: the metadata export is empty", file=sys.stderr)
    sys.exit(1)

exported = json.loads(raw)
resource_version = exported.get("resource_version")
metadata = exported.get("metadata")
if not isinstance(resource_version, int) or not isinstance(metadata, dict):
    print("ERROR: export_metadata v2 did not return resource_version + metadata", file=sys.stderr)
    sys.exit(1)
target = os.environ.get("_ROLES_TARGET") == "true"

target_tables = os.environ.get("_ROLES_TABLES", "roles").split(",")
args = []
found = set()
for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        table_ref = table.get("table", {})
        target_table = table_ref.get("name")
        if target_table not in target_tables or table_ref.get("schema", "public") != "public":
            continue
        found.add(target_table)
        hasura_table = {"schema": "public", "name": target_table}
        for perm in table.get("select_permissions", []):
            role = perm["role"]
            permission = json.loads(json.dumps(perm["permission"]))
            if bool(permission.get("allow_aggregations", False)) is target:
                print(f"  {target_table}/{role}/select: no-change", file=sys.stderr)
                continue
            permission["allow_aggregations"] = target
            print(f"  {target_table}/{role}/select: allow_aggregations -> {str(target).lower()}", file=sys.stderr)
            args.append({"type": "pg_drop_select_permission",
                         "args": {"source": source_name, "table": hasura_table, "role": role}})
            args.append({"type": "pg_create_select_permission",
                         "args": {"source": source_name, "table": hasura_table, "role": role,
                                  "permission": permission}})

missing = [name for name in target_tables if name not in found]
if missing:
    print(f"ERROR: table(s) not tracked: {', '.join('public.' + name for name in missing)}", file=sys.stderr)
    sys.exit(1)

with open(bulk_path, "w") as f:
    json.dump({"type": "bulk", "resource_version": resource_version, "args": args}, f)
print(f"Permissions to update: {len(args) // 2}", file=sys.stderr)
PY
unset _ROLES_TARGET _ROLES_TABLES

COUNT="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['args']) // 2)" "$BULK_FILE")"
if [[ "$COUNT" == "0" ]]; then
  log "Nothing to change."
  exit 0
fi
if $DRY_RUN; then
  log "Dry run: ${COUNT} permission(s) would be updated."
  exit 0
fi

log "Applying ${COUNT} permission update(s) in one bulk request..."
RESPONSE_FILE="$(mktemp /tmp/roles-aggregations-response-XXXXXX.json)"
trap 'rm -f "$METADATA_FILE" "$BULK_FILE" "$RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d @"$BULK_FILE" \
  "${METADATA_URL}")"
case "$HTTP_CODE" in
  200) log "${TABLES} SELECT allow_aggregations=${TARGET} applied." ;;
  409) fail "Hasura metadata changed after it was read (409 conflict); nothing applied. Re-run the script." ;;
  *) fail "Hasura metadata API answered HTTP ${HTTP_CODE}: $(head -c 300 "$RESPONSE_FILE")" ;;
esac

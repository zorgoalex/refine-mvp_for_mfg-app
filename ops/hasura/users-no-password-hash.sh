#!/usr/bin/env bash
# Remove `users.password_hash` from every Hasura select/insert/update permission of every role.
# The browser talks to Hasura with the user's own JWT, so any column a role may select can be
# read by a direct GraphQL request: managers, operators, top managers, viewers and superadmins
# could read all password hashes. Users and passwords are owned by the backend (backendUsers),
# which reads/writes the hash in PostgreSQL directly, so Hasura never needs this column.
# Other columns, filters and checks stay as they are; everything is recreated in one bulk
# request pinned to the metadata resource_version (409 on a concurrent change, nothing applied).
#
# Usage: users-no-password-hash.sh [--dry-run]
# There is deliberately no revert mode: re-adding the column would reopen the leak and could widen
# permissions that never had it. Roll back (only if needed) from the metadata export taken before
# applying (production guide) with replace_metadata.

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

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
METADATA_JSON="$(hasura_api '{"type":"export_metadata","version":2,"args":{}}')"

BULK_FILE="$(mktemp /tmp/users-password-hash-bulk-XXXXXX.json)"
RESPONSE_FILE="$(mktemp /tmp/users-password-hash-response-XXXXXX.json)"
trap 'rm -f "$BULK_FILE" "$RESPONSE_FILE"' EXIT

export _USERS_METADATA="$METADATA_JSON"
python3 - "$BULK_FILE" <<'PY'
import json
import os
import sys

bulk_path = sys.argv[1]
raw = os.environ.get("_USERS_METADATA", "")
if not raw:
    print("ERROR: _USERS_METADATA is empty", file=sys.stderr)
    sys.exit(1)

exported = json.loads(raw)
resource_version = exported.get("resource_version")
metadata = exported.get("metadata")
if not isinstance(resource_version, int) or not isinstance(metadata, dict):
    print("ERROR: export_metadata v2 did not return resource_version + metadata", file=sys.stderr)
    sys.exit(1)

COLUMN = "password_hash"
TARGET = "users"
KINDS = (("select", "pg_drop_select_permission", "pg_create_select_permission"),
         ("insert", "pg_drop_insert_permission", "pg_create_insert_permission"),
         ("update", "pg_drop_update_permission", "pg_create_update_permission"))
args = []
found = False
for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        ref = table.get("table", {})
        if ref.get("name") != TARGET or ref.get("schema", "public") != "public":
            continue
        found = True
        hasura_table = {"schema": "public", "name": TARGET}
        for kind, drop_type, create_type in KINDS:
            for perm in table.get(f"{kind}_permissions", []):
                role = perm["role"]
                permission = json.loads(json.dumps(perm["permission"]))
                columns = permission.get("columns")
                if columns == "*":
                    # "*" would include the column; refuse instead of guessing the column list.
                    print(f"ERROR: {TARGET}/{role}/{kind} uses columns='*'; list the columns explicitly first", file=sys.stderr)
                    sys.exit(1)
                columns = list(columns or [])
                if COLUMN not in columns:
                    print(f"  {TARGET}/{role}/{kind}: no-change", file=sys.stderr)
                    continue
                columns = [c for c in columns if c != COLUMN]
                label = f"{TARGET}/{role}/{kind}: {COLUMN} removed"
                permission["columns"] = columns
                print(f"  {label}", file=sys.stderr)
                args.append({"type": drop_type, "args": {"source": source_name, "table": hasura_table, "role": role}})
                args.append({"type": create_type, "args": {"source": source_name, "table": hasura_table,
                                                           "role": role, "permission": permission}})

if not found:
    print("ERROR: table public.users is not tracked", file=sys.stderr)
    sys.exit(1)

with open(bulk_path, "w") as f:
    json.dump({"type": "bulk", "resource_version": resource_version, "args": args}, f)
print(f"Permissions to update: {len(args) // 2}", file=sys.stderr)
PY
unset _USERS_METADATA

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
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d @"$BULK_FILE" \
  "${METADATA_URL}")"
case "$HTTP_CODE" in
  200) log "users.password_hash removed from Hasura permissions." ;;
  409) fail "Hasura metadata changed after it was read (409 conflict); nothing applied. Re-run the script." ;;
  *) fail "Hasura metadata API answered HTTP ${HTTP_CODE}: $(head -c 300 "$RESPONSE_FILE")" ;;
esac

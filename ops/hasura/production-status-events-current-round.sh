#!/usr/bin/env bash
# «Переделка»: an order's stage marks (production_status_events with order_id) are kept per production round;
# earlier rounds are history and the order screens, the list and the calendar read only the current round's marks.
# Every role's SELECT on production_status_events gets the round condition in the base part of its filter (the part
# the access-group predicates wrap): a detail event (no order_id) stays visible as before, an order mark only when its
# round_no equals the order's production_round. Columns, aggregations and the access predicates stay as they are; all
# permissions are recreated in one atomic bulk request pinned to the metadata resource_version that was read: if
# anyone changed metadata in between, Hasura answers 409 and nothing is applied (re-run to read the fresh
# permissions). A base filter that is neither open ({}) nor this condition stops the script (nothing applied).
# Requires migration 274 (round_no, production_round). History of rounds is read through the backend.
#
# Usage: production-status-events-current-round.sh [--dry-run] [--revert]
#   --revert  puts the open base filter ({}) back (rollback), same safety rules.

set -euo pipefail

DRY_RUN=false
TARGET=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --revert) TARGET=false ;;
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
# The full metadata goes through a file: it is larger than an environment variable may be.
METADATA_FILE="$(mktemp /tmp/pse-current-round-metadata-XXXXXX.json)"
BULK_FILE="$(mktemp /tmp/pse-current-round-bulk-XXXXXX.json)"
trap 'rm -f "$METADATA_FILE" "$BULK_FILE"' EXIT
hasura_api '{"type":"export_metadata","version":2,"args":{}}' > "$METADATA_FILE"

export _PSE_TARGET="$TARGET"
python3 - "$BULK_FILE" "$METADATA_FILE" <<'PY'
import json
import os
import sys

ROUND_FILTER = {"_or": [
    {"order_id": {"_is_null": True}},
    {"order": {"production_round": {"_ceq": ["$", "round_no"]}}},
]}

bulk_path = sys.argv[1]
with open(sys.argv[2]) as handle:
    raw = handle.read()
if not raw:
    print("ERROR: export_metadata returned nothing", file=sys.stderr)
    sys.exit(1)
exported = json.loads(raw)
resource_version = exported.get("resource_version")
metadata = exported.get("metadata")
if not isinstance(resource_version, int) or not isinstance(metadata, dict):
    print("ERROR: export_metadata v2 did not return resource_version + metadata", file=sys.stderr)
    sys.exit(1)
apply_round = os.environ.get("_PSE_TARGET") == "true"
wanted = ROUND_FILTER if apply_round else {}

def with_base(filter_value, base):
    """The filter with its base part replaced; base part = the whole filter, or _and[0] of a predicate wrap."""
    if isinstance(filter_value, dict) and set(filter_value) == {"_and"} and isinstance(filter_value["_and"], list) \
            and len(filter_value["_and"]) == 2 and "user_effective_permissions" in json.dumps(filter_value["_and"][1]):
        current = filter_value["_and"][0]
        return current, {"_and": [base, filter_value["_and"][1]]}
    return filter_value, base

target_table = "production_status_events"
args = []
found = False
for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        table_ref = table.get("table", {})
        if table_ref.get("name") != target_table or table_ref.get("schema", "public") != "public":
            continue
        found = True
        if not any(rel.get("name") == "order" for rel in table.get("object_relationships", [])):
            print("ERROR: production_status_events has no object relationship 'order'", file=sys.stderr)
            sys.exit(1)
        hasura_table = {"schema": "public", "name": target_table}
        for perm in table.get("select_permissions", []):
            role = perm["role"]
            permission = json.loads(json.dumps(perm["permission"]))
            current, updated = with_base(permission.get("filter", {}), wanted)
            if current == wanted:
                print(f"  {target_table}/{role}/select: no-change", file=sys.stderr)
                continue
            if current not in ({}, ROUND_FILTER):
                print(f"ERROR: {target_table}/{role}/select has an unexpected base filter: {json.dumps(current)[:200]}", file=sys.stderr)
                sys.exit(1)
            permission["filter"] = updated
            print(f"  {target_table}/{role}/select: base filter -> {'current round' if apply_round else 'open'}", file=sys.stderr)
            args.append({"type": "pg_drop_select_permission",
                         "args": {"source": source_name, "table": hasura_table, "role": role}})
            args.append({"type": "pg_create_select_permission",
                         "args": {"source": source_name, "table": hasura_table, "role": role,
                                  "permission": permission}})

if not found:
    print("ERROR: table public.production_status_events is not tracked", file=sys.stderr)
    sys.exit(1)

with open(bulk_path, "w") as f:
    json.dump({"type": "bulk", "resource_version": resource_version, "args": args}, f)
print(f"Permissions to update: {len(args) // 2}", file=sys.stderr)
PY
unset _PSE_TARGET

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
RESPONSE_FILE="$(mktemp /tmp/pse-current-round-response-XXXXXX.json)"
trap 'rm -f "$METADATA_FILE" "$BULK_FILE" "$RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d @"$BULK_FILE" \
  "${METADATA_URL}")"
case "$HTTP_CODE" in
  200) log "production_status_events SELECT base filter = $($TARGET && echo 'current round' || echo 'open') applied." ;;
  409) fail "Hasura metadata changed after it was read (409 conflict); nothing applied. Re-run the script." ;;
  *) fail "Hasura metadata API answered HTTP ${HTTP_CODE}: $(head -c 300 "$RESPONSE_FILE")" ;;
esac

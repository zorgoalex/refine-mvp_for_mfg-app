#!/usr/bin/env bash
# Grant `delete_flag` SELECT access on doweling_orders_view for every role that
# already has select permission on that view. Preserves live filters/options.

set -euo pipefail

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

log "Reloading Hasura metadata/schema cache..."
hasura_api '{"type":"reload_metadata","args":{"reload_sources":true}}' >/dev/null

log "Fetching current Hasura metadata..."
METADATA_JSON="$(hasura_api '{"type":"export_metadata","args":{}}')"

ACTIONS_FILE="$(mktemp /tmp/doweling-active-select-actions-XXXXXX.json)"
trap 'rm -f "$ACTIONS_FILE"' EXIT

export _DOWELING_METADATA="$METADATA_JSON"
python3 - "$ACTIONS_FILE" <<'PY'
import json
import os
import sys

actions_path = sys.argv[1]
raw = os.environ.get("_DOWELING_METADATA", "")
if not raw:
    print("ERROR: _DOWELING_METADATA is empty", file=sys.stderr)
    sys.exit(1)

metadata = json.loads(raw)
metadata = metadata.get("metadata", metadata) if isinstance(metadata, dict) else metadata

target_table = "doweling_orders_view"
column_to_add = "delete_flag"
actions = []

for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        table_ref = table.get("table", {})
        if table_ref.get("name") != target_table:
            continue

        table_name = table_ref["name"]
        table_schema = table_ref.get("schema", "public")
        for perm in table.get("select_permissions", []):
            role = perm["role"]
            permission = json.loads(json.dumps(perm["permission"]))
            raw_cols = permission.get("columns")

            if raw_cols == "*":
                print(f"  {target_table}/{role}/select: skip (columns='*')", file=sys.stderr)
                continue

            cols = list(raw_cols or [])
            if column_to_add in cols:
                print(f"  {target_table}/{role}/select: no-change", file=sys.stderr)
                continue

            cols.append(column_to_add)
            permission["columns"] = cols
            label = f"{target_table}/{role}/select: added {column_to_add}"
            print(f"  {label}", file=sys.stderr)

            hasura_table = {"schema": table_schema, "name": table_name}
            actions.append({
                "label": label,
                "drop": json.dumps({
                    "type": "pg_drop_select_permission",
                    "args": {"source": source_name, "table": hasura_table, "role": role},
                }),
                "create": json.dumps({
                    "type": "pg_create_select_permission",
                    "args": {
                        "source": source_name,
                        "table": hasura_table,
                        "role": role,
                        "permission": permission,
                    },
                }),
            })

with open(actions_path, "w") as f:
    json.dump(actions, f)

print(f"Total actions: {len(actions)}", file=sys.stderr)
PY
unset _DOWELING_METADATA

ACTION_COUNT="$(python3 -c "import json; print(len(json.load(open('$ACTIONS_FILE'))))")"
log "Applying ${ACTION_COUNT} SELECT permission mutation(s)..."

python3 - "$ACTIONS_FILE" "$METADATA_URL" "$ADMIN_SECRET" <<'PY'
import json
import subprocess
import sys

actions_path, metadata_url, admin_secret = sys.argv[1:]
with open(actions_path) as f:
    actions = json.load(f)

for action in actions:
    print(f"  drop:   {action['label']}", flush=True)
    subprocess.run([
        "curl", "-sSf",
        "-H", "Content-Type: application/json",
        "-H", f"x-hasura-admin-secret: {admin_secret}",
        "-d", action["drop"],
        metadata_url,
    ], check=True)
    print(f"  create: {action['label']}", flush=True)
    subprocess.run([
        "curl", "-sSf",
        "-H", "Content-Type: application/json",
        "-H", f"x-hasura-admin-secret: {admin_secret}",
        "-d", action["create"],
        metadata_url,
    ], check=True)

print("Done.")
PY

log "Reloading Hasura metadata/schema cache..."
hasura_api '{"type":"reload_metadata","args":{"reload_sources":true}}' >/dev/null
log "doweling_orders_view.delete_flag SELECT grant applied."

#!/usr/bin/env bash
# variant-b-material-id-isolation.sh
#
# Variant B Task 11 — write-isolation: remove `material_id` from the non-admin
# Hasura INSERT/UPDATE column allowlists on `orders` and `order_details`.
#
# SECURITY FIX (Critic BLOCKER): this script PRESERVES the live check/filter/set
# (column presets) and all other permission fields from the existing Hasura metadata.
# Only the `columns` array is mutated (material_id removed). This prevents wiping
# row-level check/filter conditions and stripping audit presets (created_by/edited_by)
# that dataProvider.ts relies on (line ~1837).
#
# Approach:
#   1. export_metadata to get the full current permission JSON for each role/table.
#   2. Parse with python3, extract each target permission object (role, table,
#      insert/update), remove material_id from the columns array, preserve everything
#      else (check, filter, set/presets, backend_only, etc.).
#   3. For each target: pg_drop_*_permission + pg_create_*_permission with the
#      mutated object. Idempotent: drop is a no-op if the permission doesn't exist.
#   4. If a target role/table has no existing permission, skip it.
#
# Reads HASURA_GRAPHQL_ENDPOINT and HASURA_ADMIN_SECRET from the environment
# (loaded from .env by the caller). Does NOT print the secret.
#
# Usage:
#   set -a; source /path/to/.env; set +a
#   ops/hasura/variant-b-material-id-isolation.sh

set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

[[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]] || fail "HASURA_GRAPHQL_ENDPOINT is required in the environment"
[[ -n "${HASURA_ADMIN_SECRET:-}" ]] || fail "HASURA_ADMIN_SECRET is required in the environment"

BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
BASE_URL="${BASE_URL%/graphql}"
METADATA_URL="${BASE_URL}/v1/metadata"

hasura_api() {
  local payload="$1"
  curl -sSf \
    -H "Content-Type: application/json" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -d "$payload" \
    "${METADATA_URL}"
}

log "Starting Variant B material_id write-isolation (metadata-preserving)"
log "Endpoint: ${BASE_URL}"
log "Fetching current Hasura metadata..."

METADATA_JSON=$(hasura_api '{"type":"export_metadata","args":{}}')

log "Metadata fetched. Computing permission mutations..."

# Use python3 to parse metadata and emit per-action payloads as a JSON array.
# Each action: { drop_payload, create_payload, label }
ACTIONS_FILE=$(mktemp /tmp/vb-isolation-actions-XXXXXX.json)
trap 'rm -f "$ACTIONS_FILE"' EXIT

export _VB_METADATA="$METADATA_JSON"
python3 - "$ACTIONS_FILE" <<'PY'
import sys
import json
import os

actions_path = sys.argv[1]
raw = os.environ.get("_VB_METADATA", "")
if not raw:
    print("ERROR: _VB_METADATA is empty", file=sys.stderr)
    sys.exit(1)

m = json.loads(raw)
metadata = m.get("metadata", m) if isinstance(m, dict) else m

ROLES = {"operator", "manager", "top_manager"}
TARGET_TABLES = {"orders", "order_details"}
COLUMN_TO_REMOVE = "material_id"

PERM_KEYS = [
    ("insert_permissions", "pg_drop_insert_permission", "pg_create_insert_permission"),
    ("update_permissions", "pg_drop_update_permission", "pg_create_update_permission"),
]

actions = []

for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        tbl_name = table["table"]["name"]
        tbl_schema = table["table"].get("schema", "public")
        if tbl_name not in TARGET_TABLES:
            continue

        for perm_key, drop_type, create_type in PERM_KEYS:
            for perm in table.get(perm_key, []):
                role = perm["role"]
                if role not in ROLES:
                    continue

                # Deep-copy permission object; remove only material_id from columns.
                permission = json.loads(json.dumps(perm["permission"]))
                cols = list(permission.get("columns") or [])
                changed = COLUMN_TO_REMOVE in cols
                if changed:
                    cols.remove(COLUMN_TO_REMOVE)
                    permission["columns"] = cols

                label = (
                    f"{tbl_name}/{role}/{'insert' if 'insert' in perm_key else 'update'}"
                    f": {'removed material_id' if changed else 'no-change (not in columns)'}"
                )
                print(f"  {label}", file=sys.stderr)

                table_ref = {"schema": tbl_schema, "name": tbl_name}
                drop_payload = json.dumps({
                    "type": drop_type,
                    "args": {"table": table_ref, "role": role, "source": source_name}
                })
                create_payload = json.dumps({
                    "type": create_type,
                    "args": {"table": table_ref, "role": role, "permission": permission, "source": source_name}
                })
                actions.append({
                    "label": label,
                    "drop": drop_payload,
                    "create": create_payload,
                })

with open(actions_path, "w") as f:
    json.dump(actions, f)

print(f"Total actions: {len(actions)}", file=sys.stderr)
PY
unset _VB_METADATA

ACTION_COUNT=$(python3 -c "import json; d=json.load(open('$ACTIONS_FILE')); print(len(d))")
log "Applying ${ACTION_COUNT} permission mutations..."

python3 - "$ACTIONS_FILE" <<PY_APPLY
import sys
import json
import subprocess

actions_path = sys.argv[1]
metadata_url = "${METADATA_URL}"
admin_secret = "${HASURA_ADMIN_SECRET}"

with open(actions_path) as f:
    actions = json.load(f)

def hasura_api(payload_str):
    r = subprocess.run(
        ["curl", "-sSf",
         "-H", "Content-Type: application/json",
         "-H", f"x-hasura-admin-secret: {admin_secret}",
         "-d", payload_str,
         metadata_url],
        capture_output=True, text=True, check=True,
    )
    return r.stdout

for action in actions:
    print(f"  drop:   {action['label']}", flush=True)
    hasura_api(action["drop"])
    print(f"  create: {action['label']} (check/filter/presets preserved)", flush=True)
    hasura_api(action["create"])

print("Done.")
PY_APPLY

log "Variant B material_id write-isolation applied successfully (check/filter/presets preserved)."
log "Run ops/hasura/variant-b-assert-write-isolation.sh to verify."

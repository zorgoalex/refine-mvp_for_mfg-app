#!/usr/bin/env bash
# variant-b-material-id-isolation-rollback.sh
#
# Rollback for variant-b-material-id-isolation.sh: restores `material_id` to the
# non-admin INSERT/UPDATE column allowlists on `orders` and `order_details`.
#
# SECURITY FIX (Critic BLOCKER): this script PRESERVES the live check/filter/set
# (column presets) and all other permission fields from the existing Hasura metadata.
# Only the `columns` array is mutated (material_id added back). This prevents wiping
# row-level check/filter conditions and stripping audit presets (created_by/edited_by)
# that dataProvider.ts relies on (line ~1837).
#
# Approach:
#   1. export_metadata to get the full current permission JSON.
#   2. Parse with python3, extract each target permission object, add material_id back
#      to columns (if not already present), preserve everything else.
#   3. pg_drop_*_permission + pg_create_*_permission with the mutated object.
#   4. If a target role/table has no existing permission, skip it.
#
# Use ONLY when rolling back to the pre-034 path (before migration 034 is applied).
# After migration 034, material_id is NULL for all order rows — do NOT use post-034.
#
# SP3 exclusions (sheet_material_type_id, sheet_eligible, etc.) remain excluded —
# those are from migration 029 and are NOT rolled back here.
#
# Reads HASURA_GRAPHQL_ENDPOINT and HASURA_ADMIN_SECRET from the environment.
# Does NOT print the secret.
#
# Usage:
#   set -a; source /path/to/.env; set +a
#   ops/hasura/variant-b-material-id-isolation-rollback.sh

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

log "Starting Variant B material_id isolation ROLLBACK (metadata-preserving, material_id restored)"
log "WARNING: use only when rolling back to pre-034 path."
log "Endpoint: ${BASE_URL}"
log "Fetching current Hasura metadata..."

METADATA_JSON=$(hasura_api '{"type":"export_metadata","args":{}}')

log "Metadata fetched. Computing permission mutations (add material_id back to columns)..."

ACTIONS_FILE=$(mktemp /tmp/vb-isolation-rollback-actions-XXXXXX.json)
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
COLUMN_TO_ADD = "material_id"

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

                # Deep-copy permission object; add material_id back if missing.
                permission = json.loads(json.dumps(perm["permission"]))
                cols = list(permission.get("columns") or [])
                changed = COLUMN_TO_ADD not in cols
                if changed:
                    cols.append(COLUMN_TO_ADD)
                    permission["columns"] = cols

                label = (
                    f"{tbl_name}/{role}/{'insert' if 'insert' in perm_key else 'update'}"
                    f": {'added material_id back' if changed else 'no-change (already present)'}"
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
    print(f"  create: {action['label']} (check/filter/presets preserved, material_id restored)", flush=True)
    hasura_api(action["create"])

print("Done.")
PY_APPLY

log "Rollback complete: material_id restored to non-admin allowlists (check/filter/presets preserved)."

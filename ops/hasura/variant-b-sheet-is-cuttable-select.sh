#!/usr/bin/env bash
# variant-b-sheet-is-cuttable-select.sh
#
# Variant B Task 13 (Critic R5 BLOCKER) — grant `is_cuttable` SELECT access for
# every role that already holds a select_permission on `sheet_material_types`.
#
# Context:
#   Migration 033 added `sheet_material_types.is_cuttable BOOLEAN NOT NULL DEFAULT true`.
#   The SP1 reference-catalog work already Hasura-tracked `sheet_material_types` and
#   gave multiple roles a SELECT permission on it. However migration 033 was applied
#   AFTER those permissions were created, so `is_cuttable` is absent from every role's
#   SELECT column allowlist.
#
#   Frontend consumers (useSheetMaterialOptions.ts:41, ExcelImportModal.tsx:63,
#   PdfImportModal.tsx:51, VlmImportModal.tsx:70) request `is_cuttable` via Hasura
#   GraphQL (useBackendReferences defaults off). Without this grant they receive
#   "field 'is_cuttable' not found in type: 'sheet_material_types'" → sheet picker /
#   bulk edit / import errors.
#
# Approach:
#   1. export_metadata — get the full current permission JSON.
#   2. Parse with python3. For EVERY role that has a select_permission on
#      sheet_material_types: deep-copy the existing permission (preserving filter,
#      limit, allow_aggregations, computed_fields, query_root_fields, etc.), add
#      `is_cuttable` to the columns array if not already present.
#   3. pg_drop_select_permission + pg_create_select_permission for each role.
#      Idempotent: drop is a no-op if the permission doesn't exist.
#   4. If `is_cuttable` is already in a role's columns, that role is a no-op (still
#      recreated to be safe, but logged as no-change).
#   5. Roles are DERIVED from live metadata — no hardcoded list.
#
# Reads HASURA_GRAPHQL_ENDPOINT and HASURA_ADMIN_SECRET from the environment.
# Does NOT print the secret.
#
# Usage:
#   set -a; source /path/to/.env; set +a
#   ops/hasura/variant-b-sheet-is-cuttable-select.sh

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

log "Starting Variant B sheet_material_types.is_cuttable SELECT grant (metadata-preserving)"
log "Endpoint: ${BASE_URL}"
log "Fetching current Hasura metadata..."

METADATA_JSON=$(hasura_api '{"type":"export_metadata","args":{}}')

log "Metadata fetched. Computing SELECT permission mutations for sheet_material_types..."

ACTIONS_FILE=$(mktemp /tmp/vb-cuttable-select-actions-XXXXXX.json)
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

TARGET_TABLE = "sheet_material_types"
COLUMN_TO_ADD = "is_cuttable"

actions = []

for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        tbl_name = table["table"]["name"]
        tbl_schema = table["table"].get("schema", "public")
        if tbl_name != TARGET_TABLE:
            continue

        for perm in table.get("select_permissions", []):
            role = perm["role"]

            # Deep-copy the full permission object so we preserve filter,
            # limit, allow_aggregations, computed_fields, query_root_fields, etc.
            permission = json.loads(json.dumps(perm["permission"]))

            cols = list(permission.get("columns") or [])
            already_present = COLUMN_TO_ADD in cols
            if not already_present:
                cols.append(COLUMN_TO_ADD)
                permission["columns"] = cols

            label = (
                f"sheet_material_types/{role}/select"
                f": {'added is_cuttable' if not already_present else 'no-change (already present, recreate for safety)'}"
            )
            print(f"  {label}", file=sys.stderr)

            table_ref = {"schema": tbl_schema, "name": tbl_name}
            drop_payload = json.dumps({
                "type": "pg_drop_select_permission",
                "args": {"table": table_ref, "role": role, "source": source_name}
            })
            create_payload = json.dumps({
                "type": "pg_create_select_permission",
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
log "Applying ${ACTION_COUNT} SELECT permission mutations..."

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
    print(f"  create: {action['label']} (filter/limit/allow_aggregations preserved)", flush=True)
    hasura_api(action["create"])

print("Done.")
PY_APPLY

log "Variant B sheet_material_types.is_cuttable SELECT grant applied successfully."
log "Run ops/hasura/variant-b-assert-sheet-is-cuttable-select.sh to verify."

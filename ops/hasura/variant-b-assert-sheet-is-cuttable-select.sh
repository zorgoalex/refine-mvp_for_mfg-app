#!/usr/bin/env bash
# variant-b-assert-sheet-is-cuttable-select.sh
#
# Assertion (Variant B Critic R5 BLOCKER fix):
# Verifies that EVERY role holding a select_permission on `sheet_material_types`
# in the live Hasura metadata HAS `is_cuttable` in its SELECT column allowlist.
#
# Exit 0 = assertion passes (all roles with a select_permission include is_cuttable).
# Exit 1 = assertion fails (prints which roles are missing is_cuttable).
#
# Run this after variant-b-sheet-is-cuttable-select.sh to confirm the grant took
# effect. Also suitable as a CI or cutover smoke check.
#
# Supports both direct-host mode (HASURA_GRAPHQL_ENDPOINT + HASURA_ADMIN_SECRET) and
# docker-exec mode (HASURA_GRAPHQL_ADMIN_SECRET set; Hasura on localhost:8080).
#
# Usage (host):
#   set -a; source /path/to/.env; set +a
#   ops/hasura/variant-b-assert-sheet-is-cuttable-select.sh
#
# Usage (docker-exec):
#   docker exec erp_test-hasura-1 sh -c \
#     'HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
#      ops/hasura/variant-b-assert-sheet-is-cuttable-select.sh'

set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] FAIL: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

# Support both direct-host mode and docker-exec mode (mirrors variant-b-assert-write-isolation.sh).
if [[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]]; then
  BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
  BASE_URL="${BASE_URL%/graphql}"
  METADATA_URL="${BASE_URL}/v1/metadata"
  ADMIN_SECRET="${HASURA_ADMIN_SECRET:-}"
  [[ -n "$ADMIN_SECRET" ]] || fail "HASURA_ADMIN_SECRET is required"
elif [[ -n "${HASURA_GRAPHQL_ADMIN_SECRET:-}" ]]; then
  # Inside the hasura docker container.
  METADATA_URL="http://localhost:8080/v1/metadata"
  ADMIN_SECRET="${HASURA_GRAPHQL_ADMIN_SECRET}"
else
  fail "Set HASURA_GRAPHQL_ENDPOINT + HASURA_ADMIN_SECRET (host) or HASURA_GRAPHQL_ADMIN_SECRET (docker-exec)"
fi

log "Fetching Hasura metadata from ${METADATA_URL}"

METADATA_JSON=$(curl -sSf \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d '{"type":"export_metadata","args":{}}' \
  "${METADATA_URL}")

log "Metadata fetched. Running is_cuttable SELECT assertion for sheet_material_types..."

export _VARIANT_B_METADATA="$METADATA_JSON"

python3 - <<'PY'
import sys
import json
import os

raw = os.environ.get("_VARIANT_B_METADATA", "")
if not raw:
    print("ERROR: _VARIANT_B_METADATA is empty", file=sys.stderr)
    sys.exit(1)

m = json.loads(raw)
metadata = m.get("metadata", m) if isinstance(m, dict) else m

TARGET_TABLE = "sheet_material_types"
REQUIRED_COLUMN = "is_cuttable"

missing = []
checked = []

for source in metadata.get("sources", []):
    for table in source.get("tables", []):
        if table["table"]["name"] != TARGET_TABLE:
            continue
        for perm in table.get("select_permissions", []):
            role = perm["role"]
            cols = set(perm["permission"].get("columns") or [])
            checked.append(role)
            if REQUIRED_COLUMN not in cols:
                missing.append(f"  MISSING: role={role} does not have '{REQUIRED_COLUMN}' in sheet_material_types SELECT allowlist")

if not checked:
    # No select_permissions at all on the table — that is also a problem.
    print(f"ASSERTION FAILED: no select_permissions found on table '{TARGET_TABLE}' in any source.")
    sys.exit(1)

if missing:
    print(f"ASSERTION FAILED: '{REQUIRED_COLUMN}' missing from sheet_material_types SELECT allowlist:")
    for m in missing:
        print(m)
    print(f"Checked roles: {sorted(checked)}")
    sys.exit(1)

print(f"OK: all {len(checked)} role(s) with a sheet_material_types SELECT permission include '{REQUIRED_COLUMN}'.")
print(f"    Roles checked: {sorted(checked)}")
PY

STATUS=$?
unset _VARIANT_B_METADATA

if [[ $STATUS -eq 0 ]]; then
  log "Assertion PASSED: sheet_material_types.is_cuttable is SELECT-accessible to all authorized roles."
else
  log "Assertion FAILED: run ops/hasura/variant-b-sheet-is-cuttable-select.sh to fix."
  exit 1
fi

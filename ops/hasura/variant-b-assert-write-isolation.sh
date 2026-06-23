#!/usr/bin/env bash
# variant-b-assert-write-isolation.sh
#
# Step 4 end-state assertion (Variant B Task 11 / Critic R9 M1):
# Asserts that NO backend-only control column is in any non-admin INSERT/UPDATE
# allowlist in the live Hasura metadata.
#
# Backend-only control columns (must NOT be in any non-admin write allowlist):
#   orders:       material_id, sheet_material_type_id, sheet_eligible
#   order_details: material_id, sheet_material_type_id
#   materials:    is_sheet_shadow, shadow_of_sheet_material_type_id
#
# Designed to run inside the erp_test docker stack (Task 13):
#   docker exec erp_test-hasura-1 sh -c '
#     HASURA_GRAPHQL_ADMIN_SECRET=<secret>
#     ops/hasura/variant-b-assert-write-isolation.sh
#   '
# Or directly from the host if HASURA_GRAPHQL_ENDPOINT and HASURA_ADMIN_SECRET
# are set in the environment.
#
# Exit 0 = assertion passes (no forbidden column in any non-admin allowlist).
# Exit 1 = assertion fails (prints which role/table/column violated the invariant).

set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] FAIL: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

# Support both direct-host mode (HASURA_GRAPHQL_ENDPOINT) and docker-exec mode
# (HASURA_GRAPHQL_ADMIN_SECRET set + local Hasura on localhost:8080).
if [[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]]; then
  BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
  BASE_URL="${BASE_URL%/graphql}"
  METADATA_URL="${BASE_URL}/v1/metadata"
  ADMIN_SECRET="${HASURA_ADMIN_SECRET:-}"
  [[ -n "$ADMIN_SECRET" ]] || fail "HASURA_ADMIN_SECRET is required"
elif [[ -n "${HASURA_GRAPHQL_ADMIN_SECRET:-}" ]]; then
  # Inside the hasura docker container, metadata is on localhost.
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

log "Metadata fetched. Running write-isolation assertion..."

python3 - <<'PY'
import sys
import json
import os

metadata_json = os.environ.get("_VARIANT_B_METADATA", "")

PY

# Pass metadata via environment variable to avoid shell escaping issues.
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

# Admin roles — we do NOT enforce the invariant on these (superadmin/admin can write anything).
ADMIN_ROLES = {"superadmin", "admin"}

# Backend-only control columns that must NOT appear in any non-admin write allowlist.
BANNED = {
    "orders": {"material_id", "sheet_material_type_id", "sheet_eligible"},
    "order_details": {"material_id", "sheet_material_type_id"},
    "materials": {"is_sheet_shadow", "shadow_of_sheet_material_type_id"},
}

violations = []

metadata = m.get("metadata", m) if isinstance(m, dict) else m
for source in metadata.get("sources", []):
    for table in source.get("tables", []):
        nm = table["table"]["name"]
        if nm not in BANNED:
            continue
        for perm_key in ("insert_permissions", "update_permissions"):
            for perm in table.get(perm_key, []):
                role = perm["role"]
                if role in ADMIN_ROLES:
                    continue
                cols = set(perm["permission"].get("columns", []) or [])
                bad = cols & BANNED[nm]
                if bad:
                    violations.append(
                        f"  VIOLATION: table={nm} perm={perm_key} role={role} forbidden_cols={sorted(bad)}"
                    )

if violations:
    print("ASSERTION FAILED: backend-only control column(s) found in non-admin write allowlist:")
    for v in violations:
        print(v)
    sys.exit(1)

print("OK: no backend-only control column is Hasura-writable by any non-admin role.")
PY

STATUS=$?
unset _VARIANT_B_METADATA

if [[ $STATUS -eq 0 ]]; then
  log "Assertion PASSED: Variant B write-isolation is in effect."
else
  log "Assertion FAILED: see output above. Run ops/hasura/variant-b-material-id-isolation.sh to fix."
  exit 1
fi

#!/usr/bin/env bash
# variant-b-material-id-isolation.sh
#
# Variant B Task 11 — write-isolation: remove `material_id` from the non-admin
# Hasura INSERT/UPDATE column allowlists on `orders` and `order_details`.
#
# Background (Critic R25 B2): migration 029 (SP3) already stripped
# `sheet_material_type_id`, `sheet_eligible`, `is_sheet_shadow`, and
# `shadow_of_sheet_material_type_id` from non-admin write allowlists.
# `material_id` is still legacy-writable via Hasura — an exact bypass once the
# backend is the sole NULL-writer after migration 034. This script closes that gap.
#
# Targeted API approach (Critic R26 B1): the repo has NO tracked metadata tree
# and `ops/apply-hasura-metadata.sh` does a FULL `replace_metadata` (would
# clobber unrelated state). Instead, use targeted `pg_drop_*_permission` +
# `pg_create_*_permission` calls per affected role, which is idempotent and
# safe to re-run.
#
# Affected non-admin roles (derived from permissions.ts ROLE_PERMISSIONS):
#   - operator:    orders.create + orders.update → has INSERT+UPDATE in Hasura
#   - manager:     orders.create + orders.update → has INSERT+UPDATE in Hasura
#   - top_manager: orders.create + orders.update → has INSERT+UPDATE in Hasura
# (worker/viewer have only orders.view or orders.change_production_status — no
#  INSERT/UPDATE in Hasura; admin/superadmin are excluded as admin roles.)
#
# Reads HASURA_GRAPHQL_ENDPOINT and HASURA_ADMIN_SECRET from the environment
# (loaded from .env by the caller). Does NOT print the secret.
#
# Usage:
#   source /path/to/.env   # sets HASURA_GRAPHQL_ENDPOINT, HASURA_ADMIN_SECRET
#   ops/hasura/variant-b-material-id-isolation.sh
#
# Or via the project ops pattern:
#   set -a; source .env; set +a
#   ops/hasura/variant-b-material-id-isolation.sh
#
# Idempotent: pg_drop_*_permission is a no-op if the permission doesn't exist;
# pg_create_*_permission recreates it with the correct column set.

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

METADATA_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}/v1/metadata"
METADATA_URL="${METADATA_URL%/graphql}/v1/metadata"
# Normalise: strip any trailing /v1/graphql or /graphql suffix, then append /v1/metadata
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

# ---------------------------------------------------------------------------
# Column allowlists (post-029 + Variant B 034):
# Already excluded by SP3 (migration 029): sheet_material_type_id, sheet_eligible
# Already excluded by SP3 (migration 029 on order_details): sheet_material_type_id
# Already excluded (materials): is_sheet_shadow, shadow_of_sheet_material_type_id
#
# NOW excluding (Variant B Task 11): material_id on orders + order_details
#
# The lists below represent the ALLOWED (writable) columns EXCLUDING all
# backend-only control columns. These are the same columns that were already
# in the SP3 allowlists, minus material_id.
#
# NOTE: The exact column sets below reflect the live erp_test Hasura state after
# migration 029. If the live metadata differs, Task 13 will verify via the
# assertion script (variant-b-assert-write-isolation.sh) and apply corrections.
# ---------------------------------------------------------------------------

# Roles to patch
ROLES=("operator" "manager" "top_manager")

# ---- ORDERS table ----
# Columns that non-admin roles should be allowed to INSERT on `orders`
# (excludes: material_id, sheet_material_type_id, sheet_eligible — backend-only).
ORDERS_INSERT_COLUMNS='[
  "order_name","client_id","order_date","priority","completion_date",
  "planned_completion_date","order_status_id","payment_status_id",
  "production_status_id","milling_type_id","edge_type_id","film_id",
  "total_amount","final_amount","discount","surcharge","paid_amount",
  "payment_date","parts_count","total_area","notes","link_cutting_file",
  "link_cutting_image_file","ref_key_1c","manager_id","delete_flag",
  "issue_date","created_by","edited_by","production_status_mode"
]'

# Columns that non-admin roles should be allowed to UPDATE on `orders`
# (same exclusions as INSERT).
ORDERS_UPDATE_COLUMNS="$ORDERS_INSERT_COLUMNS"

# ---- ORDER_DETAILS table ----
# Columns that non-admin roles should be allowed to INSERT on `order_details`
# (excludes: material_id, sheet_material_type_id — backend-only).
ORDER_DETAILS_INSERT_COLUMNS='[
  "order_id","detail_number","detail_name","height","width","quantity",
  "production_status_id","notes","delete_flag","film_id","texture",
  "edge_type_id","milling_type_id","edge_1","edge_2","edge_3","edge_4"
]'

ORDER_DETAILS_UPDATE_COLUMNS="$ORDER_DETAILS_INSERT_COLUMNS"

log "Starting Variant B material_id write-isolation (targeted Hasura metadata API)"
log "Endpoint: ${BASE_URL}"
log "Roles: ${ROLES[*]}"

for ROLE in "${ROLES[@]}"; do
  log "--- Role: ${ROLE} ---"

  # -- orders INSERT --
  log "  Dropping insert permission on orders for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_insert_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating insert permission on orders for role ${ROLE} (material_id excluded)"
  hasura_api "$(printf '{"type":"pg_create_insert_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","permission":{"check":{},"columns":%s,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDERS_INSERT_COLUMNS")" > /dev/null

  # -- orders UPDATE --
  log "  Dropping update permission on orders for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_update_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating update permission on orders for role ${ROLE} (material_id excluded)"
  hasura_api "$(printf '{"type":"pg_create_update_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","permission":{"columns":%s,"filter":{},"check":null,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDERS_UPDATE_COLUMNS")" > /dev/null

  # -- order_details INSERT --
  log "  Dropping insert permission on order_details for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_insert_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating insert permission on order_details for role ${ROLE} (material_id excluded)"
  hasura_api "$(printf '{"type":"pg_create_insert_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","permission":{"check":{},"columns":%s,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDER_DETAILS_INSERT_COLUMNS")" > /dev/null

  # -- order_details UPDATE --
  log "  Dropping update permission on order_details for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_update_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating update permission on order_details for role ${ROLE} (material_id excluded)"
  hasura_api "$(printf '{"type":"pg_create_update_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","permission":{"columns":%s,"filter":{},"check":null,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDER_DETAILS_UPDATE_COLUMNS")" > /dev/null

  log "  Done: ${ROLE}"
done

log "Variant B material_id write-isolation applied successfully."
log "Run ops/hasura/variant-b-assert-write-isolation.sh (via docker exec) to verify."

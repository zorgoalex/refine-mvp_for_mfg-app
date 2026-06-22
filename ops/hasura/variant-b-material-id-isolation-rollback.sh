#!/usr/bin/env bash
# variant-b-material-id-isolation-rollback.sh
#
# Rollback for variant-b-material-id-isolation.sh: restores `material_id` to the
# non-admin INSERT/UPDATE column allowlists on `orders` and `order_details`.
#
# Use ONLY when rolling back to the pre-034 path (i.e. before migration 034 is
# applied). After migration 034, `material_id` is NULL for all order rows and the
# backend is the sole writer — do NOT use this rollback post-034.
#
# Reads HASURA_GRAPHQL_ENDPOINT and HASURA_ADMIN_SECRET from the environment.
# Does NOT print the secret.
#
# Usage:
#   source /path/to/.env
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

# ---------------------------------------------------------------------------
# Column allowlists WITH material_id restored (pre-Variant-B state after SP3).
# SP3 exclusions are still in place (sheet_material_type_id, sheet_eligible,
# is_sheet_shadow, shadow_of_sheet_material_type_id remain excluded — those are
# from migration 029 and are NOT rolled back here).
# ---------------------------------------------------------------------------

ROLES=("operator" "manager" "top_manager")

# orders: WITH material_id restored (plus sheet_material_type_id still excluded as SP3)
ORDERS_INSERT_COLUMNS='[
  "order_name","client_id","order_date","priority","completion_date",
  "planned_completion_date","order_status_id","payment_status_id",
  "production_status_id","milling_type_id","edge_type_id","film_id",
  "material_id",
  "total_amount","final_amount","discount","surcharge","paid_amount",
  "payment_date","parts_count","total_area","notes","link_cutting_file",
  "link_cutting_image_file","ref_key_1c","manager_id","delete_flag",
  "issue_date","created_by","edited_by","production_status_mode"
]'

ORDERS_UPDATE_COLUMNS="$ORDERS_INSERT_COLUMNS"

# order_details: WITH material_id restored (plus sheet_material_type_id still excluded as SP3)
ORDER_DETAILS_INSERT_COLUMNS='[
  "order_id","detail_number","detail_name","height","width","quantity",
  "production_status_id","notes","delete_flag","film_id","texture",
  "edge_type_id","milling_type_id","edge_1","edge_2","edge_3","edge_4",
  "material_id"
]'

ORDER_DETAILS_UPDATE_COLUMNS="$ORDER_DETAILS_INSERT_COLUMNS"

log "Starting Variant B material_id isolation ROLLBACK (restoring material_id to allowlists)"
log "WARNING: use only when rolling back to pre-034 path."
log "Endpoint: ${BASE_URL}"
log "Roles: ${ROLES[*]}"

for ROLE in "${ROLES[@]}"; do
  log "--- Role: ${ROLE} ---"

  log "  Dropping insert permission on orders for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_insert_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating insert permission on orders for role ${ROLE} (material_id RESTORED)"
  hasura_api "$(printf '{"type":"pg_create_insert_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","permission":{"check":{},"columns":%s,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDERS_INSERT_COLUMNS")" > /dev/null

  log "  Dropping update permission on orders for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_update_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating update permission on orders for role ${ROLE} (material_id RESTORED)"
  hasura_api "$(printf '{"type":"pg_create_update_permission","args":{"table":{"schema":"public","name":"orders"},"role":"%s","permission":{"columns":%s,"filter":{},"check":null,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDERS_UPDATE_COLUMNS")" > /dev/null

  log "  Dropping insert permission on order_details for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_insert_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating insert permission on order_details for role ${ROLE} (material_id RESTORED)"
  hasura_api "$(printf '{"type":"pg_create_insert_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","permission":{"check":{},"columns":%s,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDER_DETAILS_INSERT_COLUMNS")" > /dev/null

  log "  Dropping update permission on order_details for role ${ROLE}"
  hasura_api "$(printf '{"type":"pg_drop_update_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","source":"default"}}' "$ROLE")" > /dev/null

  log "  Creating update permission on order_details for role ${ROLE} (material_id RESTORED)"
  hasura_api "$(printf '{"type":"pg_create_update_permission","args":{"table":{"schema":"public","name":"order_details"},"role":"%s","permission":{"columns":%s,"filter":{},"check":null,"backend_only":false},"source":"default"}}' "$ROLE" "$ORDER_DETAILS_UPDATE_COLUMNS")" > /dev/null

  log "  Done: ${ROLE}"
done

log "Rollback complete: material_id restored to non-admin allowlists."

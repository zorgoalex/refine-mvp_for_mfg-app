#!/usr/bin/env bash
# Revoke the Hasura write permissions of doweling orders and their order links for every role.
# Doweling writes are backend commands: the doweling card (PATCH /api/v1/doweling-orders/:id), the quick-create from an
# order (POST /api/v1/doweling-orders with orderId) and the order save (links of an order). The frontend of this release
# no longer writes these tables through Hasura.
# Run it only AFTER the backend and the frontend of this release are live: the previous frontend still writes them.
#
# Removed: doweling_orders insert/update/delete and order_doweling_links insert/update (select stays). The exact
# permissions that existed before are kept in doweling-writes-before-revoke.json next to this script (the state after
# access groups 0Б). The script refuses to run when the live permissions are neither that state nor already revoked,
# so it never drops or recreates permissions it does not know. One atomic bulk request pinned to the metadata
# resource_version that was read: if anyone changed metadata in between, Hasura answers 409 and nothing is applied.
#
# Usage: doweling-backend-owned-writes.sh [--dry-run] [--revert]
#   --revert  recreates exactly the permissions of doweling-writes-before-revoke.json; only over a state where they are
#             absent. Roll the metadata back BEFORE rolling the frontend back (the old frontend needs them).
# The output names table/operation/roles; it never carries a Hasura response body (kept in an owner-only local file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFERENCE_FILE="${SCRIPT_DIR}/doweling-writes-before-revoke.json"

DRY_RUN=false
REVERT=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --revert) REVERT=true ;;
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

# Server .env files carry HASURA_FQDN (the public host) rather than a full endpoint.
if [[ -z "${HASURA_GRAPHQL_ENDPOINT:-}" && -n "${HASURA_FQDN:-}" ]]; then HASURA_GRAPHQL_ENDPOINT="https://${HASURA_FQDN}/v1/graphql"; fi

if [[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]]; then
  BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
  BASE_URL="${BASE_URL%/graphql}"
  METADATA_URL="${BASE_URL}/v1/metadata"
  ADMIN_SECRET="${HASURA_ADMIN_SECRET:-}"
elif [[ -n "${HASURA_GRAPHQL_ADMIN_SECRET:-}" ]]; then
  METADATA_URL="http://localhost:8080/v1/metadata"
  ADMIN_SECRET="${HASURA_GRAPHQL_ADMIN_SECRET}"
else
  fail "Set HASURA_GRAPHQL_ENDPOINT (or HASURA_FQDN) + HASURA_ADMIN_SECRET, or run inside Hasura container with HASURA_GRAPHQL_ADMIN_SECRET"
fi

[[ -n "${ADMIN_SECRET:-}" ]] || fail "Hasura admin secret is required"
[[ -f "$REFERENCE_FILE" ]] || fail "reference file not found next to the script: ${REFERENCE_FILE}"

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

BULK_FILE="$(mktemp /tmp/doweling-writes-bulk-XXXXXX.json)"
trap 'rm -f "$BULK_FILE"' EXIT

export _DOWELING_METADATA="$METADATA_JSON"
export _DOWELING_REVERT="$REVERT"
python3 - "$BULK_FILE" "$REFERENCE_FILE" <<'PY'
import json
import os
import sys

bulk_path, reference_path = sys.argv[1], sys.argv[2]


def die(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def normalized(permissions):
    """Order-insensitive comparison: roles sorted, column lists sorted, an empty comment dropped."""
    result = []
    for entry in sorted(permissions, key=lambda p: p["role"]):
        entry = json.loads(json.dumps(entry))
        if entry.get("comment") == "":
            del entry["comment"]
        if isinstance(entry.get("permission", {}).get("columns"), list):
            entry["permission"]["columns"] = sorted(entry["permission"]["columns"])
        result.append(entry)
    return json.dumps(result, sort_keys=True)


raw = os.environ.get("_DOWELING_METADATA", "")
if not raw:
    die("_DOWELING_METADATA is empty")
exported = json.loads(raw)
resource_version = exported.get("resource_version")
metadata = exported.get("metadata")
if not isinstance(resource_version, int) or not isinstance(metadata, dict):
    die("export_metadata v2 did not return resource_version + metadata")
revert = os.environ.get("_DOWELING_REVERT") == "true"

with open(reference_path, "r", encoding="utf-8") as handle:
    reference = json.load(handle)["permissions"]

sources = metadata.get("sources") or []
if len(sources) != 1:
    die(f"expected exactly one source, found {len(sources)}")
source_name = sources[0].get("name", "default")
tables = {(t["table"].get("schema", "public"), t["table"]["name"]): t for t in sources[0].get("tables", [])}

args = []
for table_name in sorted(reference):
    live_table = tables.get(("public", table_name))
    if live_table is None:
        die(f"table public.{table_name} is not tracked")
    hasura_table = {"schema": "public", "name": table_name}
    for op in ("insert", "update", "delete"):
        known = reference[table_name].get(op)
        live = live_table.get(f"{op}_permissions") or []
        if known is None:
            # An operation that had no grant before must have none now: an unexpected grant is drift, not ours.
            if live:
                live_roles = ", ".join(sorted(p["role"] for p in live))
                die(f"{table_name}/{op}: unexpected live permissions ({live_roles}); nothing applied")
            continue
        roles = ", ".join(sorted(p["role"] for p in known))
        if not live:
            state = "revoked"
        elif normalized(live) == normalized(known):
            state = "granted"
        else:
            live_roles = ", ".join(sorted(p["role"] for p in live))
            die(f"{table_name}/{op}: live permissions ({live_roles}) are neither the known state nor revoked; nothing applied")
        if revert:
            if state == "granted":
                print(f"  {table_name}/{op}: granted ({roles}): no-change", file=sys.stderr)
                continue
            print(f"  {table_name}/{op}: revoked -> granted ({roles})", file=sys.stderr)
            for permission in known:
                create = {"source": source_name, "table": hasura_table, "role": permission["role"], "permission": permission["permission"]}
                if permission.get("comment"):
                    create["comment"] = permission["comment"]
                args.append({"type": f"pg_create_{op}_permission", "args": create})
        else:
            if state == "revoked":
                print(f"  {table_name}/{op}: revoked: no-change", file=sys.stderr)
                continue
            print(f"  {table_name}/{op}: granted ({roles}) -> revoked", file=sys.stderr)
            for permission in live:
                args.append({"type": f"pg_drop_{op}_permission",
                             "args": {"source": source_name, "table": hasura_table, "role": permission["role"]}})

with open(bulk_path, "w") as f:
    json.dump({"type": "bulk", "resource_version": resource_version, "args": args}, f)
print(f"Permission changes: {len(args)}", file=sys.stderr)
PY
unset _DOWELING_METADATA _DOWELING_REVERT

COUNT="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['args']))" "$BULK_FILE")"
if [[ "$COUNT" == "0" ]]; then
  log "Nothing to change."
  exit 0
fi
if $DRY_RUN; then
  log "Dry run: ${COUNT} permission change(s) would be applied."
  exit 0
fi

log "Applying ${COUNT} permission change(s) in one bulk request..."
RESPONSE_FILE="$(mktemp /tmp/doweling-writes-response-XXXXXX.json)"
KEEP_RESPONSE=false
trap 'rm -f "$BULK_FILE"; $KEEP_RESPONSE || rm -f "$RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d @"$BULK_FILE" \
  "${METADATA_URL}")"
case "$HTTP_CODE" in
  200) if $REVERT; then log "Doweling Hasura write permissions restored."; else log "Doweling Hasura write permissions revoked (backend-owned)."; fi ;;
  409) fail "Hasura metadata changed after it was read (409 conflict); nothing applied. Re-run the script." ;;
  *)
    # The body may quote metadata (connection settings, headers): it is never printed.
    KEEP_RESPONSE=true
    chmod 600 "$RESPONSE_FILE"
    ERROR_CODE="$(python3 -c "
import json, re, sys
try:
    code = json.load(open(sys.argv[1])).get('code')
except Exception:
    code = None
print(code if isinstance(code, str) and re.fullmatch(r'[a-z0-9-]{1,40}', code) else 'unknown')
" "$RESPONSE_FILE")"
    fail "Hasura metadata API answered HTTP ${HTTP_CODE} (code: ${ERROR_CODE}); nothing is known to be applied. The response body is kept locally in ${RESPONSE_FILE} (owner-only; do not forward it)." ;;
esac

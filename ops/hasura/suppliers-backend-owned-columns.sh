#!/usr/bin/env bash
# Take `ref_key_1c` out of the Hasura insert/update columns of `suppliers` for every role.
# The link of a supplier to its 1C counterparty is changed only by the backend command
# (compare-and-swap + audit); the new frontend no longer writes the column through Hasura.
# Run it only AFTER the frontend of this release is live: the previous frontend still
# sends ref_key_1c with the supplier form.
#
# Only the column lists of the suppliers insert/update permissions change: check, filter
# and set stay as they are live, every other table is untouched. The target lists are the
# ones of ops/hasura/metadata.json next to this script. The script refuses to run when the
# live permissions are not what it expects: other roles, or columns that are neither all
# columns ("*", the state before this release) nor already the list of the file. All permissions are recreated in one atomic bulk request pinned to the
# metadata resource_version that was read: if anyone changed metadata in between, Hasura
# answers 409 and nothing is applied (re-run to read the fresh permissions).
#
# Usage: suppliers-backend-owned-columns.sh [--dry-run] [--revert]
#   --revert  gives every role all columns again ("*", the state before this release). It
#             cannot widen anything: the change is applied only over "*".
# Every line of the output names the role, the kind and the columns before -> after. The
# output never carries a Hasura response body: on an unexpected answer only the HTTP status
# and the machine error code are printed, the body stays in a local file readable by the
# owner only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAPSHOT_FILE="${SCRIPT_DIR}/metadata.json"

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

hasura_api() {
  local payload="$1"
  curl -sSf \
    -H "Content-Type: application/json" \
    -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
    -d "$payload" \
    "${METADATA_URL}"
}

[[ -f "$SNAPSHOT_FILE" ]] || fail "metadata snapshot not found next to the script: ${SNAPSHOT_FILE}"

log "Fetching current Hasura metadata (with resource_version)..."
METADATA_JSON="$(hasura_api '{"type":"export_metadata","version":2,"args":{}}')"

BULK_FILE="$(mktemp /tmp/suppliers-columns-bulk-XXXXXX.json)"
trap 'rm -f "$BULK_FILE"' EXIT

export _SUPPLIERS_METADATA="$METADATA_JSON"
export _SUPPLIERS_TARGET="$TARGET"
python3 - "$BULK_FILE" "$SNAPSHOT_FILE" <<'PY'
import json
import os
import sys

bulk_path, snapshot_path = sys.argv[1], sys.argv[2]
OWNED = "ref_key_1c"
TABLE = "suppliers"
KINDS = ("insert", "update")


def die(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def suppliers_table(root):
    for source in root.get("sources", []):
        for table in source.get("tables", []):
            ref = table.get("table", {})
            if ref.get("name") == TABLE and ref.get("schema", "public") == "public":
                return source.get("name", "default"), table
    return None, None


raw = os.environ.get("_SUPPLIERS_METADATA", "")
if not raw:
    die("_SUPPLIERS_METADATA is empty")
exported = json.loads(raw)
resource_version = exported.get("resource_version")
metadata = exported.get("metadata")
if not isinstance(resource_version, int) or not isinstance(metadata, dict):
    die("export_metadata v2 did not return resource_version + metadata")
apply_target = os.environ.get("_SUPPLIERS_TARGET") == "true"

with open(snapshot_path, "r", encoding="utf-8") as handle:
    snapshot = json.load(handle)
_, snapshot_table = suppliers_table(snapshot.get("metadata", snapshot))
if snapshot_table is None:
    die("public.suppliers is not in the metadata snapshot")
source_name, live_table = suppliers_table(metadata)
if live_table is None:
    die("table public.suppliers is not tracked")

hasura_table = {"schema": "public", "name": TABLE}
args = []
for kind in KINDS:
    wanted = {}
    for perm in snapshot_table.get(f"{kind}_permissions", []):
        columns = perm["permission"].get("columns")
        if not isinstance(columns, list) or OWNED in columns or not columns:
            die(f"snapshot {TABLE}/{perm['role']}/{kind}: expected an explicit column list without {OWNED}")
        wanted[perm["role"]] = sorted(columns)
    live = {perm["role"]: perm for perm in live_table.get(f"{kind}_permissions", [])}
    if sorted(live) != sorted(wanted):
        die(f"{TABLE}/{kind}: live roles {sorted(live)} differ from the snapshot roles {sorted(wanted)}; nothing applied")
    for role in sorted(live):
        permission = json.loads(json.dumps(live[role]["permission"]))
        current = permission.get("columns")
        if current != "*":
            if not isinstance(current, list):
                die(f"{TABLE}/{role}/{kind}: unexpected live columns value; nothing applied")
            # A live explicit list is accepted only when it already is the target list. Any other list
            # (even "target + ref_key_1c") is refused: --revert gives "*" back, which would then be
            # wider than the rights that were live before.
            if sorted(current) != wanted[role]:
                extra = sorted(set(current) - set(wanted[role]))
                missing = sorted(set(wanted[role]) - set(current))
                die(f"{TABLE}/{role}/{kind}: live columns are neither all columns (*) nor the snapshot list (only live: {extra}; only snapshot: {missing}); nothing applied")
        if current == "*":
            was = "all columns (*)"
        else:
            was = f"explicit list without {OWNED} ({len(current)} columns)"
        if apply_target:
            target = wanted[role]
            unchanged = isinstance(current, list) and sorted(current) == target
            label = f"explicit list without {OWNED} ({len(target)} columns)"
        else:
            target = "*"
            unchanged = current == "*"
            label = "all columns (*)"
        if unchanged:
            print(f"  {TABLE}/{role}/{kind}: {was}: no-change", file=sys.stderr)
            continue
        permission["columns"] = target
        print(f"  {TABLE}/{role}/{kind}: {was} -> {label}", file=sys.stderr)
        args.append({"type": f"pg_drop_{kind}_permission",
                     "args": {"source": source_name, "table": hasura_table, "role": role}})
        args.append({"type": f"pg_create_{kind}_permission",
                     "args": {"source": source_name, "table": hasura_table, "role": role,
                              "permission": permission}})

with open(bulk_path, "w") as f:
    json.dump({"type": "bulk", "resource_version": resource_version, "args": args}, f)
print(f"Permissions to update: {len(args) // 2}", file=sys.stderr)
PY
unset _SUPPLIERS_METADATA _SUPPLIERS_TARGET

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
RESPONSE_FILE="$(mktemp /tmp/suppliers-columns-response-XXXXXX.json)"
KEEP_RESPONSE=false
trap 'rm -f "$BULK_FILE"; $KEEP_RESPONSE || rm -f "$RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d @"$BULK_FILE" \
  "${METADATA_URL}")"
case "$HTTP_CODE" in
  200) if $TARGET; then log "suppliers insert/update columns without ref_key_1c applied."; else log "suppliers insert/update columns reverted to all columns."; fi ;;
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

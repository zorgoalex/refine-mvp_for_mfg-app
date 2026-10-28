#!/usr/bin/env bash
# Allow the row count (roles_aggregate) on `roles` for every role that already has
# SELECT on it. The Refine Hasura list asks for <resource>_aggregate together with the
# rows, so without it «Видимость экранов», the financial access matrix and notification
# recipients fail with "field 'roles_aggregate' not found". Columns and filters stay as
# they are; all permissions are recreated in one atomic bulk request pinned to the
# metadata resource_version that was read: if anyone changed metadata in between,
# Hasura answers 409 and nothing is applied (re-run to read the fresh permissions).
#
# Usage: roles-select-aggregations.sh [--dry-run] [--revert] [--tables a,b,c] [--only t/r,…]
#                                     [--manifest-out FILE] | --revert --manifest FILE
#   --manifest-out  after a successful apply: re-export, check that nothing but the changed flags differs from the
#             export the change was made on, and write the rollback manifest (the changed table/role pairs and
#             the metadata resource_version right after the change). No manifest if anything else changed.
#   --revert --manifest FILE  rollback of exactly that apply: only those pairs, and only while the metadata is
#             still at the manifest version (any later change → ERROR, nothing sent; roll back by hand).
#   --revert  sets allow_aggregations back to false (rollback), same safety rules.
#   --only    table/role,table/role… — change only these select permissions (each must exist); every other
#             permission stays as it is. A rollback passes exactly the pairs the fix changed, so a permission
#             added or changed by someone else later is never touched.
#   --tables  the tables to change (default: roles). 28.10: also the reference lists
#             movements_statuses, material_transaction_types, transaction_direction — their
#             lists failed for every role with "<table>_aggregate not found".

set -euo pipefail

DRY_RUN=false
TARGET=true
TABLES=roles
ONLY=""
MANIFEST_OUT=""
MANIFEST_IN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --revert) TARGET=false ;;
    --tables)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'missing value for --tables\n' >&2; exit 2; }
      TABLES="$2"; shift ;;
    --only)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'missing value for --only\n' >&2; exit 2; }
      ONLY="$2"; shift ;;
    --manifest-out)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'missing value for --manifest-out\n' >&2; exit 2; }
      MANIFEST_OUT="$2"; shift ;;
    --manifest)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'missing value for --manifest\n' >&2; exit 2; }
      MANIFEST_IN="$2"; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
EXPECT_VERSION=""
if [[ -n "$MANIFEST_IN" ]]; then
  [[ "$TARGET" == false ]] || { printf -- '--manifest is for --revert only\n' >&2; exit 2; }
  [[ -z "$MANIFEST_OUT" && -z "$ONLY" ]] || { printf -- '--manifest replaces --only/--manifest-out\n' >&2; exit 2; }
  [[ -s "$MANIFEST_IN" ]] || { printf 'manifest not found: %s\n' "$MANIFEST_IN" >&2; exit 2; }
  read -r TABLES ONLY EXPECT_VERSION < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(",".join(m["tables"]), ",".join(m["pairs"]), int(m["resource_version"]))' "$MANIFEST_IN") \
    || { printf 'invalid manifest: %s\n' "$MANIFEST_IN" >&2; exit 2; }
fi
[[ -z "$MANIFEST_OUT" || "$TARGET" == true ]] || { printf -- '--manifest-out is for the apply only\n' >&2; exit 2; }
[[ "$TABLES" =~ ^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*$ ]] || { printf 'invalid --tables: %s\n' "$TABLES" >&2; exit 2; }
if [[ -n "$ONLY" ]]; then
  [[ "$ONLY" =~ ^[a-z_][a-z0-9_]*/[A-Za-z0-9_-]+(,[a-z_][a-z0-9_]*/[A-Za-z0-9_-]+)*$ ]] || { printf 'invalid --only: %s\n' "$ONLY" >&2; exit 2; }
fi

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

log "Fetching current Hasura metadata (with resource_version)..."
# The export (~300 KB) goes through a private temp file, not an environment variable: one environment string is
# limited to 128 KB on Linux ("Argument list too long" before anything is read).
METADATA_FILE="$(mktemp /tmp/roles-aggregations-metadata-XXXXXX.json)"
BULK_FILE="$(mktemp /tmp/roles-aggregations-bulk-XXXXXX.json)"
trap 'rm -f "$METADATA_FILE" "$BULK_FILE"' EXIT
chmod 600 "$METADATA_FILE" "$BULK_FILE"
hasura_api '{"type":"export_metadata","version":2,"args":{}}' > "$METADATA_FILE"
export _ROLES_TARGET="$TARGET"
export _ROLES_TABLES="$TABLES"
export _ROLES_ONLY="$ONLY"
export _ROLES_EXPECT_VERSION="$EXPECT_VERSION"
python3 - "$BULK_FILE" "$METADATA_FILE" <<'PY'
import json
import os
import sys

bulk_path = sys.argv[1]
with open(sys.argv[2]) as metadata_file:
    raw = metadata_file.read()
if not raw:
    print("ERROR: the metadata export is empty", file=sys.stderr)
    sys.exit(1)

exported = json.loads(raw)
resource_version = exported.get("resource_version")
metadata = exported.get("metadata")
if not isinstance(resource_version, int) or not isinstance(metadata, dict):
    print("ERROR: export_metadata v2 did not return resource_version + metadata", file=sys.stderr)
    sys.exit(1)
target = os.environ.get("_ROLES_TARGET") == "true"
expect_version = os.environ.get("_ROLES_EXPECT_VERSION", "")
if expect_version and resource_version != int(expect_version):
    print(f"ERROR: Hasura metadata changed after the fix (resource_version {resource_version}, manifest {expect_version});"
          " nothing sent. Roll back by hand.", file=sys.stderr)
    sys.exit(3)

target_tables = os.environ.get("_ROLES_TABLES", "roles").split(",")
only = {item for item in os.environ.get("_ROLES_ONLY", "").split(",") if item}
for pair in only:
    if pair.split("/", 1)[0] not in target_tables:
        print(f"ERROR: --only {pair}: the table is not in --tables", file=sys.stderr)
        sys.exit(1)
seen_only = set()
args = []
found = set()
for source in metadata.get("sources", []):
    source_name = source.get("name", "default")
    for table in source.get("tables", []):
        table_ref = table.get("table", {})
        target_table = table_ref.get("name")
        if target_table not in target_tables or table_ref.get("schema", "public") != "public":
            continue
        found.add(target_table)
        hasura_table = {"schema": "public", "name": target_table}
        for perm in table.get("select_permissions", []):
            role = perm["role"]
            if only:
                if f"{target_table}/{role}" not in only:
                    continue
                seen_only.add(f"{target_table}/{role}")
            permission = json.loads(json.dumps(perm["permission"]))
            if bool(permission.get("allow_aggregations", False)) is target:
                print(f"  {target_table}/{role}/select: no-change", file=sys.stderr)
                continue
            permission["allow_aggregations"] = target
            print(f"  {target_table}/{role}/select: allow_aggregations -> {str(target).lower()}", file=sys.stderr)
            args.append({"type": "pg_drop_select_permission",
                         "args": {"source": source_name, "table": hasura_table, "role": role}})
            args.append({"type": "pg_create_select_permission",
                         "args": {"source": source_name, "table": hasura_table, "role": role,
                                  "permission": permission}})

missing_only = sorted(only - seen_only)
if missing_only:
    print(f"ERROR: --only: no select permission for {', '.join(missing_only)}", file=sys.stderr)
    sys.exit(1)
missing = [name for name in target_tables if name not in found]
if missing:
    print(f"ERROR: table(s) not tracked: {', '.join('public.' + name for name in missing)}", file=sys.stderr)
    sys.exit(1)

with open(bulk_path, "w") as f:
    json.dump({"type": "bulk", "resource_version": resource_version, "args": args}, f)
print(f"Permissions to update: {len(args) // 2}", file=sys.stderr)
PY
unset _ROLES_TARGET _ROLES_TABLES _ROLES_ONLY _ROLES_EXPECT_VERSION

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
RESPONSE_FILE="$(mktemp /tmp/roles-aggregations-response-XXXXXX.json)"
trap 'rm -f "$METADATA_FILE" "$BULK_FILE" "$RESPONSE_FILE"' EXIT
HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: ${ADMIN_SECRET}" \
  -d @"$BULK_FILE" \
  "${METADATA_URL}")"
case "$HTTP_CODE" in
  200) log "${TABLES} SELECT allow_aggregations=${TARGET} applied." ;;
  409) fail "Hasura metadata changed after it was read (409 conflict); nothing applied. Re-run the script." ;;
  *) fail "Hasura metadata API answered HTTP ${HTTP_CODE}: $(head -c 300 "$RESPONSE_FILE")" ;;
esac

if [[ -n "$MANIFEST_OUT" ]]; then
  POST_FILE="$(mktemp /tmp/roles-aggregations-after-XXXXXX.json)"
  trap 'rm -f "$METADATA_FILE" "$BULK_FILE" "$RESPONSE_FILE" "$POST_FILE"' EXIT
  chmod 600 "$POST_FILE"
  hasura_api '{"type":"export_metadata","version":2,"args":{}}' > "$POST_FILE"
  python3 - "$METADATA_FILE" "$POST_FILE" "$BULK_FILE" "$MANIFEST_OUT" "$TABLES" <<'PY' || fail "No rollback manifest: see the error above (the change itself is applied)."
import json
import sys

pre_path, post_path, bulk_path, manifest_path, tables = sys.argv[1:6]
pre = json.load(open(pre_path))
post = json.load(open(post_path))
bulk = json.load(open(bulk_path))
pairs = sorted(f"{a['args']['table']['name']}/{a['args']['role']}" for a in bulk["args"] if a["type"] == "pg_create_select_permission")

def normalized(metadata, restore_from=None):
    metadata = json.loads(json.dumps(metadata))
    for source in metadata.get("sources", []):
        for table in source.get("tables", []):
            name = table.get("table", {}).get("name")
            perms = table.get("select_permissions") or []
            for perm in perms:
                if restore_from is not None and f"{name}/{perm['role']}" in pairs:
                    before = restore_from.get((name, perm["role"]))
                    if before is None:
                        perm["permission"].pop("allow_aggregations", None)
                    else:
                        perm["permission"]["allow_aggregations"] = before
            if perms:
                table["select_permissions"] = sorted(perms, key=lambda perm: perm["role"])
    return json.dumps(metadata, sort_keys=True)

before_flags = {}
for source in pre["metadata"].get("sources", []):
    for table in source.get("tables", []):
        for perm in table.get("select_permissions") or []:
            before_flags[(table["table"]["name"], perm["role"])] = perm["permission"].get("allow_aggregations")
# Our bulk is one metadata change: the version right after it is the read version + 1. A higher version means someone
# else changed metadata in between (even back to the same content, e.g. a pair dropped and re-created): no manifest.
if post["resource_version"] != pre["resource_version"] + 1:
    print(f"ERROR: Hasura metadata version {post['resource_version']} is not the one right after the fix"
          f" ({pre['resource_version'] + 1}): someone else changed metadata; no rollback manifest", file=sys.stderr)
    sys.exit(4)
if normalized(pre["metadata"]) != normalized(post["metadata"], before_flags):
    print("ERROR: something else changed in Hasura metadata between the fix and its check; no rollback manifest", file=sys.stderr)
    sys.exit(4)
with open(manifest_path, "w") as f:
    json.dump({"tables": tables.split(","), "pairs": pairs, "resource_version": post["resource_version"]}, f, indent=2)
print(f"Rollback manifest: {manifest_path} ({len(pairs)} pair(s), resource_version {post['resource_version']})", file=sys.stderr)
PY
fi

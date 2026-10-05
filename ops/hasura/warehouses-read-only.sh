#!/usr/bin/env bash
# warehouses-read-only.sh
#
# Film warehouse (migration 203): the warehouse reference is written only by the backend
# (/api/v1/inventory/warehouses: permissions, version, 1C key rule, audit). Removes the legacy Hasura
# INSERT/UPDATE/DELETE permissions of `public.warehouses`; SELECT permissions are left as they are.
# Only `warehouses` is touched; the whole metadata is never replaced.
#
#   plan   — print the permissions that would be removed (read-only)
#   apply  — drop them in ONE bulk call (atomic), then verify by export_metadata
#
# No frontend writes warehouses through Hasura, so the order relative to the frontend does not matter.
# Reads HASURA_GRAPHQL_ENDPOINT (or HASURA_FQDN) and HASURA_ADMIN_SECRET from the environment; never prints the secret.
#
# Usage:
#   ( set -a; . /path/to/.env; set +a; ops/hasura/warehouses-read-only.sh plan )

set -euo pipefail

ACTION="${1:-}"
case "$ACTION" in plan|apply) ;; *) echo "Usage: $0 plan|apply" >&2; exit 2 ;; esac
# Server .env files carry HASURA_FQDN (the public host) rather than a full endpoint.
if [[ -z "${HASURA_GRAPHQL_ENDPOINT:-}" && -n "${HASURA_FQDN:-}" ]]; then HASURA_GRAPHQL_ENDPOINT="https://${HASURA_FQDN}/v1/graphql"; fi
[[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]] || { echo "ERROR: HASURA_GRAPHQL_ENDPOINT or HASURA_FQDN is required" >&2; exit 2; }
[[ -n "${HASURA_ADMIN_SECRET:-}" ]] || { echo "ERROR: HASURA_ADMIN_SECRET is required" >&2; exit 2; }

BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
BASE_URL="${BASE_URL%/graphql}"
export WAREHOUSES_METADATA_URL="${BASE_URL}/v1/metadata"
export WAREHOUSES_ACTION="$ACTION"

python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

url = os.environ["WAREHOUSES_METADATA_URL"]
secret = os.environ["HASURA_ADMIN_SECRET"]
action = os.environ["WAREHOUSES_ACTION"]

def call(body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-hasura-admin-secret": secret})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        text = error.read().decode(errors="replace").replace(secret, "***")
        sys.exit(f"ERROR: Hasura {body['type']} failed: {error.code} {text[:400]}")

def warehouses(metadata):
    for source in (metadata.get("sources") or metadata.get("metadata", {}).get("sources") or []):
        for table in source["tables"]:
            ref = table["table"]
            if ref.get("name") == "warehouses" and ref.get("schema", "public") == "public":
                return source["name"], table
    sys.exit("ERROR: public.warehouses not found in metadata")

def write_permissions(table):
    return [(kind, entry["role"]) for kind in ("insert", "update", "delete") for entry in table.get(f"{kind}_permissions") or []]

exported = call({"type": "export_metadata", "version": 2, "args": {}})
source, current = warehouses(exported.get("metadata", exported))
found = write_permissions(current)
select_roles = sorted(entry["role"] for entry in current.get("select_permissions") or [])

if action == "plan":
    print(json.dumps({"source": source, "remove": [{"kind": kind, "role": role} for kind, role in found], "selectRolesKept": select_roles}, ensure_ascii=False, indent=1))
    sys.exit(0)

if not found:
    print(json.dumps({"removed": 0, "alreadyReadOnly": True}))
    sys.exit(0)
table_ref = {"schema": "public", "name": "warehouses"}
call({"type": "bulk", "args": [
    {"type": f"pg_drop_{kind}_permission", "args": {"source": source, "table": table_ref, "role": role}} for kind, role in found]})
after_export = call({"type": "export_metadata", "version": 2, "args": {}})
_, after = warehouses(after_export.get("metadata", after_export))
if write_permissions(after):
    sys.exit("ERROR: verification failed: warehouses still has write permissions")
if sorted(entry["role"] for entry in after.get("select_permissions") or []) != select_roles:
    sys.exit("ERROR: verification failed: warehouses select permissions changed")
print(json.dumps({"removed": len(found), "verified": True}))
PY

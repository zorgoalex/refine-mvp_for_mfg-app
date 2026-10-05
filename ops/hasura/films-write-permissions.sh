#!/usr/bin/env bash
# films-write-permissions.sh
#
# Film catalog (migration 202): make `canonical_film_id`, `catalog_key` and `ref_key_1c` backend-owned.
# Sets the Hasura INSERT/UPDATE permissions of `public.films` to the ones in ops/hasura/metadata.json
# (explicit column list + `edited_by` preset) — only for `films`, never replacing the whole metadata.
#
#   reload — reload_metadata (new `films` columns become readable after migrations 202/212)
#   plan   — print what would change (read-only)
#   apply  — drop+create the differing permissions in ONE bulk call (atomic), then verify by export_metadata
#
# Run AFTER the frontend of this release is live: the previous frontend sends `ref_key_1c` from the film form.
# Reads HASURA_GRAPHQL_ENDPOINT (or HASURA_FQDN) and HASURA_ADMIN_SECRET from the environment; never prints the secret.
#
# Usage:
#   ( set -a; . /path/to/.env; set +a; ops/hasura/films-write-permissions.sh plan )

set -euo pipefail

ACTION="${1:-}"
case "$ACTION" in reload|plan|apply) ;; *) echo "Usage: $0 reload|plan|apply" >&2; exit 2 ;; esac
# Server .env files carry HASURA_FQDN (the public host) rather than a full endpoint.
if [[ -z "${HASURA_GRAPHQL_ENDPOINT:-}" && -n "${HASURA_FQDN:-}" ]]; then HASURA_GRAPHQL_ENDPOINT="https://${HASURA_FQDN}/v1/graphql"; fi
[[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]] || { echo "ERROR: HASURA_GRAPHQL_ENDPOINT or HASURA_FQDN is required" >&2; exit 2; }
[[ -n "${HASURA_ADMIN_SECRET:-}" ]] || { echo "ERROR: HASURA_ADMIN_SECRET is required" >&2; exit 2; }

BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
BASE_URL="${BASE_URL%/graphql}"
export FILMS_PERMISSIONS_METADATA_URL="${BASE_URL}/v1/metadata"
export FILMS_PERMISSIONS_ACTION="$ACTION"
export FILMS_PERMISSIONS_FILE="${FILMS_PERMISSIONS_FILE:-$(cd "$(dirname "$0")" && pwd)/metadata.json}"

python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

url = os.environ["FILMS_PERMISSIONS_METADATA_URL"]
secret = os.environ["HASURA_ADMIN_SECRET"]
action = os.environ["FILMS_PERMISSIONS_ACTION"]
path = os.environ["FILMS_PERMISSIONS_FILE"]

def call(body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "x-hasura-admin-secret": secret})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        text = error.read().decode(errors="replace").replace(secret, "***")
        sys.exit(f"ERROR: Hasura {body['type']} failed: {error.code} {text[:400]}")

def films(metadata):
    for source in (metadata.get("sources") or metadata.get("metadata", {}).get("sources") or []):
        for table in source["tables"]:
            ref = table["table"]
            if ref.get("name") == "films" and ref.get("schema", "public") == "public":
                return source["name"], table
    sys.exit("ERROR: public.films not found in metadata")

def permissions(table, kind):
    return {entry["role"]: entry["permission"] for entry in table.get(f"{kind}_permissions") or []}

canon = lambda value: json.dumps(value, sort_keys=True, ensure_ascii=False)

if action == "reload":
    result = call({"type": "reload_metadata", "args": {"reload_sources": True}})
    print(json.dumps({"reloaded": True, "consistent": result.get("is_consistent", True)}))
    sys.exit(0)

_, desired = films(json.load(open(path, encoding="utf-8")))
exported = call({"type": "export_metadata", "version": 2, "args": {}})
source, current = films(exported.get("metadata", exported))
changes = []
for kind in ("insert", "update"):
    want, have = permissions(desired, kind), permissions(current, kind)
    for role in sorted(want):  # only the roles of the repository file; other live roles are left alone
        if canon(want[role]) != canon(have.get(role)):
            changes.append((kind, role, have.get(role), want[role]))

if action == "plan":
    print(json.dumps({"source": source, "changes": [
        {"kind": kind, "role": role, "haveColumns": (have or {}).get("columns"), "wantColumns": want.get("columns"),
         "haveSet": (have or {}).get("set"), "wantSet": want.get("set")} for kind, role, have, want in changes]},
        ensure_ascii=False, indent=1))
    sys.exit(0)

if not changes:
    print(json.dumps({"applied": 0, "alreadyUpToDate": True}))
    sys.exit(0)
table_ref = {"schema": "public", "name": "films"}
steps = []
for kind, role, have, want in changes:
    if have is not None:
        steps.append({"type": f"pg_drop_{kind}_permission", "args": {"source": source, "table": table_ref, "role": role}})
    steps.append({"type": f"pg_create_{kind}_permission", "args": {"source": source, "table": table_ref, "role": role, "permission": want}})
call({"type": "bulk", "args": steps})
after_export = call({"type": "export_metadata", "version": 2, "args": {}})
_, after = films(after_export.get("metadata", after_export))
for kind in ("insert", "update"):
    want, have = permissions(desired, kind), permissions(after, kind)
    for role in want:
        if canon(want[role]) != canon(have.get(role)):
            sys.exit(f"ERROR: verification failed for {kind} permission of role {role}")
print(json.dumps({"applied": len(changes), "verified": True}))
PY

#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
METADATA_PATH=""
VERIFY=1

usage() {
  cat <<'EOF'
apply-hasura-metadata.sh

Apply Hasura metadata from a metadata.json file or archive containing metadata.json.

Usage:
  ops/apply-hasura-metadata.sh --metadata PATH [--env-file PATH] [--skip-verify]

Supported metadata inputs:
  - metadata.json exported with Hasura export_metadata
  - .tar, .tar.gz, .tgz, or .zip archive containing metadata.json

YAML metadata directories from Hasura CLI are not applied by this script. Export
metadata as JSON or include metadata.json in the archive.
EOF
}

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --metadata) METADATA_PATH="$2"; shift 2 ;;
    --skip-verify) VERIFY=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$METADATA_PATH" ]] || fail "--metadata is required"
[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -e "$METADATA_PATH" ]] || fail "Metadata path not found: $METADATA_PATH"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ -n "${HASURA_FQDN:-}" ]] || fail "HASURA_FQDN is required in .env"
[[ -n "${HASURA_ADMIN_SECRET:-}" ]] || fail "HASURA_ADMIN_SECRET is required in .env"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

metadata_json=""

find_metadata_json() {
  local directory="$1"
  find "$directory" -type f -name metadata.json | sort | sed -n '1p'
}

case "$METADATA_PATH" in
  *.json)
    [[ -f "$METADATA_PATH" ]] || fail "Metadata JSON is not a file: $METADATA_PATH"
    metadata_json="$METADATA_PATH"
    ;;
  *.tar.gz|*.tgz|*.tar)
    [[ -f "$METADATA_PATH" ]] || fail "Metadata archive is not a file: $METADATA_PATH"
    tar -xf "$METADATA_PATH" -C "$work_dir"
    metadata_json="$(find_metadata_json "$work_dir")"
    ;;
  *.zip)
    [[ -f "$METADATA_PATH" ]] || fail "Metadata archive is not a file: $METADATA_PATH"
    python3 - "$METADATA_PATH" "$work_dir" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
    metadata_json="$(find_metadata_json "$work_dir")"
    ;;
  *)
    if [[ -d "$METADATA_PATH" ]]; then
      metadata_json="$(find_metadata_json "$METADATA_PATH")"
    else
      fail "Unsupported metadata format: $METADATA_PATH"
    fi
    ;;
esac

[[ -n "$metadata_json" ]] || fail "metadata.json not found in $METADATA_PATH"

log "Applying Hasura metadata from $metadata_json"
HASURA_METADATA_URL="https://${HASURA_FQDN}/v1/metadata" \
HASURA_GRAPHQL_URL="https://${HASURA_FQDN}/v1/graphql" \
HASURA_ADMIN_SECRET="$HASURA_ADMIN_SECRET" \
METADATA_JSON="$metadata_json" \
VERIFY="$VERIFY" \
python3 <<'PY'
import json
import os
import urllib.error
import urllib.request

metadata_url = os.environ["HASURA_METADATA_URL"]
graphql_url = os.environ["HASURA_GRAPHQL_URL"]
admin_secret = os.environ["HASURA_ADMIN_SECRET"]
metadata_json = os.environ["METADATA_JSON"]
verify = os.environ.get("VERIFY") == "1"


def request_json(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-hasura-admin-secret": admin_secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read().decode("utf-8")
            return json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Hasura HTTP {error.code}: {details}") from error


with open(metadata_json, "r", encoding="utf-8") as handle:
    body = json.load(handle)

metadata = body.get("metadata", body) if isinstance(body, dict) else body
if not isinstance(metadata, dict):
    raise RuntimeError("metadata.json must contain a JSON object")

request_json(
    metadata_url,
    {
        "type": "replace_metadata",
        "args": {
            "metadata": metadata,
            "allow_inconsistent_metadata": True,
        },
    },
)
request_json(metadata_url, {"type": "reload_metadata", "args": {"reload_sources": True}})
inconsistent = request_json(metadata_url, {"type": "get_inconsistent_metadata", "args": {}})
items = []
if isinstance(inconsistent, dict):
    items = inconsistent.get("inconsistent_objects") or []

print(f"inconsistent_objects={len(items)}")
if items:
    print(json.dumps(items[:10], ensure_ascii=False))

if verify:
    result = request_json(
        graphql_url,
        {"query": "query VerifyOrdersView { orders_view_aggregate { aggregate { count } } }"},
    )
    if result.get("errors"):
        raise RuntimeError(json.dumps(result["errors"], ensure_ascii=False))

    count = (
        result.get("data", {})
        .get("orders_view_aggregate", {})
        .get("aggregate", {})
        .get("count")
    )
    print(f"orders_view_count={count}")
PY

log "Hasura metadata apply complete"

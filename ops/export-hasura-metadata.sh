#!/usr/bin/env bash
# export-hasura-metadata.sh — refresh ops/hasura/metadata.json from a live Hasura.
# Admin secret is read from the container env INSIDE the container; never printed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
OUT="$SCRIPT_DIR/hasura/metadata.json"
CONTAINER="${HASURA_CONTAINER:-erp_test-hasura-1}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "export-hasura-metadata: container not found: $CONTAINER" >&2; exit 1; }

raw="$(docker exec -i "$CONTAINER" sh -c \
  'curl -s -X POST http://localhost:8080/v1/metadata -H "Content-Type: application/json" -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" -d "{\"type\":\"export_metadata\",\"args\":{}}"')"

[ -n "$raw" ] || { echo "export-hasura-metadata: empty response" >&2; exit 1; }
echo "$raw" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert isinstance(d,dict) and d.get("version")==3 and "sources" in d, "not version-3 metadata: "+str(list(d.keys()) if isinstance(d,dict) else type(d))' \
  || { echo "export-hasura-metadata: response is not version-3 Hasura metadata (wrong secret / error body?)" >&2; exit 1; }

if [ "$DRY" -eq 1 ]; then
  echo "export-hasura-metadata: [dry-run] would write $(printf '%s' "$raw" | wc -c) bytes to $OUT"
  exit 0
fi
printf '%s' "$raw" | python3 -m json.tool > "$OUT"
echo "export-hasura-metadata: wrote $(wc -c < "$OUT") bytes to $OUT"

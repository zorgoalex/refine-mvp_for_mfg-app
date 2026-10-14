#!/usr/bin/env bash
# Access groups 0Б: Hasura permissions follow the user's effective permissions (rules: access-predicates.json).
#
# Usage:
#   access-predicates.sh status
#   access-predicates.sh apply  --step A|B --state-dir DIR [--dry-run]
#   access-predicates.sh revert --step B   --state-dir DIR [--allow-reopen]
#
# Step A is additive (tracks the effective-rights views, adds relationships and the erp_admin role); step B wraps every
# other role's permission in its predicate and drops revoked ones. Each step is one replace_metadata pinned to the
# resource_version that was read: if anyone changed metadata in between, Hasura answers 409 and nothing is applied.
# apply saves before/after snapshots (and, for B, the effective rights) in DIR; revert B restores the metadata after A
# only if nothing else changed it and no effective right was narrowed since B (else --allow-reopen is required).
#
# Connection: HASURA_GRAPHQL_ENDPOINT + HASURA_ADMIN_SECRET, or run inside the Hasura container
# (HASURA_GRAPHQL_ADMIN_SECRET, http://localhost:8080). The secret is never printed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

if [[ -n "${HASURA_GRAPHQL_ENDPOINT:-}" ]]; then
  BASE_URL="${HASURA_GRAPHQL_ENDPOINT%/v1/graphql}"
  BASE_URL="${BASE_URL%/graphql}"
  SECRET="${HASURA_ADMIN_SECRET:-}"
elif [[ -n "${HASURA_GRAPHQL_ADMIN_SECRET:-}" ]]; then
  BASE_URL="http://localhost:8080"
  SECRET="${HASURA_GRAPHQL_ADMIN_SECRET}"
else
  printf 'ERROR: set HASURA_GRAPHQL_ENDPOINT + HASURA_ADMIN_SECRET, or run inside the Hasura container\n' >&2
  exit 1
fi
[[ -n "${SECRET:-}" ]] || { printf 'ERROR: Hasura admin secret is required\n' >&2; exit 1; }

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] || { printf 'usage: %s status|apply|revert ...\n' "$0" >&2; exit 2; }
shift
case "$COMMAND" in
  status) set -- status --live "$@" ;;
  apply|revert) set -- "$COMMAND" "$@" ;;
  *) printf 'unknown command: %s\n' "$COMMAND" >&2; exit 2 ;;
esac

HASURA_BASE_URL="$BASE_URL" HASURA_ADMIN_SECRET="$SECRET" \
  exec python3 "$SCRIPT_DIR/access_predicates.py" "$1" --rules "$SCRIPT_DIR/access-predicates.json" "${@:2}"

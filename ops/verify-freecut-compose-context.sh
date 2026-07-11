#!/usr/bin/env bash
set -euo pipefail

expected="${1:?usage: verify-freecut-compose-context.sh EXPECTED_PATH < compose-config.json}"
command -v jq >/dev/null 2>&1 || { echo "verify-freecut-compose-context: jq is required" >&2; exit 1; }

actual="$(jq -er '.services.freecut.build.context | select(type == "string" and length > 0)' 2>/dev/null)" || {
  echo "verify-freecut-compose-context: services.freecut.build.context is missing" >&2
  exit 1
}
actual="$(readlink -f "$actual")"
expected="$(readlink -f "$expected")"
[ "$actual" = "$expected" ] || {
  echo "verify-freecut-compose-context: Freecut context '$actual' is not verified checkout '$expected'" >&2
  exit 1
}

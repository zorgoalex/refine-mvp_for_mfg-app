#!/usr/bin/env bash
# ensure-build-repos.sh — clone the freecut + svgdxf build-context repos next to
# repo_erp if missing. Idempotent. setup-vps.sh only auto-clones freecut; this
# closes the cad-service (repo_svgdxf) gap too.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "" ) ;;
  * ) echo "ensure-build-repos: unknown option '$1'" >&2; exit 2 ;;
esac

FREECUT_REPO_URL="${FREECUT_REPO_URL:-https://github.com/zorgoalex/freecut_api.git}"
SVGDXF_REPO_URL="${SVGDXF_REPO_URL:-https://github.com/zorgoalex/list_to_CNC_files}"

ensure() { # $1 dir-name  $2 url
  local dir="$ROOT/$1" url="$2"
  if [ -d "$dir/.git" ]; then echo "ensure-build-repos: $1 present"; return; fi
  if [ -e "$dir" ]; then echo "ensure-build-repos: $dir exists but is not a git checkout" >&2; exit 1; fi
  if [ "$DRY" -eq 1 ]; then echo "ensure-build-repos: [dry-run] would clone $url -> $1"; return; fi
  echo "ensure-build-repos: cloning $1"
  git clone "$url" "$dir"
}

ensure repo_freecut "$FREECUT_REPO_URL"
ensure repo_svgdxf  "$SVGDXF_REPO_URL"
[ "$DRY" -eq 1 ] && echo "ensure-build-repos: dry-run complete"

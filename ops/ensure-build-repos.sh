#!/usr/bin/env bash
# ensure-build-repos.sh — clone the freecut + svgdxf build-context repos next to
# repo_erp if missing. Idempotent. setup-vps.sh only auto-clones freecut; this
# closes the cad-service (repo_svgdxf) gap too.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# ENSURE_BUILD_REPOS_ROOT overrides the runtime root (used by tests).
ROOT="${ENSURE_BUILD_REPOS_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DRY=0
UPDATE=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --update) UPDATE=1; shift ;;
    --only) ONLY="${2:?ensure-build-repos: --only needs repo_freecut or repo_svgdxf}"; shift 2 ;;
    *) echo "ensure-build-repos: unknown option '$1'" >&2; exit 2 ;;
  esac
done
case "$ONLY" in ""|repo_freecut|repo_svgdxf) ;; *) echo "ensure-build-repos: unknown repo '$ONLY'" >&2; exit 2 ;; esac

FREECUT_REPO_URL="${FREECUT_REPO_URL:-https://github.com/zorgoalex/freecut_api.git}"
SVGDXF_REPO_URL="${SVGDXF_REPO_URL:-https://github.com/zorgoalex/list_to_CNC_files}"
FREECUT_REPO_BRANCH="${FREECUT_REPO_BRANCH:-main}"
SVGDXF_REPO_BRANCH="${SVGDXF_REPO_BRANCH:-main}"

update_checkout() { # $1 dir-name  $2 url  $3 branch
  local name="$1" url="$2" branch="$3" dir="$ROOT/$1" current remote_head actual_url
  actual_url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [ "$actual_url" = "$url" ] || {
    echo "ensure-build-repos: $name origin is '$actual_url', expected '$url'; refusing to update" >&2; exit 1;
  }
  [ -z "$(git -C "$dir" status --porcelain)" ] || {
    echo "ensure-build-repos: $name has local changes; refusing to update" >&2; exit 1;
  }
  current="$(git -C "$dir" branch --show-current)"
  [ "$current" = "$branch" ] || {
    echo "ensure-build-repos: $name is on '$current', expected '$branch'; refusing to update" >&2; exit 1;
  }
  if [ "$DRY" -eq 1 ]; then
    echo "ensure-build-repos: [dry-run] would fetch and fast-forward $name origin/$branch"
    return
  fi
  echo "ensure-build-repos: updating $name from origin/$branch"
  git -C "$dir" fetch origin "$branch"
  git -C "$dir" merge --ff-only "origin/$branch"
  remote_head="$(git -C "$dir" rev-parse "origin/$branch")"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$remote_head" ] || {
    echo "ensure-build-repos: $name HEAD does not match origin/$branch after update" >&2; exit 1;
  }
  echo "ensure-build-repos: $name verified at $remote_head"
}

ensure() { # $1 dir-name  $2 url  $3 branch
  local name="$1" dir="$ROOT/$1" url="$2" branch="$3"
  if [ -d "$dir/.git" ]; then
    if [ "$UPDATE" -eq 1 ]; then update_checkout "$name" "$url" "$branch";
    else echo "ensure-build-repos: $name present"; fi
    return
  fi
  if [ -e "$dir" ]; then echo "ensure-build-repos: $dir exists but is not a git checkout" >&2; exit 1; fi
  if [ "$DRY" -eq 1 ]; then echo "ensure-build-repos: [dry-run] would clone $url branch $branch -> $name"; return; fi
  echo "ensure-build-repos: cloning $name branch $branch"
  git clone --branch "$branch" --single-branch "$url" "$dir"
  echo "ensure-build-repos: $name verified at $(git -C "$dir" rev-parse HEAD)"
}

if [ -z "$ONLY" ] || [ "$ONLY" = repo_freecut ]; then ensure repo_freecut "$FREECUT_REPO_URL" "$FREECUT_REPO_BRANCH"; fi
if [ -z "$ONLY" ] || [ "$ONLY" = repo_svgdxf ]; then ensure repo_svgdxf "$SVGDXF_REPO_URL" "$SVGDXF_REPO_BRANCH"; fi
# Use an if, NOT `[ ] && echo`: the && form returns 1 when DRY=0, which under
# `set -e` makes this script exit non-zero and silently aborts callers (provision
# stops right after this step with no error). The if form returns 0.
if [ "$DRY" -eq 1 ]; then echo "ensure-build-repos: dry-run complete"; fi

#!/usr/bin/env bash
#
# prune-old-images.sh — remove old per-revision ERP source images.
#
# Every deploy builds a new immutable tag (erp-backend:<sha>, ~0.5 GB each) and
# nothing removed the old ones, so the host disk filled up. This script keeps a
# rollback window and removes the rest.
#
# Usage:
#   ops/prune-old-images.sh [--keep N] [--min-age-hours H] [--root DIR] [--dry-run]
#   ops/prune-old-images.sh --pin-running
#
# Only images of erp-backend, cad-service and erp-cnc-telegram-worker are
# considered; everything else on the daemon (base images, other projects,
# dangling images) is never touched. An image is KEPT when any of these holds:
#   - it is used by any container (running or stopped);
#   - it carries a `<repo>:pinned-<epoch>-<id>` tag younger than
#     ERP_IMAGE_PRUNE_PIN_DAYS (7). Deploy scripts run --pin-running before
#     replacing containers, so the pre-deploy image stays available for
#     rollback. Pins live in the Docker daemon itself (atomic `docker tag`),
#     so they hold regardless of which runtime root a later cleanup uses;
#   - it is among the N newest images of its repository (default 3);
#   - it is younger than H hours (default 24);
#   - one of its tags is referenced by a release file in DIR
#     (backend-release*.env, *release*.yml), e.g. the previous release;
#   - one of its tags is `local` (compose templates reference cad-service:local).
# Everything else is untagged with plain `docker rmi` (never -f), including
# expired pin tags.
#
# Concurrency: deploy scripts hold a shared flock on ERP_IMAGE_LOCK_FILE
# (default /tmp/erp-images.lock, one per host/daemon) from build until the new
# containers run. Cleanup takes it exclusively without waiting and is skipped
# while any deploy is in flight.
#
# Fail-closed: if the runtime root or a release file cannot be read, nothing is
# removed and the script exits non-zero.
#
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$SCRIPT_PATH/../.." && pwd)"
KEEP="${ERP_IMAGE_PRUNE_KEEP:-3}"
MIN_AGE_HOURS="${ERP_IMAGE_PRUNE_MIN_AGE_HOURS:-24}"
PIN_DAYS="${ERP_IMAGE_PRUNE_PIN_DAYS:-7}"
LOCK_FILE="${ERP_IMAGE_LOCK_FILE:-/tmp/erp-images.lock}"
DRY_RUN=0
PIN_RUNNING=0
REPOS=(erp-backend cad-service erp-cnc-telegram-worker)

log() { printf 'prune-old-images: %s\n' "$*"; }
die() { printf 'prune-old-images: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="${2:?}"; shift 2 ;;
    --min-age-hours) MIN_AGE_HOURS="${2:?}"; shift 2 ;;
    --root) ROOT="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --pin-running) PIN_RUNNING=1; shift ;;
    -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep must be a non-negative integer"
[[ "$MIN_AGE_HOURS" =~ ^[0-9]+$ ]] || die "--min-age-hours must be a non-negative integer"
[[ "$PIN_DAYS" =~ ^[0-9]+$ ]] || die "ERP_IMAGE_PRUNE_PIN_DAYS must be a non-negative integer"

now="$(date +%s)"
repo_re="$(IFS='|'; echo "${REPOS[*]}")"

if (( PIN_RUNNING )); then
  # Tag the image of every running ERP container as
  # <repo>:pinned-<now>-<image id>, so two images never share a pin tag.
  # Discovery is captured with checked substitutions: a Docker failure aborts
  # the pin (and so the deploy) instead of pinning nothing.
  containers="$(docker ps -q)" || die "cannot list running containers"
  running=""
  if [[ -n "$containers" ]]; then
    # shellcheck disable=SC2086
    running="$(docker inspect --format '{{.Config.Image}} {{.Image}}' $containers)" \
      || die "cannot inspect running containers"
  fi
  pinned=0
  while read -r config_image image_id; do
    [[ -n "$config_image" ]] || continue
    repo="${config_image%%:*}"
    [[ "$repo" =~ ^(${repo_re})$ ]] || continue
    short_id="${image_id#sha256:}"
    docker tag "$image_id" "$repo:pinned-$now-${short_id:0:12}" || die "cannot pin $image_id"
    pinned=$((pinned + 1))
  done <<<"$running"
  log "pinned $pinned running image(s) for ${PIN_DAYS}d"
  exit 0
fi

[[ -d "$ROOT" && -r "$ROOT" && -x "$ROOT" ]] || die "runtime root is not a readable directory: $ROOT"

exec 9>>"$LOCK_FILE"
if ! flock -n -x 9; then
  log "a deploy holds $LOCK_FILE; skipping cleanup"
  exit 0
fi

used_ids="$(docker ps -a -q | xargs -r docker inspect --format '{{.Image}}' | sort -u)"

# Tags referenced by release files. Only image refs are extracted; the files
# are never printed. grep exit 1 (no match) is fine, >1 (read error) aborts.
release_refs=""
while IFS= read -r -d '' file; do
  [[ -r "$file" ]] || die "cannot read release file $file; refusing to remove anything"
  rc=0
  refs="$(grep -ohE "(${repo_re}):[A-Za-z0-9._-]+" "$file")" || rc=$?
  (( rc <= 1 )) || die "cannot read release file $file; refusing to remove anything"
  release_refs+="$refs"$'\n'
done < <(find "$ROOT" -maxdepth 1 \( -name 'backend-release*.env' -o -name '*release*.yml' \) -print0)

min_age_cutoff=$(( now - MIN_AGE_HOURS * 3600 ))
pin_cutoff=$(( now - PIN_DAYS * 86400 ))
removed=0
for repo in "${REPOS[@]}"; do
  # All tags of the repo, newest image first: "<ref>\t<full id>\t<created epoch>".
  rows=""
  while IFS= read -r ref; do
    [[ -n "$ref" ]] || continue
    # A tag that vanished meanwhile is simply ignored.
    meta="$(docker image inspect --format '{{.Id}}|{{.Created}}' "$ref" 2>/dev/null)" || continue
    rows+="$ref"$'\t'"${meta%%|*}"$'\t'"$(date -d "${meta#*|}" +%s)"$'\n'
  done < <(docker images "$repo" --filter dangling=false --format '{{.Repository}}:{{.Tag}}')
  rows="$(sort -t$'\t' -k3,3nr <<<"$rows" | sed '/^$/d')"
  [[ -n "$rows" ]] || continue

  # Decide per image ID; the reason applies to every tag of that image.
  declare -A keep_reason=()
  rank=0
  while IFS=$'\t' read -r ref id created; do
    tag="${ref#*:}"
    if [[ -z "${keep_reason[$id]+x}" ]]; then
      rank=$((rank + 1))
      if grep -qxF "$id" <<<"$used_ids"; then keep_reason[$id]="used by a container"
      elif (( rank <= KEEP )); then keep_reason[$id]="newest $KEEP"
      elif (( created > min_age_cutoff )); then keep_reason[$id]="younger than ${MIN_AGE_HOURS}h"
      else keep_reason[$id]=""
      fi
    fi
    if [[ -z "${keep_reason[$id]}" ]]; then
      if [[ "$tag" =~ ^pinned-([0-9]+)-[A-Za-z0-9]+$ ]] && (( BASH_REMATCH[1] >= pin_cutoff )); then
        keep_reason[$id]="pinned before a deploy"
      elif grep -qxF "$ref" <<<"$release_refs"; then keep_reason[$id]="referenced by a release file"
      elif [[ "$tag" == local ]]; then keep_reason[$id]="local tag"
      fi
    fi
  done <<<"$rows"

  while IFS=$'\t' read -r ref id created; do
    if [[ -n "${keep_reason[$id]}" ]]; then
      log "keep   $ref (${keep_reason[$id]})"
    elif (( DRY_RUN )); then
      log "remove $ref (dry-run)"
    elif docker rmi "$ref" >/dev/null 2>&1; then
      log "remove $ref"
      removed=$((removed + 1))
    else
      log "skip   $ref (docker rmi refused)"
    fi
  done <<<"$rows"
  unset keep_reason
done

if (( DRY_RUN )); then log "dry-run: nothing removed"; else log "removed $removed tag(s)"; fi

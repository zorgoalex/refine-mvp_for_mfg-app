#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$SCRIPT_PROJECT_DIR"
ENV_FILE=""
COMPOSE_FILE=""
REPO_URL=""
BRANCH=""
BACKUP_ROOT="${RESET_BACKUP_ROOT:-$HOME/.erp-reset-backups}"
PRESERVE_ENV=1
PRESERVE_RESTORE=1
ALL_DOCKER=0
PRUNE_IMAGES=0
PRUNE_BUILDER=0
AUTO_YES=0
CONFIRM=""

usage() {
  cat <<'EOF'
reset-test-vps.sh

Destructively reset a dedicated ERP test VPS checkout and Docker state.

This script is intentionally separate from setup-vps.sh. It is for explicit,
manual test-server resets only. It can preserve the current .env and restore/
directory, remove the project checkout, clone the repo again, and clean Docker.

Usage:
  ops/reset-test-vps.sh --confirm COMPOSE_PROJECT_NAME [options]

Options:
  --project-dir PATH       Project checkout to destroy and recreate. Default: repo root.
  --env-file PATH          Env file to preserve/restore. Default: PROJECT_DIR/.env.
  --compose-file PATH      Compose file to stop before cleanup. Default: PROJECT_DIR/docker-compose.yml.
  --repo-url URL           Git repository URL. Default: current origin URL.
  --branch NAME            Branch to clone. Default: current branch.
  --backup-root PATH       Where temporary env/restore backups are stored.
  --no-preserve-env        Do not preserve .env.
  --no-preserve-restore    Do not preserve restore/.
  --all-docker             Remove every Docker container, volume, and pruned network on the VPS.
                           Without this flag cleanup is scoped to COMPOSE_PROJECT_NAME.
  --prune-images           Also prune Docker images globally. Use only on a dedicated test VPS.
  --prune-builder          Also prune Docker build cache globally.
  --yes                    Do not ask for interactive confirmation.
  --confirm NAME           Required. Must match COMPOSE_PROJECT_NAME from .env.

Examples:
  ops/reset-test-vps.sh --confirm erp_test --yes
  ops/reset-test-vps.sh --confirm erp_test --yes --all-docker --prune-images --prune-builder
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
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --no-preserve-env) PRESERVE_ENV=0; shift ;;
    --no-preserve-restore) PRESERVE_RESTORE=0; shift ;;
    --all-docker) ALL_DOCKER=1; shift ;;
    --prune-images) PRUNE_IMAGES=1; shift ;;
    --prune-builder) PRUNE_BUILDER=1; shift ;;
    -y|--yes) AUTO_YES=1; shift ;;
    --confirm) CONFIRM="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$PROJECT_DIR" = /* ]] || PROJECT_DIR="$(pwd)/$PROJECT_DIR"
PROJECT_DIR="$(cd "$(dirname "$PROJECT_DIR")" && pwd)/$(basename "$PROJECT_DIR")"
[[ -n "$ENV_FILE" ]] || ENV_FILE="$PROJECT_DIR/.env"
[[ -n "$COMPOSE_FILE" ]] || COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"
BACKUP_ROOT="$(mkdir -p "$BACKUP_ROOT" && cd "$BACKUP_ROOT" && pwd)"

case "$PROJECT_DIR" in
  /home/*/projects/*|/opt/*/*) ;;
  *) fail "Refusing to reset suspicious project path: $PROJECT_DIR" ;;
esac

[[ "$PROJECT_DIR" != "/" && "$PROJECT_DIR" != "/home" && "$PROJECT_DIR" != "/opt" ]] \
  || fail "Refusing to reset top-level directory: $PROJECT_DIR"

if [[ -z "$REPO_URL" && -d "$PROJECT_DIR/.git" ]]; then
  REPO_URL="$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
fi
[[ -n "$REPO_URL" ]] || fail "--repo-url is required when origin URL cannot be detected"

if [[ -z "$BRANCH" && -d "$PROJECT_DIR/.git" ]]; then
  BRANCH="$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true)"
fi
[[ -n "$BRANCH" ]] || fail "--branch is required when current branch cannot be detected"

COMPOSE_PROJECT_NAME=""
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
[[ -n "$COMPOSE_PROJECT_NAME" ]] || fail "COMPOSE_PROJECT_NAME is required in $ENV_FILE"
[[ "$CONFIRM" == "$COMPOSE_PROJECT_NAME" ]] \
  || fail "Pass --confirm $COMPOSE_PROJECT_NAME to confirm destructive reset"

if [[ "$AUTO_YES" == "0" ]]; then
  cat <<EOF
This will destructively reset the ERP test VPS checkout.

  project:         $PROJECT_DIR
  compose project: $COMPOSE_PROJECT_NAME
  repo:            $REPO_URL
  branch:          $BRANCH
  all Docker:      $ALL_DOCKER
  prune images:    $PRUNE_IMAGES
  prune builder:   $PRUNE_BUILDER

Continue? Type yes:
EOF
  read -r answer
  [[ "$answer" == "yes" ]] || fail "Cancelled"
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
  TARGET_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null 2>&1 || fail "sudo is required when not running as root"
  SUDO=(sudo)
  TARGET_USER="$(id -un)"
fi
TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || printf '%s' "$TARGET_USER")"

run_as_target() {
  if [[ "$(id -u)" -eq 0 && "$TARGET_USER" != "root" ]]; then
    sudo -u "$TARGET_USER" "$@"
  else
    "$@"
  fi
}

kill_matching() {
  local signal="$1"
  local pattern="$2"
  local pids pid
  pids="$(pgrep -f "$pattern" || true)"
  [[ -n "$pids" ]] || return 0

  for pid in $pids; do
    [[ "$pid" != "$$" && "$pid" != "${PPID:-}" ]] || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

backup_dir="$BACKUP_ROOT/$(basename "$PROJECT_DIR")_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$backup_dir"

if [[ "$PRESERVE_ENV" == "1" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
  log "Backing up .env"
  cp "$ENV_FILE" "$backup_dir/.env"
  chmod 600 "$backup_dir/.env"
fi

if [[ "$PRESERVE_RESTORE" == "1" && -d "$PROJECT_DIR/restore" ]]; then
  log "Backing up restore/"
  mkdir -p "$backup_dir/restore"
  cp -a "$PROJECT_DIR/restore/." "$backup_dir/restore/"
fi

log "Stopping project deploy/test processes"
kill_matching TERM "($PROJECT_DIR/ops/setup-vps.sh|$PROJECT_DIR/ops/run-vps-tests.sh|setup-vps.sh .*${COMPOSE_PROJECT_NAME}|run-vps-tests.sh .*${COMPOSE_PROJECT_NAME}|vitest run|playwright test|pg_restore)"
sleep 3
kill_matching KILL "($PROJECT_DIR/ops/setup-vps.sh|$PROJECT_DIR/ops/run-vps-tests.sh|setup-vps.sh .*${COMPOSE_PROJECT_NAME}|run-vps-tests.sh .*${COMPOSE_PROJECT_NAME}|vitest run|playwright test|pg_restore)"

if command -v docker >/dev/null 2>&1; then
  if [[ -f "$COMPOSE_FILE" ]]; then
    log "Stopping compose project $COMPOSE_PROJECT_NAME"
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down -v --remove-orphans --rmi local || true
  fi

  if [[ "$ALL_DOCKER" == "1" ]]; then
    log "Removing all Docker containers and volumes"
    docker ps -aq | xargs -r docker rm -f
    docker volume ls -q | xargs -r docker volume rm -f
    docker network prune -f
  else
    log "Removing Docker leftovers for $COMPOSE_PROJECT_NAME"
    docker ps -aq --filter "name=${COMPOSE_PROJECT_NAME}" | xargs -r docker rm -f
    matching_volumes="$(docker volume ls -q | grep -E "^${COMPOSE_PROJECT_NAME}(_|-)" || true)"
    if [[ -n "$matching_volumes" ]]; then
      printf '%s\n' "$matching_volumes" | xargs -r docker volume rm -f
    fi
    matching_networks="$(docker network ls --format '{{.Name}}' | grep -E "^${COMPOSE_PROJECT_NAME}(_|-)" || true)"
    if [[ -n "$matching_networks" ]]; then
      printf '%s\n' "$matching_networks" | xargs -r docker network rm 2>/dev/null || true
    fi
  fi

  if [[ "$PRUNE_IMAGES" == "1" ]]; then
    log "Pruning Docker images globally"
    docker image prune -af
  fi

  if [[ "$PRUNE_BUILDER" == "1" ]]; then
    log "Pruning Docker build cache globally"
    docker builder prune -af
  fi
fi

log "Removing project checkout"
"${SUDO[@]}" rm -rf "$PROJECT_DIR"
run_as_target mkdir -p "$(dirname "$PROJECT_DIR")"

log "Cloning fresh checkout"
run_as_target git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$PROJECT_DIR"

if [[ "$PRESERVE_ENV" == "1" ]]; then
  log "Restoring .env"
  cp "$backup_dir/.env" "$PROJECT_DIR/.env"
  chmod 600 "$PROJECT_DIR/.env"
fi

if [[ "$PRESERVE_RESTORE" == "1" && -d "$backup_dir/restore" ]]; then
  log "Restoring restore/"
  mkdir -p "$PROJECT_DIR/restore"
  cp -a "$backup_dir/restore/." "$PROJECT_DIR/restore/"
fi

if [[ "$TARGET_USER" != "root" ]]; then
  "${SUDO[@]}" chown -R "$TARGET_USER:$TARGET_GROUP" "$PROJECT_DIR"
fi

log "Reset complete"
cd "$PROJECT_DIR"
printf 'branch='
git branch --show-current
printf 'head='
git rev-parse --short HEAD
git status --short

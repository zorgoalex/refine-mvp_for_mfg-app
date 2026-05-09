#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
RUN_BACKEND=1
RUN_FRONTEND=1
RUN_E2E=1
NODE_IMAGE="${VPS_TEST_NODE_IMAGE:-node:22-bookworm-slim}"
PLAYWRIGHT_IMAGE="${VPS_TEST_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.56.1-noble}"

usage() {
  cat <<'EOF'
run-vps-tests.sh

Run the ERP test suite on a VPS using Docker:
backend Vitest, frontend/serverless Vitest, and Playwright e2e.

Usage:
  ops/run-vps-tests.sh [--project-dir PATH] [--env-file PATH]
                       [--skip-backend] [--skip-frontend] [--skip-e2e]

The script installs npm dependencies into Docker named volumes before running
tests, so it works on a freshly bootstrapped VPS without local npm/node.
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
    --skip-backend) RUN_BACKEND=0; shift ;;
    --skip-frontend) RUN_FRONTEND=0; shift ;;
    --skip-e2e) RUN_E2E=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ -d "$PROJECT_DIR" ]] || fail "Project directory not found: $PROJECT_DIR"
[[ -f "$PROJECT_DIR/package-lock.json" ]] || fail "Root package-lock.json not found"
[[ -f "$PROJECT_DIR/backend/package-lock.json" ]] || fail "Backend package-lock.json not found"
command -v docker >/dev/null 2>&1 || fail "docker is required"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-erp}"
ROOT_NODE_MODULES_VOLUME="${ROOT_NODE_MODULES_VOLUME:-${COMPOSE_PROJECT_NAME}_node_modules}"
BACKEND_NODE_MODULES_VOLUME="${BACKEND_NODE_MODULES_VOLUME:-${COMPOSE_PROJECT_NAME}_backend_node_modules}"

docker_run_root() {
  docker run --rm \
    -v "$PROJECT_DIR":/app \
    -v "$ROOT_NODE_MODULES_VOLUME":/app/node_modules \
    -w /app \
    "$NODE_IMAGE" \
    sh -lc "$1"
}

docker_run_backend() {
  docker run --rm \
    -v "$PROJECT_DIR/backend":/app \
    -v "$BACKEND_NODE_MODULES_VOLUME":/app/node_modules \
    -w /app \
    "$NODE_IMAGE" \
    sh -lc "$1"
}

docker_run_playwright() {
  docker run --rm \
    -v "$PROJECT_DIR":/app \
    -v "$ROOT_NODE_MODULES_VOLUME":/app/node_modules \
    -w /app \
    "$PLAYWRIGHT_IMAGE" \
    sh -lc "$1"
}

cleanup_test_artifact_ownership() {
  [[ "$(id -u)" -eq 0 ]] || return 0

  local owner=""
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    owner="$SUDO_USER"
  else
    owner="$(stat -c '%U' "$PROJECT_DIR" 2>/dev/null || true)"
  fi
  [[ -n "$owner" && "$owner" != "root" ]] || return 0

  for path in "$PROJECT_DIR/test-results" "$PROJECT_DIR/playwright-report"; do
    [[ -e "$path" ]] && chown -R "$owner:$owner" "$path" || true
  done
}

restore_tracked_test_artifacts() {
  command -v git >/dev/null 2>&1 || return 0
  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  git -c safe.directory="$PROJECT_DIR" -C "$PROJECT_DIR" restore -- test-results playwright-report 2>/dev/null || true
}

if [[ "$RUN_BACKEND" == "1" ]]; then
  log "Installing backend dependencies"
  docker_run_backend 'npm ci'

  log "Running backend tests"
  docker_run_backend 'npm test'
fi

if [[ "$RUN_FRONTEND" == "1" || "$RUN_E2E" == "1" ]]; then
  log "Installing root dependencies"
  docker_run_root 'npm ci'
fi

if [[ "$RUN_FRONTEND" == "1" ]]; then
  log "Running frontend/serverless Vitest suite"
  docker_run_root 'TESTS=$(find src api scripts -type f \( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" -o -name "*.spec.tsx" -o -name "*.test.js" -o -name "*.spec.js" \) | sort); npx vitest run $TESTS'
fi

if [[ "$RUN_E2E" == "1" ]]; then
  log "Running Playwright e2e suite"
  docker_run_playwright 'npx playwright test'
  restore_tracked_test_artifacts
  cleanup_test_artifact_ownership
fi

log "VPS test suite complete"

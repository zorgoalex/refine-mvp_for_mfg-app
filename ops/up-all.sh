#!/usr/bin/env bash
#
# up-all.sh — single entry point for the erp_test Docker complex.
#
# The stack uses docker-compose.vps.yml: traefik, postgres, hasura, backend,
# freecut (cut optimizer), and cad-service (SVG/DXF milling layouts).
#
# This wrapper hard-codes the compose file, project name, project directory and
# env file. It is intentionally self-locating: it cd's
# to the runtime root before running compose, so build contexts and traefik
# label interpolation always resolve from the correct directory.
#
# Usage:
#   ops/up-all.sh up                  Bring up / update the whole complex.
#   ops/up-all.sh rebuild <service>   Rebuild + restart one service only.
#   ops/up-all.sh ps                  Show container status.
#   ops/up-all.sh logs <service> [..] Tail logs for a service.
#   ops/up-all.sh config              Render merged config (dry validation).
#   ops/up-all.sh -- <raw args>       Escape hatch: pass raw args to compose.
#
# Refuses a bare `down` / `--remove-orphans`: those would stop ERP too.
#
set -euo pipefail

# --- Self-locate the runtime root --------------------------------------------
# This script lives at <root>/repo_erp/ops/up-all.sh, so the runtime root (the
# directory holding .env, data/, repo_erp/, repo_freecut/, repo_svgdxf/) is
# three levels up. Resolve symlinks so it works regardless of how it is called.
SCRIPT_PATH="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$SCRIPT_PATH/../.." && pwd)"

ENV_FILE="$ROOT/.env"
VPS_FILE="$ROOT/repo_erp/ops/templates/docker-compose.vps.yml"
TEST_OVERLAY="$ROOT/repo_erp/ops/templates/docker-compose.test.yml"

# Project name is fixed; the running stack already lives under erp_test.
PROJECT="${COMPOSE_PROJECT_NAME_OVERRIDE:-erp_test}"

err()  { printf 'up-all: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }
warn() { printf 'up-all: WARN: %s\n' "$*" >&2; }

load_compose_profiles() {
  local line raw
  line="$(grep -E '^[[:space:]]*COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  raw="${line#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  export COMPOSE_PROFILES="$raw"
}

verify_freecut_sha() {
  local expected="$1" dir="$ROOT/repo_freecut"
  [ -z "$(git -C "$dir" status --porcelain)" ] || die "repo_freecut changed during build"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$expected" ] || die "repo_freecut HEAD changed during build"
  echo "up-all: Freecut build source verified at $expected"
}

# --- Base compose invocation -------------------------------------------------
# Every operation funnels through here so the fixed flags can never be omitted.
compose() {
  ( cd "$ROOT" && docker compose \
      --project-directory "$ROOT" \
      -p "$PROJECT" \
      --env-file "$ENV_FILE" \
      -f "$VPS_FILE" \
      -f "$TEST_OVERLAY" \
      "$@" )
}

# --- Preflight (warn-only; erp_test is test data) ----------------------------
preflight() {
  [ -f "$ENV_FILE" ]    || die ".env not found at $ENV_FILE"
  [ -f "$VPS_FILE" ]    || die "base compose file not found at $VPS_FILE"
  [ -f "$TEST_OVERLAY" ] || die "test compose overlay not found at $TEST_OVERLAY"
  load_compose_profiles
  # Unfilled placeholders in .env render internet-facing services with empty
  # secrets / empty traefik hosts. Warn, do not block (test contour).
  if grep -q 'REPLACE_ME' "$ENV_FILE" 2>/dev/null; then
    warn ".env still contains REPLACE_ME placeholders"
  fi
}

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

# --- Dispatch ----------------------------------------------------------------
cmd="${1:-}"
[ -n "$cmd" ] || { usage; exit 2; }
shift || true

case "$cmd" in
  up)
    preflight
    compose up -d "$@"
    ;;

  rebuild)
    [ $# -ge 1 ] || die "rebuild needs a service name (e.g. backend, freecut, cad-service)"
    preflight
    has_freecut=0
    for service in "$@"; do [ "$service" = freecut ] && has_freecut=1; done
    if [ "$has_freecut" -eq 1 ]; then
      exec 9>"$ROOT/.freecut-deploy.lock"
      flock 9
      bash "$SCRIPT_PATH/ensure-build-repos.sh" --update --only repo_freecut
      freecut_sha="$(git -C "$ROOT/repo_freecut" rev-parse HEAD)"
      compose build "$@"
      verify_freecut_sha "$freecut_sha"
      compose up -d --no-build --no-deps "$@"
      flock -u 9
    else
      compose up -d --build --no-deps "$@"
    fi
    ;;

  ps)
    compose ps "$@"
    ;;

  logs)
    [ $# -ge 1 ] || die "logs needs a service name"
    compose logs "$@"
    ;;

  config)
    preflight
    compose config "$@"
    ;;

  down|stop)
    die "refusing '$cmd' on the stack — it would stop ERP. Use 'up-all.sh -- <args>' deliberately."
    ;;

  --)
    # Escape hatch for one-off compose subcommands not wrapped above. Still goes
    # through the fixed flag set. Use deliberately.
    preflight
    compose "$@"
    ;;

  -h|--help|help)
    usage
    ;;

  provision)
    DRY=0; YES=0; DO_CHECK=1; DO_SMOKE=1; MIGRATE=skip; HASURA=bundled
    while [ $# -gt 0 ]; do
      case "$1" in
        --dry-run) DRY=1; shift ;;
        --yes|-y) YES=1; shift ;;
        --skip-check) DO_CHECK=0; shift ;;
        --skip-smoke) DO_SMOKE=0; shift ;;
        --migrate) MIGRATE="${2:?}"; shift 2 ;;
        --hasura) HASURA="${2:?}"; shift 2 ;;
        *) die "unknown provision flag '$1'" ;;
      esac
    done
    case "$MIGRATE" in apply|baseline|auto|skip) ;; *) die "invalid --migrate '$MIGRATE' (apply|baseline|auto|skip)" ;; esac
    case "$HASURA" in bundled|track|skip|apply:*) ;; *) die "invalid --hasura '$HASURA' (bundled|track|apply:PATH|skip)" ;; esac
    echo "provision plan (project $PROJECT, root $ROOT):"
    echo "  1. update-build-repos (freecut + svgdxf; verified fast-forward)"
    echo "  2. check-env$([ $DO_CHECK -eq 0 ] && echo ' (skipped)')"
    echo "  3. compose up -d --build (whole complex; builds source images)"
    echo "  4. migrate: $MIGRATE (apply-migrations.sh)"
    echo "  5. hasura: $HASURA"
    echo "  6. smoke$([ $DO_SMOKE -eq 0 ] && echo ' (skipped)')"
    if [ $DRY -eq 1 ]; then echo; echo "(dry-run: nothing executed)"; exit 0; fi
    if [ $YES -ne 1 ]; then read -r -p "Proceed? [y/N] " a; [ "$a" = "y" ] || die "aborted"; fi

    exec 9>"$ROOT/.freecut-deploy.lock"
    flock 9
    bash "$SCRIPT_PATH/ensure-build-repos.sh" --update
    freecut_sha="$(git -C "$ROOT/repo_freecut" rev-parse HEAD)"
    if [ $DO_CHECK -eq 1 ]; then bash "$SCRIPT_PATH/check-env.sh" --env-file "$ENV_FILE" --compose-file "$VPS_FILE"; fi
    preflight
    # --build: first-time bring-up must BUILD the source images (backend, freecut,
    # cad-service). cad-service has an explicit `image: cad-service:local`, so a
    # plain `up` would try to PULL that tag (registry has no cad-service:local →
    # "pull access denied") instead of building it.
    compose build
    verify_freecut_sha "$freecut_sha"
    compose up -d --no-build
    flock -u 9

    case "$MIGRATE" in
      apply|baseline|auto) bash "$SCRIPT_PATH/apply-migrations.sh" "$MIGRATE" --yes ;;
      skip) echo "provision: migrations NOT applied. Review + run:"; \
            bash "$SCRIPT_PATH/apply-migrations.sh" dry-run || true; \
            echo "  -> repo_erp/ops/apply-migrations.sh apply --yes   (fresh DB)"; \
            echo "  -> repo_erp/ops/apply-migrations.sh auto --yes    (restored prod dump, any level)"; \
            echo "  -> repo_erp/ops/apply-migrations.sh baseline --yes (restored DB already at repo level)" ;;
      *) die "invalid --migrate '$MIGRATE' (apply|baseline|auto|skip)" ;;
    esac

    case "$HASURA" in
      bundled) bash "$SCRIPT_PATH/apply-hasura-metadata.sh" --metadata "$ROOT/repo_erp/ops/hasura/metadata.json" --env-file "$ENV_FILE" ;;
      track) bash "$SCRIPT_PATH/track-hasura-public-schema.sh" --project-dir "$ROOT" --env-file "$ENV_FILE" --compose-file "$VPS_FILE" ;;
      apply:*) bash "$SCRIPT_PATH/apply-hasura-metadata.sh" --metadata "${HASURA#apply:}" --env-file "$ENV_FILE" ;;
      skip) echo "provision: Hasura metadata NOT applied. Run one of:"; \
            echo "  -> repo_erp/ops/apply-hasura-metadata.sh --metadata repo_erp/ops/hasura/metadata.json"; \
            echo "  -> repo_erp/ops/track-hasura-public-schema.sh --project-dir $ROOT --env-file $ENV_FILE" ;;
      *) die "invalid --hasura '$HASURA' (bundled|track|apply:PATH|skip)" ;;
    esac

    if [ $DO_SMOKE -eq 1 ]; then bash "$SCRIPT_PATH/smoke-vps.sh" --project-dir "$ROOT" --env-file "$ENV_FILE" --compose-file "$VPS_FILE"; fi
    echo "provision: done."
    ;;

  *)
    die "unknown command '$cmd' (try: up, rebuild, ps, logs, config, help)"
    ;;
esac

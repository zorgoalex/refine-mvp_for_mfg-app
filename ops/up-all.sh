#!/usr/bin/env bash
#
# up-all.sh — single entry point for the erp_test Docker complex.
#
# The stack is split across two compose files that MUST always be passed
# together for any operation on the erp_test project:
#
#   - docker-compose.vps.yml    base stack: traefik, postgres, hasura,
#                               backend, freecut (cut optimizer),
#                               cad-service (SVG/DXF milling layouts)
#   - docker-compose.twenty.yml CRM overlay: twenty, twenty_worker,
#                               twenty_db, twenty_redis
#
# Forgetting the second -f marks the Twenty services as orphans, and a later
# `--remove-orphans` would delete the running CRM. This wrapper hard-codes both
# -f files plus the project name, project directory and env file so none of
# those can be left out by accident. It is intentionally self-locating: it cd's
# to the runtime root before running compose, so build contexts and traefik
# label interpolation always resolve from the correct directory.
#
# Usage:
#   ops/up-all.sh up                  Bring up / update the whole complex.
#   ops/up-all.sh rebuild <service>   Rebuild + restart one service only.
#   ops/up-all.sh ps                  Show container status.
#   ops/up-all.sh logs <service> [..] Tail logs for a service.
#   ops/up-all.sh config              Render merged config (dry validation).
#   ops/up-all.sh down-crm            Service-scoped teardown of Twenty ONLY.
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
TWENTY_FILE="$ROOT/repo_erp/ops/templates/docker-compose.twenty.yml"

# Project name is fixed; the running stack already lives under erp_test.
PROJECT="${COMPOSE_PROJECT_NAME_OVERRIDE:-erp_test}"

# Twenty service names, used by the safe service-scoped teardown.
TWENTY_SERVICES=(twenty twenty_worker twenty_db twenty_redis)

err()  { printf 'up-all: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }
warn() { printf 'up-all: WARN: %s\n' "$*" >&2; }

# --- Base compose invocation -------------------------------------------------
# Every operation funnels through here so the fixed flags can never be omitted.
compose() {
  ( cd "$ROOT" && docker compose \
      --project-directory "$ROOT" \
      -p "$PROJECT" \
      --env-file "$ENV_FILE" \
      -f "$VPS_FILE" \
      -f "$TWENTY_FILE" \
      "$@" )
}

# --- Preflight (warn-only; erp_test is test data) ----------------------------
preflight() {
  [ -f "$ENV_FILE" ]    || die ".env not found at $ENV_FILE"
  [ -f "$VPS_FILE" ]    || die "base compose file not found at $VPS_FILE"
  [ -f "$TWENTY_FILE" ] || die "twenty overlay not found at $TWENTY_FILE"

  # Twenty image runs as uid 1000; the bind-mounted upload dir must exist and be
  # owned by 1000 or local-storage writes fail.
  local storage="$ROOT/data/twenty/server-storage"
  if [ ! -d "$storage" ]; then
    warn "missing $storage — Twenty uploads will fail (mkdir + chown 1000:1000)"
  elif [ "$(stat -c %u "$storage" 2>/dev/null || echo -1)" != "1000" ]; then
    warn "$storage not owned by uid 1000 — Twenty local-storage writes may fail"
  fi

  # Unfilled placeholders in .env render internet-facing services with empty
  # secrets / empty traefik hosts. Warn, do not block (test contour).
  if grep -q 'REPLACE_ME' "$ENV_FILE" 2>/dev/null; then
    warn ".env still contains REPLACE_ME placeholders"
  fi
}

twenty_preflight() {
  local storage="$ROOT/data/twenty/server-storage"
  mkdir -p "$storage"
  if [ "$(stat -c %u "$storage" 2>/dev/null || echo -1)" != "1000" ]; then
    if [ "$(id -u)" -eq 0 ]; then chown -R 1000:1000 "$storage"
    else warn "$storage not owned by uid 1000 and not root — run: sudo chown -R 1000:1000 $storage"; fi
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
    compose up -d --build --no-deps "$@"
    ;;

  ps)
    compose ps "$@"
    ;;

  logs)
    [ $# -ge 1 ] || die "logs needs a service name"
    compose logs "$@"
    ;;

  config)
    compose config "$@"
    ;;

  down-crm)
    # The ONLY teardown this wrapper performs: Twenty services only, leaving
    # the ERP base stack running.
    compose rm -sf "${TWENTY_SERVICES[@]}"
    ;;

  down|stop)
    die "refusing '$cmd' on the merged stack — it would stop ERP too. Use 'down-crm' for Twenty, or 'up-all.sh -- <args>' deliberately."
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
    case "$MIGRATE" in apply|baseline|skip) ;; *) die "invalid --migrate '$MIGRATE' (apply|baseline|skip)" ;; esac
    case "$HASURA" in bundled|track|skip|apply:*) ;; *) die "invalid --hasura '$HASURA' (bundled|track|apply:PATH|skip)" ;; esac
    echo "provision plan (project $PROJECT, root $ROOT):"
    echo "  1. ensure-build-repos (freecut + svgdxf)"
    echo "  2. check-env$([ $DO_CHECK -eq 0 ] && echo ' (skipped)')"
    echo "  3. twenty preflight (data/twenty/server-storage, uid 1000)"
    echo "  4. compose up -d (whole complex)"
    echo "  5. migrate: $MIGRATE (apply-migrations.sh)"
    echo "  6. hasura: $HASURA"
    echo "  7. smoke$([ $DO_SMOKE -eq 0 ] && echo ' (skipped)')"
    if [ $DRY -eq 1 ]; then echo; echo "(dry-run: nothing executed)"; exit 0; fi
    if [ $YES -ne 1 ]; then read -r -p "Proceed? [y/N] " a; [ "$a" = "y" ] || die "aborted"; fi

    bash "$SCRIPT_PATH/ensure-build-repos.sh"
    if [ $DO_CHECK -eq 1 ]; then bash "$SCRIPT_PATH/check-env.sh" --env-file "$ENV_FILE" --compose-file "$VPS_FILE"; fi
    twenty_preflight
    preflight
    compose up -d

    case "$MIGRATE" in
      apply|baseline) bash "$SCRIPT_PATH/apply-migrations.sh" "$MIGRATE" --yes ;;
      skip) echo "provision: migrations NOT applied. Review + run:"; \
            bash "$SCRIPT_PATH/apply-migrations.sh" dry-run || true; \
            echo "  -> repo_erp/ops/apply-migrations.sh apply --yes   (fresh DB)"; \
            echo "  -> repo_erp/ops/apply-migrations.sh baseline --yes (restored DB)" ;;
      *) die "invalid --migrate '$MIGRATE' (apply|baseline|skip)" ;;
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
    die "unknown command '$cmd' (try: up, rebuild, ps, logs, config, down-crm, help)"
    ;;
esac

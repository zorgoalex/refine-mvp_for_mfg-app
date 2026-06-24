#!/usr/bin/env bash
#
# apply-migrations.sh — ordered, ledgered runner for backend/db/migrations/*.sql.
#
# The backend has NO built-in migration runner: schema lands either from a DB
# dump restore or by applying the numbered SQL files in order. This script does
# the latter safely, tracking applied files in a `schema_migrations` ledger so
# re-runs are idempotent.
#
# It talks to Postgres via `docker exec` into the stack's postgres container and
# resolves the user/db from the container's own env (POSTGRES_USER/POSTGRES_DB),
# so no DB password is ever read into the host shell.
#
# Modes:
#   dry-run   (default) List which migrations WOULD apply. Read-only, no writes.
#   status            Show applied vs pending (+ checksum drift). Read-only.
#   apply             Apply pending migrations in order, recording each in the
#                     ledger. Requires confirmation (or --yes).
#   baseline          Record ALL current migration files as applied WITHOUT
#                     running them. For an existing DB (e.g. erp_test) that was
#                     migrated before this ledger existed — adopt the ledger so
#                     `apply` does not try to re-run history. Run this ONCE.
#
# Selection: backend/db/migrations/[0-9]*.sql, sorted by version, EXCLUDING the
# manual Variant-B side files *_preflight.sql / *_verify.sql / *_rollback.sql and
# the *.test.ts files. Those are applied by their own plan, not this runner.
#
# Usage:
#   ops/apply-migrations.sh [dry-run|status|apply|baseline] [options]
# Options:
#   --container NAME   Postgres container (default: erp_test-postgresdb-1 or $PG_CONTAINER)
#   --user NAME        Override DB user (default: container $POSTGRES_USER)
#   --db NAME          Override DB name (default: container $POSTGRES_DB)
#   --dir PATH         Migrations dir (default: <repo_erp>/backend/db/migrations)
#   --yes              Skip the apply confirmation prompt.
#
# Examples:
#   ops/apply-migrations.sh                 # dry-run: what is pending?
#   ops/apply-migrations.sh baseline --yes  # adopt ledger on an already-migrated DB
#   ops/apply-migrations.sh apply --yes     # apply pending on a fresh DB
#
set -euo pipefail

# --- Locate paths ------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ERP="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_DIR_DEFAULT="$REPO_ERP/backend/db/migrations"

# --- Defaults / args ---------------------------------------------------------
MODE="dry-run"
CONTAINER="${PG_CONTAINER:-erp_test-postgresdb-1}"
USER_OVERRIDE=""
DB_OVERRIDE=""
MIG_DIR="$MIG_DIR_DEFAULT"
ASSUME_YES=0

err() { printf 'apply-migrations: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

case "${1:-}" in
  dry-run|status|apply|baseline) MODE="$1"; shift ;;
  -h|--help|help) sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "" ) ;;                                   # no arg → default dry-run
  -* ) ;;                                   # first token is an option → default mode
  * ) die "unknown mode '${1}' (use dry-run|status|apply|baseline)";;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:?}"; shift 2 ;;
    --user)      USER_OVERRIDE="${2:?}"; shift 2 ;;
    --db)        DB_OVERRIDE="${2:?}"; shift 2 ;;
    --dir)       MIG_DIR="${2:?}"; shift 2 ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    *) die "unknown option '$1'" ;;
  esac
done

[ -d "$MIG_DIR" ] || die "migrations dir not found: $MIG_DIR"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "postgres container not found: $CONTAINER (set --container or \$PG_CONTAINER)"

# --- psql helpers (user/db resolved INSIDE the container) --------------------
# Override vars are passed into the exec env; the inner shell prefers them, else
# falls back to the container's own POSTGRES_USER/POSTGRES_DB.
_exec() { docker exec -i -e MIG_USER="$USER_OVERRIDE" -e MIG_DB="$DB_OVERRIDE" "$CONTAINER" "$@"; }

# Run a single SQL string, return rows unaligned/tuples-only.
pg_query() {
  _exec sh -c 'psql -U "${MIG_USER:-$POSTGRES_USER}" -d "${MIG_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1 -qtA -c "$1"' _ "$1"
}
# Pipe a .sql file on stdin.
pg_apply_file() {
  _exec sh -c 'psql -U "${MIG_USER:-$POSTGRES_USER}" -d "${MIG_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1' < "$1"
}

ensure_ledger() {
  pg_query "CREATE TABLE IF NOT EXISTS schema_migrations (
             filename text PRIMARY KEY,
             checksum text NOT NULL,
             applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null
}
ledger_exists() {
  [ "$(pg_query "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")" = "t" ]
}

# --- Build the ordered migration list ----------------------------------------
mapfile -t FILES < <(
  cd "$MIG_DIR" && ls -1 [0-9]*.sql 2>/dev/null \
    | grep -vE '_(preflight|verify|rollback)\.sql$' \
    | sort -V
)
[ "${#FILES[@]}" -gt 0 ] || die "no migration .sql files in $MIG_DIR"

checksum_of() { sha256sum "$MIG_DIR/$1" | awk '{print $1}'; }

# Applied set (filename<TAB>checksum), empty if no ledger.
declare -A APPLIED_SUM=()
if ledger_exists; then
  while IFS=$'\t' read -r fn sum; do
    [ -n "$fn" ] && APPLIED_SUM["$fn"]="$sum"
  done < <(pg_query "SELECT filename, checksum FROM schema_migrations;")
fi

print_plan() {
  local pending=0 applied=0 drift=0
  printf '%-58s %s\n' "MIGRATION" "STATE"
  printf '%-58s %s\n' "---------" "-----"
  for f in "${FILES[@]}"; do
    local cur; cur="$(checksum_of "$f")"
    if [ -n "${APPLIED_SUM[$f]+x}" ]; then
      if [ "${APPLIED_SUM[$f]}" = "$cur" ]; then
        printf '%-58s applied\n' "$f"; applied=$((applied+1))
      else
        printf '%-58s applied (⚠ CHECKSUM DRIFT — file changed after apply)\n' "$f"
        applied=$((applied+1)); drift=$((drift+1))
      fi
    else
      printf '%-58s PENDING\n' "$f"; pending=$((pending+1))
    fi
  done
  echo
  echo "Total: ${#FILES[@]}  applied: $applied  pending: $pending  drift: $drift"
  PENDING_COUNT="$pending"; DRIFT_COUNT="$drift"
}

# --- Dispatch ----------------------------------------------------------------
case "$MODE" in
  dry-run|status)
    if ! ledger_exists; then
      err "NOTE: schema_migrations ledger does not exist yet — every file shown as PENDING."
      err "If this DB was already migrated (e.g. erp_test), run: $0 baseline --yes"
    fi
    print_plan
    [ "$MODE" = "dry-run" ] && echo && echo "(dry-run: nothing applied)"
    exit 0
    ;;

  baseline)
    ensure_ledger
    echo "Baseline: recording ${#FILES[@]} migration files as applied WITHOUT running them."
    if [ "$ASSUME_YES" -ne 1 ]; then
      read -r -p "Proceed? [y/N] " a; [ "$a" = "y" ] || die "aborted"
    fi
    for f in "${FILES[@]}"; do
      pg_query "INSERT INTO schema_migrations(filename, checksum)
                VALUES ('$f', '$(checksum_of "$f")')
                ON CONFLICT (filename) DO NOTHING;" >/dev/null
    done
    echo "Baseline recorded. Pending is now empty (run '$0 status' to confirm)."
    ;;

  apply)
    ensure_ledger
    # Recompute applied set now the ledger surely exists.
    APPLIED_SUM=()
    while IFS=$'\t' read -r fn sum; do [ -n "$fn" ] && APPLIED_SUM["$fn"]="$sum"; done \
      < <(pg_query "SELECT filename, checksum FROM schema_migrations;")
    print_plan
    if [ "${PENDING_COUNT:-0}" -eq 0 ]; then echo; echo "Nothing to apply."; exit 0; fi
    echo
    err "About to apply ${PENDING_COUNT} pending migration(s) to db on container '$CONTAINER'."
    err "Review the PENDING list above. Destructive/structural migrations (e.g. the"
    err "034 Variant-B sunset) change/drop data — be sure this is intended."
    if [ "$ASSUME_YES" -ne 1 ]; then
      read -r -p "Apply now? [y/N] " a; [ "$a" = "y" ] || die "aborted"
    fi
    for f in "${FILES[@]}"; do
      [ -n "${APPLIED_SUM[$f]+x}" ] && continue
      echo ">> applying $f"
      if pg_apply_file "$MIG_DIR/$f"; then
        pg_query "INSERT INTO schema_migrations(filename, checksum)
                  VALUES ('$f', '$(checksum_of "$f")')
                  ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();" >/dev/null
        echo "   ok"
      else
        die "FAILED on $f — stopped. Fix and re-run; already-applied files are skipped."
      fi
    done
    echo "All pending migrations applied."
    ;;
esac

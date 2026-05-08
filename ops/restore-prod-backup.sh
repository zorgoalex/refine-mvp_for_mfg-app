#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
MAIN_DUMP=""
GLOBALS_DUMP=""
CONFIRM=""
SKIP_PRE_BACKUP=0
STOP_HASURA=1
START_HASURA=1
RESTORE_GLOBALS=0

usage() {
  cat <<'EOF'
restore-prod-backup.sh

Restore a PostgreSQL custom dump into the local postgresdb compose service.
This drops and recreates the target DB. Use only on a prepared target VPS.

Usage:
  ops/restore-prod-backup.sh --main-dump PATH --confirm-db DB_NAME [options]

Options:
  --globals-dump PATH      Optional globals SQL dump, plain .sql or .sql.gz
  --restore-globals        Restore globals before main dump
  --skip-pre-backup        Do not create a pre-restore dump of the current DB
  --no-stop-hasura         Keep Hasura running during restore
  --no-start-hasura        Do not start Hasura after restore
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
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --main-dump) MAIN_DUMP="$2"; shift 2 ;;
    --globals-dump) GLOBALS_DUMP="$2"; shift 2 ;;
    --restore-globals) RESTORE_GLOBALS=1; shift ;;
    --confirm-db) CONFIRM="$2"; shift 2 ;;
    --skip-pre-backup) SKIP_PRE_BACKUP=1; shift ;;
    --no-stop-hasura) STOP_HASURA=0; shift ;;
    --no-start-hasura) START_HASURA=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"
[[ -n "$MAIN_DUMP" ]] || fail "--main-dump is required"
[[ -f "$MAIN_DUMP" ]] || fail "Main dump not found: $MAIN_DUMP"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ -n "${PG_DB:-}" ]] || fail "PG_DB is required in .env"
[[ -n "${PG_USER:-}" ]] || fail "PG_USER is required in .env"
[[ -n "${PG_PASSWORD:-}" ]] || fail "PG_PASSWORD is required in .env"
[[ "$CONFIRM" == "$PG_DB" ]] || fail "Pass --confirm-db $PG_DB to confirm destructive restore"

if [[ "$RESTORE_GLOBALS" == "1" ]]; then
  [[ -n "$GLOBALS_DUMP" ]] || fail "--globals-dump is required with --restore-globals"
  [[ -f "$GLOBALS_DUMP" ]] || fail "Globals dump not found: $GLOBALS_DUMP"
fi

cd "$PROJECT_DIR"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
timestamp="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$PROJECT_DIR/backups/pre_restore"

db_exists() {
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    psql -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'" | grep -qx '1'
}

if [[ "$STOP_HASURA" == "1" ]]; then
  log "Stopping Hasura before restore"
  "${compose[@]}" stop hasura >/dev/null || true
fi

if [[ "$SKIP_PRE_BACKUP" == "0" ]] && db_exists; then
  pre_dump="$PROJECT_DIR/backups/pre_restore/pre_restore_${PG_DB}_${timestamp}.dump"
  log "Creating pre-restore dump: $pre_dump"
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$pre_dump"
fi

if [[ "$RESTORE_GLOBALS" == "1" ]]; then
  log "Restoring globals"
  if [[ "$GLOBALS_DUMP" == *.gz ]]; then
    gzip -dc "$GLOBALS_DUMP" | "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
      psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=0
  else
    "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
      psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=0 < "$GLOBALS_DUMP"
  fi
fi

log "Dropping and recreating database $PG_DB"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PG_DB}' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS \"${PG_DB}\";" \
  -c "CREATE DATABASE \"${PG_DB}\" OWNER \"${PG_USER}\";"

log "Restoring main dump"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --role "$PG_USER" < "$MAIN_DUMP"

log "Running basic DB check"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"

if [[ "$START_HASURA" == "1" ]]; then
  log "Starting Hasura"
  "${compose[@]}" up -d hasura
fi

log "Restore complete"

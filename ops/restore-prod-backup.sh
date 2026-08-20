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
STOP_WRITERS=1
START_WRITERS=1
RESTORE_GLOBALS=0
RESET_SEQUENCES=1
ENV_FILE_ARG_SET=0
COMPOSE_FILE_ARG_SET=0
RESTORE_STARTED=0
RESTORE_COMPLETED=0
pre_dump=""
pre_dump_candidate=""
globals_log=""
stopped_services=()

usage() {
  cat <<'EOF'
restore-prod-backup.sh

Restore a PostgreSQL custom dump into the local postgresdb compose service.
This drops and recreates the target DB. Use only on a prepared target VPS.

Usage:
  ops/restore-prod-backup.sh --main-dump PATH --confirm-db DB_NAME [options]

Options:
  --project-dir PATH       Runtime project directory for backups/pre_restore.
  --globals-dump PATH      Optional globals SQL dump, plain .sql or .sql.gz
  --restore-globals        Restore globals before main dump
  --skip-pre-backup        Do not create a pre-restore dump of the current DB
  --no-stop-hasura         Keep Hasura running during restore
  --no-start-hasura        Do not start Hasura after restore
  --no-stop-writers        Keep backend/CNC writer running during restore
  --no-start-writers       Do not restart backend/CNC writer after restore
  --no-reset-sequences     Skip the post-restore identity-sequence realignment
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
    --env-file) ENV_FILE="$2"; ENV_FILE_ARG_SET=1; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; COMPOSE_FILE_ARG_SET=1; shift 2 ;;
    --main-dump) MAIN_DUMP="$2"; shift 2 ;;
    --globals-dump) GLOBALS_DUMP="$2"; shift 2 ;;
    --restore-globals) RESTORE_GLOBALS=1; shift ;;
    --confirm-db) CONFIRM="$2"; shift 2 ;;
    --skip-pre-backup) SKIP_PRE_BACKUP=1; shift ;;
    --no-stop-hasura) STOP_HASURA=0; shift ;;
    --no-start-hasura) START_HASURA=0; shift ;;
    --no-stop-writers) STOP_WRITERS=0; shift ;;
    --no-start-writers) START_WRITERS=0; shift ;;
    --no-reset-sequences) RESET_SEQUENCES=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
[[ "$ENV_FILE_ARG_SET" == "0" ]] && ENV_FILE="$PROJECT_DIR/.env"
[[ "$COMPOSE_FILE_ARG_SET" == "0" ]] && COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"
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
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
writer_services=(backend cnc-telegram-worker)
configured_services=()
running_services=()

cleanup_and_report_failure() {
  local status=$?
  [[ -z "$globals_log" ]] || rm -f "$globals_log"
  if [[ -n "$pre_dump_candidate" && -z "$pre_dump" ]]; then
    rm -f "$pre_dump_candidate"
  fi

  if [[ "$RESTORE_STARTED" == "1" && "$RESTORE_COMPLETED" == "0" ]]; then
    printf '[%s] ERROR: Restore failed; database writers remain stopped\n' "$(date +'%F %T')" >&2
    if [[ -n "$pre_dump" ]]; then
      printf '[%s] Pre-restore backup: %s\n' "$(date +'%F %T')" "$pre_dump" >&2
      printf '[%s] Recovery command:' "$(date +'%F %T')" >&2
      printf ' %q' "$script_path" \
        --project-dir "$PROJECT_DIR" \
        --env-file "$ENV_FILE" \
        --compose-file "$COMPOSE_FILE" \
        --main-dump "$pre_dump" \
        --confirm-db "$PG_DB" \
        --skip-pre-backup \
        --no-reset-sequences >&2
      printf '\n' >&2
    else
      printf '[%s] No pre-restore backup is available; do not start writers until the DB is recovered\n' "$(date +'%F %T')" >&2
    fi
  fi

  exit "$status"
}
trap cleanup_and_report_failure EXIT

array_contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

configured_services_output="$("${compose[@]}" config --services)"
running_services_output="$("${compose[@]}" ps --services --status running)"
mapfile -t configured_services <<<"$configured_services_output"
mapfile -t running_services <<<"$running_services_output"

stop_if_running() {
  local service="$1"
  array_contains "$service" "${configured_services[@]}" || return 0
  array_contains "$service" "${running_services[@]}" || return 0
  log "Stopping $service before restore"
  "${compose[@]}" stop "$service" >/dev/null
  stopped_services+=("$service")
}

db_exists() {
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    psql -U "$PG_USER" -d postgres -tA --set=db_name="$PG_DB" <<'SQL' | grep -qx '1'
SELECT 1 FROM pg_database WHERE datname = :'db_name';
SQL
}

defer_cut_result_check() {
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA erp_restore_support;
CREATE TABLE erp_restore_support.deferred_check (
  table_schema text NOT NULL,
  table_name text NOT NULL,
  constraint_name text NOT NULL,
  constraint_definition text NOT NULL,
  was_validated boolean NOT NULL,
  constraint_comment text
);

INSERT INTO erp_restore_support.deferred_check
SELECT n.nspname,
       cls.relname,
       c.conname,
       pg_get_constraintdef(c.oid, true),
       c.convalidated,
       obj_description(c.oid, 'pg_constraint')
FROM pg_constraint c
JOIN pg_class cls ON cls.oid = c.conrelid
JOIN pg_namespace n ON n.oid = cls.relnamespace
WHERE c.conrelid = to_regclass('public.cut_result')
  AND c.conname = 'chk_cut_result_snapshot_shape'
  AND c.contype = 'c';

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM erp_restore_support.deferred_check LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',
                   r.table_schema, r.table_name, r.constraint_name);
  END LOOP;
END $$;
SQL
}

restore_cut_result_check() {
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  r record;
  definition_without_validation text;
BEGIN
  FOR r IN SELECT * FROM erp_restore_support.deferred_check LOOP
    definition_without_validation := regexp_replace(
      r.constraint_definition,
      '[[:space:]]+NOT VALID[[:space:]]*$',
      '',
      'i'
    );
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID',
                   r.table_schema, r.table_name, r.constraint_name,
                   definition_without_validation);
    IF r.was_validated THEN
      EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
                     r.table_schema, r.table_name, r.constraint_name);
    END IF;
    IF r.constraint_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON CONSTRAINT %I ON %I.%I IS %L',
                     r.constraint_name, r.table_schema, r.table_name,
                     r.constraint_comment);
    END IF;
  END LOOP;
END $$;
DROP SCHEMA erp_restore_support CASCADE;
SQL
}

restore_globals() {
  globals_log="$(mktemp "$PROJECT_DIR/backups/pre_restore/globals_restore.XXXXXX.log")"
  if [[ "$GLOBALS_DUMP" == *.gz ]]; then
    gzip -dc "$GLOBALS_DUMP" | "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
      psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=0 >"$globals_log" 2>&1
  else
    "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
      psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=0 < "$GLOBALS_DUMP" >"$globals_log" 2>&1
  fi

  local unexpected_errors
  unexpected_errors="$(grep -E '(^|: )(ERROR|FATAL):' "$globals_log" \
    | grep -Ev 'ERROR:[[:space:]]+role ".*" already exists$' || true)"
  if [[ -n "$unexpected_errors" ]]; then
    printf '%s\n' "$unexpected_errors" >&2
    fail "Unexpected error while restoring globals"
  fi
  rm -f "$globals_log"
  globals_log=""
}

RESTORE_STARTED=1

if [[ "$STOP_WRITERS" == "1" ]]; then
  for service in "${writer_services[@]}"; do
    stop_if_running "$service"
  done
fi
if [[ "$STOP_HASURA" == "1" ]]; then
  stop_if_running hasura
fi

if [[ "$SKIP_PRE_BACKUP" == "0" ]] && db_exists; then
  pre_dump_candidate="$PROJECT_DIR/backups/pre_restore/pre_restore_${PG_DB}_${timestamp}.dump"
  log "Creating pre-restore dump: $pre_dump_candidate"
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$pre_dump_candidate"
  pre_dump="$pre_dump_candidate"
fi

if [[ "$RESTORE_GLOBALS" == "1" ]]; then
  log "Restoring globals"
  restore_globals
fi

log "Dropping and recreating database $PG_DB"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  dropdb -U "$PG_USER" --force --if-exists "$PG_DB"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  createdb -U "$PG_USER" -O "$PG_USER" "$PG_DB"

log "Restoring main dump: pre-data"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --role "$PG_USER" \
    --exit-on-error --section=pre-data < "$MAIN_DUMP"

log "Deferring order-sensitive cut-result CHECK during COPY"
defer_cut_result_check

log "Restoring main dump: data"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --role "$PG_USER" \
    --exit-on-error --section=data < "$MAIN_DUMP"

log "Restoring main dump: post-data"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --role "$PG_USER" \
    --exit-on-error --section=post-data < "$MAIN_DUMP"

log "Restoring deferred cut-result CHECK"
restore_cut_result_check

log "Running basic DB check"
"${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"

if [[ "$RESET_SEQUENCES" == "1" ]]; then
  # A pg_restore'd dump leaves identity/serial sequences behind the column max,
  # so the first INSERT after restore collides on the PK (HTTP 500). Realign every
  # public sequence to MAX(col) so new inserts continue cleanly. Idempotent.
  log "Realigning identity sequences to column max (post-restore drift guard)"
  "${compose[@]}" exec -T -e PGPASSWORD="$PG_PASSWORD" postgresdb \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col,
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I.%I), 1))',
                   r.seq, r.col, r.sch, r.tbl);
  END LOOP;
END $$;
SQL
fi

services_to_restart=()
for service in "${stopped_services[@]}"; do
  if [[ "$service" == "hasura" && "$START_HASURA" == "1" ]]; then
    services_to_restart+=("$service")
  elif [[ "$service" != "hasura" && "$START_WRITERS" == "1" ]]; then
    services_to_restart+=("$service")
  fi
done

if [[ "${#services_to_restart[@]}" -gt 0 ]]; then
  log "Restarting services: ${services_to_restart[*]}"
  "${compose[@]}" up -d "${services_to_restart[@]}"
fi

RESTORE_COMPLETED=1
log "Restore complete"

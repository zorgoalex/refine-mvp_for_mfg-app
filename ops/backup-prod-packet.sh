#!/usr/bin/env bash
set -euo pipefail

# Create a restore-ready ERP backup packet from the Docker Compose runtime.
# The packet is intentionally more than pg_dump: it includes DB dumps, Hasura
# metadata, runtime manifests, schema probes, and checksums.

SCRIPT_VERSION="8.1"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
DEFAULT_PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROJECT_DIR="${PROJECT_DIR:-$DEFAULT_PROJECT_DIR}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
INITIAL_COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
COMPOSE_PROJECT_NAME=""
COMPOSE_PROJECT_NAME_SOURCE="auto"
CLI_COMPOSE_PROJECT_NAME=""
COMPOSE_PROFILE="${COMPOSE_PROFILE:-}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgresdb}"
HASURA_METADATA_SERVICE="${HASURA_METADATA_SERVICE:-hasura_metadata_db}"
HASURA_SERVICE="${HASURA_SERVICE:-hasura}"
BACKEND_SERVICE="${BACKEND_SERVICE:-backend}"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_DIR/backups/prod-packets}"
PACKET_NAME=""
DB_NAME="${PG_DB:-}"
DB_USER="${PG_USER:-}"
HASURA_MD_DB_NAME="${HASURA_MD_DB:-}"
HASURA_MD_USER="${HASURA_MD_USER:-}"
INCLUDE_GLOBALS="1"
INCLUDE_HASURA_MD_DB="1"
INCLUDE_HASURA_METADATA_JSON="1"
INCLUDE_CNC_MEDIA="0"
INCLUDE_CNC_WORKER_DATA="0"
UPLOAD_TO_CLOUD="${UPLOAD_TO_CLOUD:-0}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
RCLONE_BUCKET="${RCLONE_BUCKET:-}"
RCLONE_CONFIG="${RCLONE_CONFIG:-}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DRY_RUN="0"

usage() {
  cat <<EOF
backup-prod-packet.sh v${SCRIPT_VERSION}

Usage:
  ops/backup-prod-packet.sh [options]

Options:
  --project-dir PATH             Runtime project dir with .env/docker-compose.yml
  --env-file PATH                Env file path
  --compose-file PATH            Compose file path
  --compose-project-name NAME    Compose project name override
  --compose-profile NAME         Optional compose profile
  --backup-root PATH             Destination root for packets
  --packet-name NAME             Packet directory name
  --postgres-service NAME        Main Postgres service (default: postgresdb)
  --hasura-md-service NAME       Hasura metadata Postgres service
  --hasura-service NAME          Hasura service
  --backend-service NAME         Backend service
  --skip-globals                 Do not dump global roles/tablespaces
  --skip-hasura-md-db            Do not dump Hasura metadata DB
  --skip-hasura-metadata-json    Do not export Hasura metadata JSON
  --include-cnc-media            Archive cnc-telegram-media volume via backend
  --include-cnc-worker-data      Archive cnc-telegram-worker /data volume
  --upload                       Upload packet tarball via rclone
  --remote NAME                  Rclone remote (default: r2)
  --bucket NAME                  Rclone bucket/path
  --rclone-config PATH           rclone.conf path
  --retention-days N             Local packet retention (default: 30)
  --dry-run                      Print resolved Compose project and packet path
  --help                         Show help
EOF
}

log() {
  printf '[%s] %s\n' "$(date +'%F %T')" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$(date +'%F %T')" "$*" >&2
  exit 1
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Command not found: $1"
}

compose_base() {
  local args=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ -n "$COMPOSE_PROJECT_NAME" ]]; then
    args+=(-p "$COMPOSE_PROJECT_NAME")
  fi
  if [[ -n "$COMPOSE_PROFILE" ]]; then
    args+=(--profile "$COMPOSE_PROFILE")
  fi
  printf '%s\0' "${args[@]}"
}

compose_unscoped() {
  local args=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ -n "$COMPOSE_PROFILE" ]]; then
    args+=(--profile "$COMPOSE_PROFILE")
  fi
  (cd "$PROJECT_DIR" && "${args[@]}" "$@")
}

compose() {
  local base=()
  while IFS= read -r -d '' item; do
    base+=("$item")
  done < <(compose_base)
  (cd "$PROJECT_DIR" && "${base[@]}" "$@")
}

pg_exec_main() {
  compose exec -T "$POSTGRES_SERVICE" sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec "$@"' sh "$@"
}

pg_exec_hasura_md() {
  compose exec -T "$HASURA_METADATA_SERVICE" sh -c 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec "$@"' sh "$@"
}

container_id_for() {
  compose ps -q "$1" | head -n1
}

require_service_running() {
  local service="$1" cid
  cid="$(container_id_for "$service")"
  [[ -n "$cid" ]] || fail "Compose service is not running or not found: $service"
}

required_running_services() {
  printf '%s\n' "$POSTGRES_SERVICE"
  if [[ "$INCLUDE_HASURA_MD_DB" == "1" ]]; then
    printf '%s\n' "$HASURA_METADATA_SERVICE"
  fi
  if [[ "$INCLUDE_HASURA_METADATA_JSON" == "1" ]]; then
    printf '%s\n' "$HASURA_SERVICE"
  fi
  if [[ "$INCLUDE_CNC_MEDIA" == "1" ]]; then
    printf '%s\n' "$BACKEND_SERVICE"
  fi
}

detect_compose_project_name() {
  local candidates=() matches=() project svc missing

  while IFS= read -r project; do
    [[ -n "$project" ]] && candidates+=("$project")
  done < <(
    docker ps \
      --filter "label=com.docker.compose.service=$POSTGRES_SERVICE" \
      --format '{{.Label "com.docker.compose.project"}}' \
      | sort -u
  )

  for project in "${candidates[@]}"; do
    missing="0"
    while IFS= read -r svc; do
      [[ -n "$svc" ]] || continue
      if [[ -z "$(docker ps \
        --filter "label=com.docker.compose.project=$project" \
        --filter "label=com.docker.compose.service=$svc" \
        -q | head -n1)" ]]; then
        missing="1"
        break
      fi
    done < <(required_running_services)
    [[ "$missing" == "0" ]] && matches+=("$project")
  done

  if [[ "${#matches[@]}" -eq 1 ]]; then
    printf '%s\n' "${matches[0]}"
    return 0
  fi

  if [[ "${#matches[@]}" -gt 1 ]]; then
    printf 'Ambiguous Compose project candidates: %s. Set COMPOSE_PROJECT_NAME or pass --compose-project-name.\n' "${matches[*]}" >&2
    return 2
  fi

  return 1
}

resolve_compose_project_name() {
  local file_value="$1" detected config_name detect_status

  if [[ -n "$CLI_COMPOSE_PROJECT_NAME" ]]; then
    COMPOSE_PROJECT_NAME="$CLI_COMPOSE_PROJECT_NAME"
    COMPOSE_PROJECT_NAME_SOURCE="cli"
    return
  fi

  if [[ -n "$INITIAL_COMPOSE_PROJECT_NAME" ]]; then
    COMPOSE_PROJECT_NAME="$INITIAL_COMPOSE_PROJECT_NAME"
    COMPOSE_PROJECT_NAME_SOURCE="environment"
    return
  fi

  if [[ -n "$file_value" ]]; then
    COMPOSE_PROJECT_NAME="$file_value"
    COMPOSE_PROJECT_NAME_SOURCE="env-file"
    return
  fi

  if detected="$(detect_compose_project_name 2>&1)"; then
    COMPOSE_PROJECT_NAME="$detected"
    COMPOSE_PROJECT_NAME_SOURCE="docker-labels"
    return
  else
    detect_status="$?"
    if [[ "$detect_status" == "2" ]]; then
      fail "$detected"
    fi
  fi

  config_name="$(compose_unscoped config --name 2>/dev/null || true)"
  if [[ -n "$config_name" ]]; then
    COMPOSE_PROJECT_NAME="$config_name"
    COMPOSE_PROJECT_NAME_SOURCE="compose-config-name"
    return
  fi

  fail "Cannot resolve Compose project name. Set COMPOSE_PROJECT_NAME in .env or pass --compose-project-name."
}

run_main_query_to_file() {
  local sql="$1" out="$2"
  pg_exec_main psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
    -A -F $'\t' -P footer=off -c "$sql" > "$out"
}

write_env_flags_snapshot() {
  local out="$1"
  python3 - "$ENV_FILE" > "$out" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
allowed = re.compile(
    r'^(COMPOSE_PROFILES|BACKEND_ENABLE_|BACKEND_.*(READ_ONLY|DISABLED|OWNER|DRY_RUN|AUTO_TRIGGER|STATUS_AUTOMATION|SHEET_ORDERS_READS)|VITE_USE_BACKEND_|VITE_ENABLE_|CNC_BACKFILL_ON_START|CNC_TELEGRAM_ALLOW_NON_PROD_WRITER|CNC_TELEGRAM_WORKER_ROLE|NODE_ENV|BACKEND_NODE_ENV)$'
)
sensitive = re.compile(r'(SECRET|TOKEN|PASSWORD|KEY|HASH|PEPPER|DATABASE|URL|WEBHOOK|CHAT|API_ID|API_HASH|LOGIN)', re.I)
result = {}
if path.exists():
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        if line.startswith('export '):
            line = line[7:].strip()
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not allowed.match(key):
            continue
        if sensitive.search(key):
            result[key] = '<set>' if value else '<empty>'
        else:
            result[key] = value
json.dump(result, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
sys.stdout.write('\n')
PY
}

write_manifest() {
  local out="$1" packet="$2" started_at="$3"
  local repo_sha branch dirty compose_services docker_versions
  repo_sha="$(git -C "$SCRIPT_DIR/.." rev-parse HEAD 2>/dev/null || true)"
  branch="$(git -C "$SCRIPT_DIR/.." rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  dirty="$(git -C "$SCRIPT_DIR/.." status --short 2>/dev/null | wc -l | tr -d ' ')"
  compose_services="$(compose config --services 2>/dev/null | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()], ensure_ascii=False))' || printf '[]')"
  docker_versions="$(docker version --format '{{json .}}' 2>/dev/null || printf '{}')"

  python3 - "$out" <<PY
import json
from pathlib import Path

manifest = {
  "packet_version": "${SCRIPT_VERSION}",
  "created_at": "${started_at}",
  "packet_name": "${packet}",
  "project_dir": "${PROJECT_DIR}",
  "compose_file": "${COMPOSE_FILE}",
  "compose_project_name": "${COMPOSE_PROJECT_NAME}",
  "compose_project_name_source": "${COMPOSE_PROJECT_NAME_SOURCE}",
  "compose_profile": "${COMPOSE_PROFILE}",
  "services": {
    "postgres": "${POSTGRES_SERVICE}",
    "hasura_metadata_db": "${HASURA_METADATA_SERVICE}",
    "hasura": "${HASURA_SERVICE}",
    "backend": "${BACKEND_SERVICE}",
  },
  "database": {
    "name": "${DB_NAME}",
    "user": "${DB_USER}",
    "hasura_metadata_db": "${HASURA_MD_DB_NAME}",
    "hasura_metadata_user": "${HASURA_MD_USER}",
  },
  "repo": {
    "branch": "${branch}",
    "commit": "${repo_sha}",
    "dirty_file_count": int("${dirty}" or "0"),
  },
  "compose_services": ${compose_services},
  "docker_version": ${docker_versions},
  "included": {
    "globals": "${INCLUDE_GLOBALS}" == "1",
    "hasura_metadata_db": "${INCLUDE_HASURA_MD_DB}" == "1",
    "hasura_metadata_json": "${INCLUDE_HASURA_METADATA_JSON}" == "1",
    "cnc_media": "${INCLUDE_CNC_MEDIA}" == "1",
    "cnc_worker_data": "${INCLUDE_CNC_WORKER_DATA}" == "1",
  },
  "restore_notes": [
    "Restore main_db.dump first, then hasura_metadata_db.dump when included.",
    "Do not restore env_flags_redacted.json as secrets; it is only a feature flag snapshot.",
    "Run stage/prod retarget post-restore script before starting writers.",
    "Verify SHA256SUMS and Hasura metadata consistency after restore."
  ]
}
Path("${out}").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
PY
}

export_hasura_metadata_json() {
  local out="$1" cid
  cid="$(container_id_for "$HASURA_SERVICE")"
  [[ -n "$cid" ]] || fail "Hasura service is not running: $HASURA_SERVICE"
  docker exec -i "$cid" sh -c \
    'curl -fsS -X POST http://127.0.0.1:8080/v1/metadata -H "Content-Type: application/json" -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" -d "{\"type\":\"export_metadata\",\"args\":{}}"' \
    | python3 -m json.tool > "$out"
  python3 - "$out" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as fh:
    data = json.load(fh)
if not isinstance(data, dict) or data.get("version") != 3 or "sources" not in data:
    raise SystemExit("exported Hasura metadata is not version-3 metadata")
PY
}

archive_from_container() {
  local service="$1" path="$2" out="$3" cid
  cid="$(container_id_for "$service")"
  [[ -n "$cid" ]] || fail "Cannot archive from missing service: $service"
  docker exec "$cid" sh -lc "test -e '$path'"
  docker exec "$cid" tar -C "$(dirname "$path")" -czf - "$(basename "$path")" > "$out"
}

write_runtime_snapshot() {
  local out_dir="$1" svc cid name config_image image_id status started_at config_files

  compose config --services > "$out_dir/compose.services.txt"
  compose config --profiles > "$out_dir/compose.profiles.txt" 2>/dev/null || true
  compose config --images > "$out_dir/compose.images.txt" 2>/dev/null || true
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' > "$out_dir/docker-ps.txt"

  {
    printf 'service\tcontainer_id\tname\tconfig_image\timage_id\tstatus\tstarted_at\tcompose_config_files\n'
    for svc in "$POSTGRES_SERVICE" "$HASURA_METADATA_SERVICE" "$HASURA_SERVICE" "$BACKEND_SERVICE"; do
      cid="$(container_id_for "$svc" 2>/dev/null || true)"
      [[ -n "$cid" ]] || continue
      name="$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null || true)"
      config_image="$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
      image_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
      status="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || true)"
      started_at="$(docker inspect --format '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
      config_files="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid" 2>/dev/null || true)"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$svc" "$cid" "$name" "$config_image" "$image_id" "$status" "$started_at" "$config_files"
    done
  } > "$out_dir/docker-containers.tsv"
}

write_dump_toc() {
  local service="$1" dump_file="$2" toc_file="$3" remote="/tmp/erp_backup_packet_$$.dump" cid
  cid="$(container_id_for "$service")"
  [[ -n "$cid" ]] || fail "Cannot validate dump with missing service: $service"
  docker cp "$dump_file" "$cid:$remote"
  docker exec "$cid" pg_restore -l "$remote" > "$toc_file"
  docker exec "$cid" rm -f "$remote" >/dev/null 2>&1 || true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --compose-project-name) CLI_COMPOSE_PROJECT_NAME="$2"; shift 2 ;;
    --compose-profile) COMPOSE_PROFILE="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --packet-name) PACKET_NAME="$2"; shift 2 ;;
    --postgres-service) POSTGRES_SERVICE="$2"; shift 2 ;;
    --hasura-md-service) HASURA_METADATA_SERVICE="$2"; shift 2 ;;
    --hasura-service) HASURA_SERVICE="$2"; shift 2 ;;
    --backend-service) BACKEND_SERVICE="$2"; shift 2 ;;
    --skip-globals) INCLUDE_GLOBALS="0"; shift ;;
    --skip-hasura-md-db) INCLUDE_HASURA_MD_DB="0"; shift ;;
    --skip-hasura-metadata-json) INCLUDE_HASURA_METADATA_JSON="0"; shift ;;
    --include-cnc-media) INCLUDE_CNC_MEDIA="1"; shift ;;
    --include-cnc-worker-data) INCLUDE_CNC_WORKER_DATA="1"; shift ;;
    --upload) UPLOAD_TO_CLOUD="1"; shift ;;
    --remote) RCLONE_REMOTE="$2"; shift 2 ;;
    --bucket) RCLONE_BUCKET="$2"; shift 2 ;;
    --rclone-config) RCLONE_CONFIG="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$PROJECT_DIR" = /* ]] || PROJECT_DIR="$(pwd)/$PROJECT_DIR"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"

[[ -f "$ENV_FILE" ]] || fail "Env file not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $COMPOSE_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

FILE_COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
resolve_compose_project_name "$FILE_COMPOSE_PROJECT_NAME"
DB_NAME="${DB_NAME:-${PG_DB:-}}"
DB_USER="${DB_USER:-${PG_USER:-}}"
HASURA_MD_DB_NAME="${HASURA_MD_DB_NAME:-${HASURA_MD_DB:-}}"
HASURA_MD_USER="${HASURA_MD_USER:-}"

[[ -n "$DB_NAME" ]] || fail "PG_DB/DB_NAME is required"
[[ -n "$DB_USER" ]] || fail "PG_USER/DB_USER is required"
if [[ "$INCLUDE_HASURA_MD_DB" == "1" ]]; then
  [[ -n "$HASURA_MD_DB_NAME" ]] || fail "HASURA_MD_DB is required"
  [[ -n "$HASURA_MD_USER" ]] || fail "HASURA_MD_USER is required"
fi

need_cmd docker
need_cmd python3
need_cmd sha256sum
need_cmd tar

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PACKET_NAME="${PACKET_NAME:-erp-backup-packet-${DB_NAME}-${TIMESTAMP}}"
PACKET_DIR="$BACKUP_ROOT/$PACKET_NAME"

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'compose_project_name=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'compose_project_name_source=%s\n' "$COMPOSE_PROJECT_NAME_SOURCE"
  printf 'packet_dir=%s\n' "$PACKET_DIR"
  exit 0
fi

mkdir -p "$PACKET_DIR"
LOG_FILE="$PACKET_DIR/backup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

log "ERP backup packet v${SCRIPT_VERSION}"
log "Packet: $PACKET_DIR"
log "Project: $PROJECT_DIR"
log "Compose: $COMPOSE_FILE"
log "Compose project: $COMPOSE_PROJECT_NAME ($COMPOSE_PROJECT_NAME_SOURCE)"
log "DB: $DB_NAME"

require_service_running "$POSTGRES_SERVICE"
if [[ "$INCLUDE_HASURA_MD_DB" == "1" ]]; then
  require_service_running "$HASURA_METADATA_SERVICE"
fi
if [[ "$INCLUDE_HASURA_METADATA_JSON" == "1" ]]; then
  require_service_running "$HASURA_SERVICE"
fi

log "Checking PostgreSQL tools"
pg_exec_main sh -lc 'command -v pg_dump >/dev/null && command -v pg_dumpall >/dev/null && command -v pg_restore >/dev/null'
pg_exec_main psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null

log "Writing manifests"
write_manifest "$PACKET_DIR/manifest.json" "$PACKET_NAME" "$STARTED_AT"
write_env_flags_snapshot "$PACKET_DIR/env_flags_redacted.json"
write_runtime_snapshot "$PACKET_DIR"

log "Dumping main database"
pg_exec_main pg_dump -U "$DB_USER" -d "$DB_NAME" -F c -b -v > "$PACKET_DIR/main_db.dump"
[[ -s "$PACKET_DIR/main_db.dump" ]] || fail "main_db.dump is empty"
write_dump_toc "$POSTGRES_SERVICE" "$PACKET_DIR/main_db.dump" "$PACKET_DIR/main_db.toc" || fail "main_db.dump TOC check failed"

if [[ "$INCLUDE_GLOBALS" == "1" ]]; then
  log "Dumping globals without role passwords"
  pg_exec_main sh -lc "pg_dumpall -U \"\$1\" -g | sed -E \"s/[[:space:]]+PASSWORD[[:space:]]+'[^']*'//g\"" sh "$DB_USER" \
    | gzip -9 > "$PACKET_DIR/globals_no_passwords.sql.gz"
  [[ -s "$PACKET_DIR/globals_no_passwords.sql.gz" ]] || fail "globals dump is empty"
fi

if [[ "$INCLUDE_HASURA_MD_DB" == "1" ]]; then
  log "Dumping Hasura metadata DB"
  pg_exec_hasura_md pg_dump -U "$HASURA_MD_USER" -d "$HASURA_MD_DB_NAME" -F c -b -v > "$PACKET_DIR/hasura_metadata_db.dump"
  [[ -s "$PACKET_DIR/hasura_metadata_db.dump" ]] || fail "hasura_metadata_db.dump is empty"
  write_dump_toc "$HASURA_METADATA_SERVICE" "$PACKET_DIR/hasura_metadata_db.dump" "$PACKET_DIR/hasura_metadata_db.toc" || fail "hasura_metadata_db.dump TOC check failed"
fi

if [[ "$INCLUDE_HASURA_METADATA_JSON" == "1" ]]; then
  log "Exporting Hasura metadata JSON"
  export_hasura_metadata_json "$PACKET_DIR/hasura_metadata.json"
fi

log "Writing DB evidence"
run_main_query_to_file \
  "SELECT schemaname, relname, n_live_tup::bigint FROM pg_stat_user_tables ORDER BY schemaname, relname;" \
  "$PACKET_DIR/table_row_estimates.tsv"
run_main_query_to_file \
  "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename;" \
  "$PACKET_DIR/schema_migrations.tsv" || true
run_main_query_to_file \
  "SELECT conrelid::regclass AS relation, conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND convalidated = false ORDER BY conrelid::regclass::text, conname;" \
  "$PACKET_DIR/not_valid_constraints.tsv" || true
run_main_query_to_file \
  "SELECT extname, extversion FROM pg_extension ORDER BY extname;" \
  "$PACKET_DIR/extensions.tsv"
run_main_query_to_file \
  "SELECT status, count(*) FROM outbox_events GROUP BY status ORDER BY status;" \
  "$PACKET_DIR/outbox_status_counts.tsv" || true
run_main_query_to_file \
  "SELECT status, count(*) FROM crm_sync_outbox GROUP BY status ORDER BY status;" \
  "$PACKET_DIR/crm_sync_outbox_status_counts.tsv" || true
run_main_query_to_file \
  "SELECT status, count(*) FROM notification_channel_deliveries GROUP BY status ORDER BY status;" \
  "$PACKET_DIR/notification_delivery_status_counts.tsv" || true

if [[ "$INCLUDE_CNC_MEDIA" == "1" ]]; then
  log "Archiving CNC media from backend container"
  archive_from_container "$BACKEND_SERVICE" "/data/cnc-telegram-media" "$PACKET_DIR/cnc-telegram-media.tar.gz"
fi

if [[ "$INCLUDE_CNC_WORKER_DATA" == "1" ]]; then
  log "Archiving CNC worker data"
  archive_from_container "cnc-telegram-worker" "/data" "$PACKET_DIR/cnc-telegram-worker-data.tar.gz"
fi

log "Writing checksums"
(cd "$PACKET_DIR" && find . -type f ! -name SHA256SUMS ! -name 'backup.log' ! -name 'packet.tar.gz' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

log "Creating packet tarball"
tar -C "$BACKUP_ROOT" -czf "$PACKET_DIR.tar.gz" "$PACKET_NAME"
sha256sum "$PACKET_DIR.tar.gz" > "$PACKET_DIR.tar.gz.sha256"

if [[ "$UPLOAD_TO_CLOUD" == "1" ]]; then
  need_cmd rclone
  [[ -n "$RCLONE_BUCKET" ]] || fail "RCLONE_BUCKET is required for upload"
  rclone_args=()
  if [[ -n "$RCLONE_CONFIG" ]]; then
    rclone_args+=(--config "$RCLONE_CONFIG")
  fi
  log "Uploading packet tarball"
  rclone "${rclone_args[@]}" copy "$PACKET_DIR.tar.gz" "${RCLONE_REMOTE}:${RCLONE_BUCKET}/packets/" --retries 3 --retries-sleep 10s
  rclone "${rclone_args[@]}" copy "$PACKET_DIR.tar.gz.sha256" "${RCLONE_REMOTE}:${RCLONE_BUCKET}/packets/" --retries 3 --retries-sleep 10s
fi

log "Cleaning old local packets"
find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'erp-backup-packet-*' -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'erp-backup-packet-*.tar.gz*' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

log "Backup packet complete"
log "Packet dir: $PACKET_DIR"
log "Packet tar: $PACKET_DIR.tar.gz"

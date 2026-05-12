#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$SCRIPT_PROJECT_DIR"

default_project_dir() {
  if [[ "$(basename "$SCRIPT_PROJECT_DIR")" == "repo_erp" ]]; then
    dirname "$SCRIPT_PROJECT_DIR"
  else
    printf '%s\n' "$SCRIPT_PROJECT_DIR"
  fi
}

PROJECT_DIR="${ERP_PROJECT_DIR:-$(default_project_dir)}"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
RUN_DNS_CHECK=1
RUN_SMOKE=1
RUN_TESTS=1
FORCE_RECREATE=0
EXPECTED_IP=""
SKIP_BOOTSTRAP=0
SKIP_DEPLOY=0
AUTO_YES=0
PROJECT_DIR_ARG_SET=0
ENV_FILE_ARG_SET=0
COMPOSE_FILE_ARG_SET=0
RESTORE_BACKUP_PATH=""
REQUIRE_RESTORE_BACKUP=0
TRACK_HASURA_AFTER_RESTORE=1
HASURA_METADATA_PATH=""
HASURA_METADATA_APPLIED=0

preferred_project_dir() {
  local owner="${SUDO_USER:-${USER:-}}"
  if [[ -z "$owner" || "$owner" == "root" ]]; then
    owner="$(logname 2>/dev/null || true)"
  fi
  if [[ -z "$owner" || "$owner" == "root" ]]; then
    owner="user"
  fi

  printf '/home/%s/projects/erp_dev' "$owner"
}

PREFERRED_PROJECT_DIR="${ERP_PROJECT_DIR:-$(preferred_project_dir)}"

usage() {
  cat <<'EOF'
setup-vps.sh

One-command VPS setup for the ERP stack.

First run on a fresh VPS:
  cd /home/<user>/projects/erp_dev/repo_erp
  sudo ops/setup-vps.sh

What it does:
  1. Installs Docker and prepares folders/templates.
  2. Creates .env from ops/templates/env.vps.example if missing.
  3. Stops until real domains/secrets are filled in .env.
  4. On the next run, validates env and DNS.
  5. Deploys Traefik, Postgres, Hasura, and backend.
  6. Optionally restores a DB backup and Hasura metadata when provided.
  7. Runs HTTPS health checks and Hasura CORS preflight.

Options:
  --project-dir PATH       Runtime project directory. Default: parent erp_dev when repo is in repo_erp.
  --env-file PATH          Env file. Default: PROJECT_DIR/.env.
  --compose-file PATH      Compose file. Default: PROJECT_DIR/docker-compose.yml.
  --expected-ip IP         Expected public IP for DNS checks.
  --skip-dns              Do not check DNS A records before deploy.
  --skip-smoke            Do not run smoke checks after deploy.
  --skip-tests            Do not run backend/frontend/e2e tests after deploy.
  --skip-bootstrap        Do not run bootstrap-vps.sh.
  --skip-deploy           Stop after bootstrap/env validation.
  --force-recreate        Recreate containers during deploy.
  --restore-backup PATH   Optional DB backup file or directory to restore after deploy.
                          Directory mode picks the newest *.dump/*.backup/*.pgdump file.
                          If a matching *global*.sql or *global*.sql.gz exists, it is restored too.
  --require-restore-backup
                          Fail when --restore-backup path is missing or contains no main dump.
  --hasura-metadata PATH  Optional metadata.json or archive containing metadata.json.
                          If omitted, restore directory is scanned for Hasura metadata.
  --skip-hasura-track     Do not auto-track public tables/views in Hasura after DB restore.
  -y, --yes               Do not ask for confirmation before deploy.

Default path rule:
  Without --project-dir, the project is expected at:
    /home/<current-user>/projects/erp_dev
  and the repository is expected inside it:
    /home/<current-user>/projects/erp_dev/repo_erp
  Override with ERP_PROJECT_DIR=/custom/path or --project-dir PATH.
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
    --project-dir) PROJECT_DIR="$2"; PROJECT_DIR_ARG_SET=1; shift 2 ;;
    --env-file) ENV_FILE="$2"; ENV_FILE_ARG_SET=1; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; COMPOSE_FILE_ARG_SET=1; shift 2 ;;
    --expected-ip) EXPECTED_IP="$2"; shift 2 ;;
    --skip-dns) RUN_DNS_CHECK=0; shift ;;
    --skip-smoke) RUN_SMOKE=0; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    --skip-bootstrap) SKIP_BOOTSTRAP=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --force-recreate) FORCE_RECREATE=1; shift ;;
    --restore-backup) RESTORE_BACKUP_PATH="$2"; shift 2 ;;
    --require-restore-backup) REQUIRE_RESTORE_BACKUP=1; shift ;;
    --hasura-metadata) HASURA_METADATA_PATH="$2"; shift 2 ;;
    --skip-hasura-track) TRACK_HASURA_AFTER_RESTORE=0; shift ;;
    -y|--yes) AUTO_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
[[ "$ENV_FILE_ARG_SET" == "0" ]] && ENV_FILE="$PROJECT_DIR/.env"
[[ "$COMPOSE_FILE_ARG_SET" == "0" ]] && COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"

if [[ "$PROJECT_DIR_ARG_SET" == "0" && "$PROJECT_DIR" != "$PREFERRED_PROJECT_DIR" ]]; then
  repo_url="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || printf '<repo-url>')"
  parent_dir="$(dirname "$PREFERRED_PROJECT_DIR")"
  preferred_repo_dir="$PREFERRED_PROJECT_DIR/repo_erp"

  cat <<EOF
The VPS project directory must be:
  $PREFERRED_PROJECT_DIR

The repository must be inside it:
  $preferred_repo_dir

Current runtime directory is:
  $PROJECT_DIR

Current repository directory is:
  $REPO_DIR

Clone or move the repository into the required structure, then rerun:
  mkdir -p "$parent_dir"
  mkdir -p "$PREFERRED_PROJECT_DIR/spec_erp"
  git clone "$repo_url" "$preferred_repo_dir"
  cd "$preferred_repo_dir"
  sudo ops/setup-vps.sh

If this different path is intentional, rerun with:
  sudo ops/setup-vps.sh --project-dir "$PROJECT_DIR"
EOF
  exit 2
fi

needs_env_edit() {
  [[ -f "$ENV_FILE" ]] || return 0

  grep -Ev '^[[:space:]]*#' "$ENV_FILE" \
    | grep -Eq 'REPLACE_ME|hasura-test\.example\.com|backend-test\.example\.com|app-test\.example\.com|admin@example\.com'
}

print_next_env_steps() {
  cat <<EOF

.env is created but still contains placeholders.

Edit it now:
  nano "$ENV_FILE"

Minimum values to replace:
  HASURA_FQDN
  BACKEND_FQDN
  FRONTEND_ORIGIN
  LETSENCRYPT_EMAIL
  PG_PASSWORD
  HASURA_GRAPHQL_DATABASE_URL
  HASURA_MD_PASSWORD
  HASURA_ADMIN_SECRET
  HASURA_JWT_SECRET
  HASURA_GRAPHQL_CORS_DOMAIN
  BACKEND_REFRESH_TOKEN_PEPPER
  BACKEND_CORS_ALLOWED_ORIGINS

Domain timing:
  DNS A records for HASURA_FQDN and BACKEND_FQDN must already point to this VPS
  before the next run, because Traefik will request Let's Encrypt certificates.

After editing, rerun:
  sudo ops/setup-vps.sh
EOF
}

confirm_deploy() {
  [[ "$AUTO_YES" == "0" ]] || return 0

  printf '\nThis will deploy/recreate the ERP stack using:\n'
  printf '  project: %s\n' "$PROJECT_DIR"
  printf '  env:     %s\n' "$ENV_FILE"
  printf '  compose: %s\n\n' "$COMPOSE_FILE"
  if [[ -n "$RESTORE_BACKUP_PATH" ]]; then
    printf 'A destructive DB restore will run if a backup is found at:\n'
    printf '  restore backup: %s\n\n' "$RESTORE_BACKUP_PATH"
  fi
  if [[ -n "$HASURA_METADATA_PATH" ]]; then
    printf 'Hasura metadata will be applied from:\n'
    printf '  metadata: %s\n\n' "$HASURA_METADATA_PATH"
  fi
  printf 'Continue? Type yes: '

  local answer
  read -r answer
  [[ "$answer" == "yes" ]] || fail "Cancelled"
}

ensure_templates_if_missing() {
  mkdir -p \
    "$PROJECT_DIR/config/postgres" \
    "$PROJECT_DIR/data/postgres/main" \
    "$PROJECT_DIR/data/postgres/hasura_md" \
    "$PROJECT_DIR/data/traefik" \
    "$PROJECT_DIR/backups" \
    "$PROJECT_DIR/restore"

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    cp "$REPO_DIR/ops/templates/docker-compose.vps.yml" "$COMPOSE_FILE"
    log "Created $COMPOSE_FILE from template"
  fi

  if [[ ! -f "$PROJECT_DIR/config/postgres/pg_hba.conf" ]]; then
    cp "$REPO_DIR/ops/templates/pg_hba.vps.conf" "$PROJECT_DIR/config/postgres/pg_hba.conf"
    log "Created config/postgres/pg_hba.conf from template"
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$REPO_DIR/ops/templates/env.vps.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "Created $ENV_FILE from template"
  fi
}

run_check_env() {
  local args=(--env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE")
  if [[ "$RUN_DNS_CHECK" == "1" ]]; then
    args+=(--dns)
    [[ -n "$EXPECTED_IP" ]] && args+=(--expected-ip "$EXPECTED_IP")
  fi

  "$REPO_DIR/ops/check-env.sh" "${args[@]}"
}

run_deploy() {
  local args=(--project-dir "$PROJECT_DIR" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE")
  [[ "$FORCE_RECREATE" == "1" ]] && args+=(--force-recreate)

  "$REPO_DIR/ops/deploy-stack.sh" "${args[@]}"
}

run_smoke() {
  "$REPO_DIR/ops/smoke-vps.sh" --project-dir "$PROJECT_DIR" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE"
}

run_tests() {
  "$REPO_DIR/ops/run-vps-tests.sh" --project-dir "$REPO_DIR" --env-file "$ENV_FILE"
}

apply_hasura_metadata() {
  local metadata_path="$1"
  [[ -n "$metadata_path" ]] || return 1

  "$REPO_DIR/ops/apply-hasura-metadata.sh" \
    --env-file "$ENV_FILE" \
    --metadata "$metadata_path"
  HASURA_METADATA_APPLIED=1
}

track_hasura_after_restore() {
  [[ "$TRACK_HASURA_AFTER_RESTORE" == "1" ]] || return 0

  "$REPO_DIR/ops/track-hasura-public-schema.sh" \
    --project-dir "$PROJECT_DIR" \
    --env-file "$ENV_FILE" \
    --compose-file "$COMPOSE_FILE"
}

resolve_project_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$PROJECT_DIR" "$value"
  fi
}

find_newest_file() {
  local directory="$1"
  shift

  find "$directory" -type f "$@" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | sed -n '1s/^[^ ]* //p'
}

find_main_dump_in_dir() {
  local directory="$1"

  find_newest_file "$directory" \
    \( -iname '*.dump' -o -iname '*.backup' -o -iname '*.pgdump' \) \
    ! -iname '*global*' \
    ! -path '*/pre_restore/*' \
    ! -path '*/logs/*'
}

find_globals_dump_in_dir() {
  local directory="$1"

  find_newest_file "$directory" \
    \( -iname '*global*.sql' -o -iname '*global*.sql.gz' -o -iname '*globals*.sql' -o -iname '*globals*.sql.gz' \) \
    ! -path '*/pre_restore/*' \
    ! -path '*/logs/*'
}

find_hasura_metadata_in_dir() {
  local directory="$1"

  find_newest_file "$directory" \
    \( -iname '*hasura*metadata*.json' \
      -o -iname '*hasura*metadata*.tar' \
      -o -iname '*hasura*metadata*.tar.gz' \
      -o -iname '*hasura*metadata*.tgz' \
      -o -iname '*hasura*metadata*.zip' \
      -o -iname 'metadata.json' \
      -o -iname 'metadata.tar' \
      -o -iname 'metadata.tar.gz' \
      -o -iname 'metadata.tgz' \
      -o -iname 'metadata.zip' \) \
    ! -path '*/pre_restore/*' \
    ! -path '*/logs/*'
}

fail_or_skip_restore() {
  local message="$1"

  if [[ "$REQUIRE_RESTORE_BACKUP" == "1" ]]; then
    fail "$message"
  fi

  log "$message; skipping DB restore"
  return 0
}

run_restore_backup_if_requested() {
  [[ -n "$RESTORE_BACKUP_PATH" ]] || return 0

  local restore_path
  local main_dump=""
  local globals_dump=""
  local hasura_metadata=""
  restore_path="$(resolve_project_path "$RESTORE_BACKUP_PATH")"

  if [[ ! -e "$restore_path" ]]; then
    fail_or_skip_restore "Restore backup path not found: $restore_path"
    return 0
  fi

  if [[ -f "$restore_path" ]]; then
    case "$restore_path" in
      *.dump|*.backup|*.pgdump) main_dump="$restore_path" ;;
      *) fail "Unsupported restore backup file extension: $restore_path. Use *.dump, *.backup, or *.pgdump." ;;
    esac
    globals_dump="$(find_globals_dump_in_dir "$(dirname "$restore_path")")"
    hasura_metadata="$(find_hasura_metadata_in_dir "$(dirname "$restore_path")")"
  elif [[ -d "$restore_path" ]]; then
    main_dump="$(find_main_dump_in_dir "$restore_path")"
    globals_dump="$(find_globals_dump_in_dir "$restore_path")"
    hasura_metadata="$(find_hasura_metadata_in_dir "$restore_path")"
  else
    fail_or_skip_restore "Restore backup path is neither a file nor a directory: $restore_path"
    return 0
  fi

  if [[ -z "$main_dump" ]]; then
    fail_or_skip_restore "No main DB dump found under: $restore_path"
    return 0
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  [[ -n "${PG_DB:-}" ]] || fail "PG_DB is required in .env for DB restore"

  local restore_args=(
    --project-dir "$PROJECT_DIR"
    --env-file "$ENV_FILE"
    --compose-file "$COMPOSE_FILE"
    --main-dump "$main_dump"
    --confirm-db "$PG_DB"
  )

  if [[ -n "$globals_dump" ]]; then
    restore_args+=(--globals-dump "$globals_dump" --restore-globals)
    log "Selected globals dump: $globals_dump"
  else
    log "No globals dump found near restore backup; restoring main dump only"
  fi

  log "Selected main DB dump: $main_dump"
  "$REPO_DIR/ops/restore-prod-backup.sh" "${restore_args[@]}"

  if [[ -n "$HASURA_METADATA_PATH" ]]; then
    hasura_metadata="$(resolve_project_path "$HASURA_METADATA_PATH")"
  fi

  if [[ -n "$hasura_metadata" ]]; then
    log "Selected Hasura metadata: $hasura_metadata"
    apply_hasura_metadata "$hasura_metadata"
  else
    log "No Hasura metadata found near restore backup; using public schema auto-track fallback"
    track_hasura_after_restore
  fi
}

apply_standalone_hasura_metadata_if_requested() {
  [[ "$HASURA_METADATA_APPLIED" == "0" ]] || return 0
  [[ -n "$HASURA_METADATA_PATH" ]] || return 0

  local metadata_path
  metadata_path="$(resolve_project_path "$HASURA_METADATA_PATH")"
  log "Selected Hasura metadata: $metadata_path"
  apply_hasura_metadata "$metadata_path"
}

[[ -d "$REPO_DIR/ops" ]] || fail "ops directory not found under $REPO_DIR"

if [[ "$SKIP_BOOTSTRAP" == "0" ]]; then
  log "Running VPS bootstrap"
  "$REPO_DIR/ops/bootstrap-vps.sh" --project-dir "$PROJECT_DIR"
else
  log "Skipping bootstrap"
fi

ensure_templates_if_missing

if needs_env_edit; then
  print_next_env_steps
  exit 2
fi

log "Validating environment"
run_check_env

if [[ "$SKIP_DEPLOY" == "1" ]]; then
  log "Skipping deploy by request"
  exit 0
fi

confirm_deploy

log "Deploying stack"
run_deploy

run_restore_backup_if_requested
apply_standalone_hasura_metadata_if_requested

if [[ "$RUN_SMOKE" == "1" ]]; then
  log "Running smoke checks"
  run_smoke
else
  log "Skipping smoke checks"
fi

if [[ "$RUN_TESTS" == "1" ]]; then
  log "Running test suite"
  run_tests
else
  log "Skipping test suite"
fi

log "VPS setup complete"

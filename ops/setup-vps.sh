#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$SCRIPT_PROJECT_DIR"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
RUN_DNS_CHECK=1
RUN_SMOKE=1
FORCE_RECREATE=0
EXPECTED_IP=""
SKIP_BOOTSTRAP=0
SKIP_DEPLOY=0
AUTO_YES=0
PROJECT_DIR_ARG_SET=0

preferred_project_dir() {
  local owner="${SUDO_USER:-${USER:-}}"
  if [[ -z "$owner" || "$owner" == "root" ]]; then
    owner="$(logname 2>/dev/null || true)"
  fi
  if [[ -z "$owner" || "$owner" == "root" ]]; then
    owner="user"
  fi

  printf '/home/%s/projects/erp' "$owner"
}

PREFERRED_PROJECT_DIR="${ERP_PROJECT_DIR:-$(preferred_project_dir)}"

usage() {
  cat <<'EOF'
setup-vps.sh

One-command VPS setup for the ERP stack.

First run on a fresh VPS:
  cd /home/<user>/projects/erp
  sudo ops/setup-vps.sh

What it does:
  1. Installs Docker and prepares folders/templates.
  2. Creates .env from ops/templates/env.vps.example if missing.
  3. Stops until real domains/secrets are filled in .env.
  4. On the next run, validates env and DNS.
  5. Deploys Traefik, Postgres, Hasura, and backend.
  6. Runs HTTPS health checks and Hasura CORS preflight.

Options:
  --project-dir PATH       Repo/project directory. Default: repo root.
  --env-file PATH          Env file. Default: PROJECT_DIR/.env.
  --compose-file PATH      Compose file. Default: PROJECT_DIR/docker-compose.yml.
  --expected-ip IP         Expected public IP for DNS checks.
  --skip-dns              Do not check DNS A records before deploy.
  --skip-smoke            Do not run smoke checks after deploy.
  --skip-bootstrap        Do not run bootstrap-vps.sh.
  --skip-deploy           Stop after bootstrap/env validation.
  --force-recreate        Recreate containers during deploy.
  -y, --yes               Do not ask for confirmation before deploy.

Default path rule:
  Without --project-dir, the repo is expected at:
    /home/<current-user>/projects/erp
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
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --expected-ip) EXPECTED_IP="$2"; shift 2 ;;
    --skip-dns) RUN_DNS_CHECK=0; shift ;;
    --skip-smoke) RUN_SMOKE=0; shift ;;
    --skip-bootstrap) SKIP_BOOTSTRAP=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    --force-recreate) FORCE_RECREATE=1; shift ;;
    -y|--yes) AUTO_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
[[ "$ENV_FILE" = /* ]] || ENV_FILE="$PROJECT_DIR/$ENV_FILE"
[[ "$COMPOSE_FILE" = /* ]] || COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"

if [[ "$PROJECT_DIR_ARG_SET" == "0" && "$PROJECT_DIR" != "$PREFERRED_PROJECT_DIR" ]]; then
  repo_url="$(git -C "$SCRIPT_PROJECT_DIR" remote get-url origin 2>/dev/null || printf '<repo-url>')"
  parent_dir="$(dirname "$PREFERRED_PROJECT_DIR")"

  cat <<EOF
The VPS project directory must be:
  $PREFERRED_PROJECT_DIR

Current script directory is:
  $SCRIPT_PROJECT_DIR

Clone or move the repository into the required structure, then rerun:
  mkdir -p "$parent_dir"
  git clone "$repo_url" "$PREFERRED_PROJECT_DIR"
  cd "$PREFERRED_PROJECT_DIR"
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
    cp "$PROJECT_DIR/ops/templates/docker-compose.vps.yml" "$COMPOSE_FILE"
    log "Created $COMPOSE_FILE from template"
  fi

  if [[ ! -f "$PROJECT_DIR/config/postgres/pg_hba.conf" ]]; then
    cp "$PROJECT_DIR/ops/templates/pg_hba.vps.conf" "$PROJECT_DIR/config/postgres/pg_hba.conf"
    log "Created config/postgres/pg_hba.conf from template"
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$PROJECT_DIR/ops/templates/env.vps.example" "$ENV_FILE"
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

  "$PROJECT_DIR/ops/check-env.sh" "${args[@]}"
}

run_deploy() {
  local args=(--env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE")
  [[ "$FORCE_RECREATE" == "1" ]] && args+=(--force-recreate)

  "$PROJECT_DIR/ops/deploy-stack.sh" "${args[@]}"
}

run_smoke() {
  "$PROJECT_DIR/ops/smoke-vps.sh" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE"
}

[[ -d "$PROJECT_DIR/ops" ]] || fail "ops directory not found under $PROJECT_DIR"

if [[ "$SKIP_BOOTSTRAP" == "0" ]]; then
  log "Running VPS bootstrap"
  "$PROJECT_DIR/ops/bootstrap-vps.sh" --project-dir "$PROJECT_DIR"
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

if [[ "$RUN_SMOKE" == "1" ]]; then
  log "Running smoke checks"
  run_smoke
else
  log "Skipping smoke checks"
fi

log "VPS setup complete"

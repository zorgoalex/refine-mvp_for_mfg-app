#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$REPO_DIR"
SKIP_FIREWALL=0
POSTGRES_DATA_UID="${POSTGRES_DATA_UID:-70}"
POSTGRES_DATA_GID="${POSTGRES_DATA_GID:-70}"

usage() {
  cat <<'EOF'
bootstrap-vps.sh

Prepare a fresh Ubuntu/Debian VPS for this ERP Docker stack.

Usage:
  ops/bootstrap-vps.sh [--project-dir PATH] [--skip-firewall]

Run as root, or as a sudo-capable user. This installs Docker if missing,
opens 22/80/443 with ufw, and creates required data/config directories.
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
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || fail "sudo is required when not running as root"
  SUDO=(sudo)
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_docker() {
  if need_cmd docker && docker compose version >/dev/null 2>&1; then
    log "Docker and compose plugin already installed"
    return 0
  fi

  log "Installing Docker using official convenience script"
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y ca-certificates curl gnupg git jq ufw
  curl -fsSL https://get.docker.com | "${SUDO[@]}" sh

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    "${SUDO[@]}" usermod -aG docker "$SUDO_USER" || true
    log "User $SUDO_USER added to docker group; re-login may be required"
  fi
}

configure_firewall() {
  [[ "$SKIP_FIREWALL" == "0" ]] || return 0
  need_cmd ufw || "${SUDO[@]}" apt-get install -y ufw
  need_cmd jq || "${SUDO[@]}" apt-get install -y jq

  log "Configuring ufw for SSH/HTTP/HTTPS"
  "${SUDO[@]}" ufw allow OpenSSH
  "${SUDO[@]}" ufw allow 80/tcp
  "${SUDO[@]}" ufw allow 443/tcp
  "${SUDO[@]}" ufw --force enable
}

create_project_dirs() {
  log "Creating project directories under $PROJECT_DIR"
  "${SUDO[@]}" mkdir -p \
    "$PROJECT_DIR/config/postgres" \
    "$PROJECT_DIR/data/postgres/main" \
    "$PROJECT_DIR/data/postgres/hasura_md" \
    "$PROJECT_DIR/data/traefik" \
    "$PROJECT_DIR/backups" \
    "$PROJECT_DIR/restore"

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    "${SUDO[@]}" chown -R "$SUDO_USER:$SUDO_USER" \
      "$PROJECT_DIR/config" \
      "$PROJECT_DIR/data/traefik" \
      "$PROJECT_DIR/backups" \
      "$PROJECT_DIR/restore"
    "${SUDO[@]}" chown "$SUDO_USER:$SUDO_USER" "$PROJECT_DIR/data" "$PROJECT_DIR/data/postgres"
  fi

  ensure_postgres_data_owner "$PROJECT_DIR/data/postgres/main"
  ensure_postgres_data_owner "$PROJECT_DIR/data/postgres/hasura_md"
}

ensure_postgres_data_owner() {
  local data_dir="$1"
  local expected_owner="${POSTGRES_DATA_UID}:${POSTGRES_DATA_GID}"
  local current_owner=""

  if [[ -f "$data_dir/PG_VERSION" ]]; then
    current_owner="$(stat -c '%u:%g' "$data_dir/PG_VERSION")"
  else
    current_owner="$(stat -c '%u:%g' "$data_dir")"
  fi

  if [[ "$current_owner" != "$expected_owner" ]]; then
    log "Setting Postgres data ownership on $data_dir to $expected_owner"
    "${SUDO[@]}" chown -R "$expected_owner" "$data_dir"
  fi
}

install_templates_if_missing() {
  local compose="$PROJECT_DIR/docker-compose.yml"
  local pg_hba="$PROJECT_DIR/config/postgres/pg_hba.conf"
  local env_file="$PROJECT_DIR/.env"

  if [[ ! -f "$compose" ]]; then
    cp "$REPO_DIR/ops/templates/docker-compose.vps.yml" "$compose"
    log "Created $compose from template"
  fi

  if [[ ! -f "$pg_hba" ]]; then
    cp "$REPO_DIR/ops/templates/pg_hba.vps.conf" "$pg_hba"
    log "Created $pg_hba from template"
  fi

  if [[ ! -f "$env_file" ]]; then
    cp "$REPO_DIR/ops/templates/env.vps.example" "$env_file"
    chmod 600 "$env_file"
    log "Created $env_file from template; fill it before deploy"
  fi

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    chown "$SUDO_USER:$SUDO_USER" "$compose" "$pg_hba" "$env_file" 2>/dev/null || true
  fi
}

install_docker
configure_firewall
create_project_dirs
install_templates_if_missing

log "Bootstrap complete"

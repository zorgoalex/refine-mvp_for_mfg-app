#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/home/ovhtest/projects/erp_dev/.env}"
readonly SOURCE_POSTGRES_CONTAINER="erp_test-postgresdb-1"
readonly SOURCE_METADATA_CONTAINER="erp_test-hasura_metadata_db-1"
readonly TARGET_POSTGRES_CONTAINER="erp_ui_redesign-postgresdb-1"
readonly TARGET_METADATA_CONTAINER="erp_ui_redesign-hasura_metadata_db-1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
readonly SECRETS_FILE="${SCRIPT_DIR}/.env.secrets"
DUMP_FILES=()

cleanup() {
  local path
  for path in "${DUMP_FILES[@]}"; do
    [[ -n "${path}" ]] && rm -f -- "${path}"
  done
}
trap cleanup EXIT

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

ensure_review_secrets() {
  local jwt_secret refresh_pepper hasura_secret

  if [[ -f "${SECRETS_FILE}" ]]; then
    return 0
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate isolated review secrets" >&2
    exit 1
  fi

  umask 077
  jwt_secret="$(openssl rand -hex 32)"
  refresh_pepper="$(openssl rand -hex 32)"
  hasura_secret="$(openssl rand -hex 32)"
  printf '%s\n' \
    "UI_REDESIGN_JWT_SECRET=${jwt_secret}" \
    "UI_REDESIGN_REFRESH_TOKEN_PEPPER=${refresh_pepper}" \
    "UI_REDESIGN_HASURA_ADMIN_SECRET=${hasura_secret}" \
    > "${SECRETS_FILE}"
  chmod 600 "${SECRETS_FILE}"
  echo "Generated isolated review secrets: ${SECRETS_FILE}"
}

ensure_review_secrets

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# `COMPOSE_PROJECT_NAME` in the shared env belongs to the source stack. The
# explicit CLI value has highest precedence and is therefore a hard isolation
# boundary; top-level `name:` alone is not sufficient when that env key exists.
docker compose --project-name erp_ui_redesign \
  --env-file "${ENV_FILE}" --env-file "${SECRETS_FILE}" \
  -f "${COMPOSE_FILE}" \
  up -d postgresdb hasura_metadata_db valkey

wait_healthy() {
  local container="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${container}" 2>/dev/null || true)" == "healthy" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Container did not become healthy: ${container}" >&2
  return 1
}

assert_isolated_target() {
  local container="$1"
  local project
  project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "${container}")"
  if [[ "${project}" != "erp_ui_redesign" ]]; then
    echo "Refusing to overwrite non-isolated target: ${container} (${project})" >&2
    exit 1
  fi
}

assert_fixed_source() {
  local container="$1"
  local target_container="$2"
  local database="$3"
  local username="$4"
  local project state

  if [[ "${container}" == "${target_container}" ]]; then
    echo "Source and target containers must differ: ${container}" >&2
    exit 1
  fi

  project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "${container}" 2>/dev/null || true)"
  state="$(docker inspect --format '{{.State.Status}}' "${container}" 2>/dev/null || true)"
  if [[ "${project}" != "erp_test" || "${state}" != "running" ]]; then
    echo "Refusing unexpected source container: ${container} (project=${project:-missing}, state=${state:-missing})" >&2
    exit 1
  fi

  docker exec \
    -e EXPECTED_DB="${database}" \
    -e EXPECTED_USER="${username}" \
    "${container}" sh -c \
    'test "$POSTGRES_DB" = "$EXPECTED_DB" && test "$POSTGRES_USER" = "$EXPECTED_USER"' \
    || {
      echo "Refusing source with unexpected database identity: ${container}" >&2
      exit 1
    }
}

clone_database() {
  local source_container="$1"
  local target_container="$2"
  local database="$3"
  local username="$4"
  local password="$5"
  local preserve_legacy_cut_rows="${6:-false}"
  local dump_file

  dump_file="$(mktemp)"
  DUMP_FILES+=("${dump_file}")

  docker exec -e PGPASSWORD="${password}" "${target_container}" \
    dropdb --if-exists --force --username "${username}" "${database}"
  docker exec -e PGPASSWORD="${password}" "${target_container}" \
    createdb --username "${username}" "${database}"
  docker exec -e PGPASSWORD="${password}" "${source_container}" \
    pg_dump --format=custom --no-owner --no-privileges --username "${username}" "${database}" \
    > "${dump_file}"

  docker exec -i -e PGPASSWORD="${password}" "${target_container}" \
    pg_restore --exit-on-error --section=pre-data --no-owner --no-privileges \
      --username "${username}" --dbname "${database}" < "${dump_file}"

  if [[ "${preserve_legacy_cut_rows}" == "true" ]]; then
    # The source has historical cut snapshots which predate the current
    # function-backed CHECK semantics. PostgreSQL does not recheck them in the
    # live database, but dump/restore inserts would be rejected. Recreate the
    # same forward-write behavior by loading without the constraint and adding
    # it back NOT VALID after the data is present.
    docker exec -e PGPASSWORD="${password}" "${target_container}" \
      psql --username "${username}" --dbname "${database}" --set ON_ERROR_STOP=1 \
      --command 'ALTER TABLE public.cut_result DROP CONSTRAINT IF EXISTS chk_cut_result_snapshot_shape'
  fi

  docker exec -i -e PGPASSWORD="${password}" "${target_container}" \
    pg_restore --exit-on-error --section=data --no-owner --no-privileges \
      --username "${username}" --dbname "${database}" < "${dump_file}"
  docker exec -i -e PGPASSWORD="${password}" "${target_container}" \
    pg_restore --exit-on-error --section=post-data --no-owner --no-privileges \
      --username "${username}" --dbname "${database}" < "${dump_file}"

  if [[ "${preserve_legacy_cut_rows}" == "true" ]]; then
    docker exec -e PGPASSWORD="${password}" "${target_container}" \
      psql --username "${username}" --dbname "${database}" --set ON_ERROR_STOP=1 \
      --command 'ALTER TABLE public.cut_result ADD CONSTRAINT chk_cut_result_snapshot_shape CHECK (cut_result_snapshot_is_complete(snapshot_job, snapshot_manifest, snapshot_digest)) NOT VALID'
  fi

  rm -f "${dump_file}"
}

wait_healthy "${TARGET_POSTGRES_CONTAINER}"
wait_healthy "${TARGET_METADATA_CONTAINER}"
assert_fixed_source "${SOURCE_POSTGRES_CONTAINER}" "${TARGET_POSTGRES_CONTAINER}" "${PG_DB}" "${PG_USER}"
assert_fixed_source "${SOURCE_METADATA_CONTAINER}" "${TARGET_METADATA_CONTAINER}" "${HASURA_MD_DB}" "${HASURA_MD_USER}"
assert_isolated_target "${TARGET_POSTGRES_CONTAINER}"
assert_isolated_target "${TARGET_METADATA_CONTAINER}"

clone_database "${SOURCE_POSTGRES_CONTAINER}" "${TARGET_POSTGRES_CONTAINER}" "${PG_DB}" "${PG_USER}" "${PG_PASSWORD}" true
clone_database "${SOURCE_METADATA_CONTAINER}" "${TARGET_METADATA_CONTAINER}" "${HASURA_MD_DB}" "${HASURA_MD_USER}" "${HASURA_MD_PASSWORD}"

# The snapshot carries users and permissions, never live login sessions. This
# also prevents a copied refresh token from being replayed against the review
# stack even if a browser still holds a source-stack cookie.
docker exec -e PGPASSWORD="${PG_PASSWORD}" "${TARGET_POSTGRES_CONTAINER}" \
  psql --username "${PG_USER}" --dbname "${PG_DB}" --set ON_ERROR_STOP=1 \
  --command 'BEGIN; DELETE FROM refresh_tokens; DELETE FROM auth_sessions; COMMIT;'

echo "Isolated databases cloned; copied auth sessions removed."

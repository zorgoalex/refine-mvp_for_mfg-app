#!/usr/bin/env bash
# End-to-end check of the 1C agent ingress chain with the REAL backend module:
#   curl (client cert) -> real Traefik v3.6 (routes translated from the template
#   labels + onec-mtls.yml) -> backend container running the onec-agent stack
#   (tsx, scripts/onec-ingress-e2e-server.ts) -> isolated PostgreSQL schema in
#   the erp_test database (migration 193).
# Covers registered / unregistered / revoked certificates, forged agent id,
# the regular API host, and rollback (module disabled: regular API still up).
# Isolation: a private Traefik with the file provider only; containers carry no
# Traefik labels, so the host's shared Traefik never sees them. Leaves nothing
# behind: own compose project, schema dropped.
# Run through the heavy guard:
#   rtk nice -n 10 ~/.codex/rtk-heavy-guard -- ops/onec-agent-ingress-e2e.sh
set -Euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_CONTAINER="${ONEC_E2E_PG_CONTAINER:-erp_test-postgresdb-1}"
PG_NETWORK="$(docker inspect "$PG_CONTAINER" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
WORK="$(mktemp -d)"
PROJECT="onec-ingress-e2e-$$"
SCHEMA="e2e_onec_ingress_$$"
SECRET="e2e-ingress-secret-$(openssl rand -hex 16)"
API_HOST=api.e2e.test AGENT_HOST=onec.e2e.test AGENT_ID=e2e-harness-agent
P_WEB=18481 P_API=18444 P_AGENT=18844
FAILED=0

psql_exec() { docker exec -i "$PG_CONTAINER" sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
compose() { docker compose -p "$PROJECT" -f "$WORK/compose.yml" "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  echo "DROP SCHEMA IF EXISTS $SCHEMA CASCADE;" | psql_exec >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
check() { if [[ "$2" == "0" ]]; then echo "PASS $1"; else echo "FAIL $1"; FAILED=1; fi; }

# --- certificates -----------------------------------------------------------
mkdir -p "$WORK/dynamic" "$WORK/certs"
cp "$REPO_DIR/ops/traefik/dynamic/onec-mtls.yml" "$WORK/dynamic/"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -keyout "$WORK/dynamic/server.key" \
  -out "$WORK/dynamic/server.crt" -subj "/CN=$AGENT_HOST" -addext "subjectAltName=DNS:$AGENT_HOST,DNS:$API_HOST" >/dev/null 2>&1
printf 'tls:\n  certificates:\n    - certFile: /etc/traefik/dynamic/server.crt\n      keyFile: /etc/traefik/dynamic/server.key\n' > "$WORK/dynamic/e2e-certs.yml"
for c in registered unregistered; do
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -keyout "$WORK/certs/$c.key" \
    -out "$WORK/certs/$c.crt" -subj "/CN=e2e-$c" >/dev/null 2>&1
done
FP="$(openssl x509 -in "$WORK/certs/registered.crt" -outform DER | sha256sum | cut -d' ' -f1)"

# --- isolated schema: minimal stand-ins + migration 193 + seed ----------------
{
  echo "CREATE SCHEMA $SCHEMA; SET search_path=$SCHEMA,pg_catalog;"
  echo "CREATE TABLE users(user_id bigint PRIMARY KEY, username text);"
  echo "CREATE TABLE roles(role_id bigint, role_code text);"
  echo "CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order int, is_dangerous bool, is_active bool, updated_at timestamptz);"
  echo "CREATE TABLE role_permissions(role_id bigint, permission_name text, is_enabled bool, PRIMARY KEY(role_id, permission_name));"
  echo "CREATE TABLE permissions_state(id bool, version int, updated_at timestamptz); INSERT INTO permissions_state VALUES (true,1,now());"
  echo "CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);"
  echo "CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);"
  cat "$REPO_DIR/backend/db/migrations/193_onec_agent_foundation.sql"
  cat "$REPO_DIR/backend/db/migrations/196_onec_agent_commands.sql"
  echo "INSERT INTO onec_sources(code, display_name) VALUES ('e2e','E2E-Тест источник');"
  echo "INSERT INTO onec_agents(agent_id, source_id, site_id, display_name) SELECT '$AGENT_ID', source_id, 'e2e', 'E2E-Тест агент' FROM onec_sources;"
  echo "INSERT INTO onec_agent_certificates(agent_id, sha256_fingerprint) VALUES ('$AGENT_ID', decode('$FP','hex'));"
} | psql_exec >/dev/null || { echo "FAIL schema setup"; exit 1; }

# Connection string for the backend container (container DNS name of PostgreSQL);
# exported only into the compose process environment, never written to disk.
ONEC_E2E_DATABASE_URL="$(docker inspect "$PG_CONTAINER" | python3 -c '
import json, sys, urllib.parse
c = json.load(sys.stdin)[0]
env = dict(e.split("=", 1) for e in c["Config"]["Env"])
name = c["Name"].lstrip("/")
opts = urllib.parse.quote("-c search_path='"$SCHEMA"',pg_catalog -c lock_timeout=5000")
user = urllib.parse.quote(env["POSTGRES_USER"])
password = urllib.parse.quote(env["POSTGRES_PASSWORD"])
db = env.get("POSTGRES_DB", "erpdb")
print("postgresql://" + user + ":" + password + "@" + name + ":5432/" + db + "?options=" + opts)
')"
export ONEC_E2E_DATABASE_URL ONEC_E2E_SECRET="$SECRET"

# --- private Traefik (file provider) + backend container --------------------------
python3 - "$REPO_DIR" "$WORK" "$SECRET" "$API_HOST" "$AGENT_HOST" "$P_WEB" "$P_API" "$P_AGENT" "$PROJECT" "$PG_NETWORK" <<'PY'
import json, subprocess, sys, yaml
repo, work, secret, api_host, agent_host, p_web, p_api, p_agent, project, pg_network = sys.argv[1:]
vps = yaml.safe_load(open(f'{repo}/ops/templates/docker-compose.vps.yml'))
subst = {'${BACKEND_FQDN}': api_host, '${ONEC_AGENT_FQDN}': agent_host, '${ONEC_INGRESS_SECRET}': secret,
         '${ONEC_AGENT_PORT:-3001}': '3001'}
json.dump(subst, open(f'{work}/subst.json', 'w'))
# Routes come from the SAME template labels, translated to the file provider.
subprocess.run(['python3', f'{repo}/ops/onec_ingress_labels_to_file.py', repo, f'{work}/dynamic/routes.yml', f'{work}/subst.json', 'backend'], check=True)
# No docker provider and no labels: the harness stays invisible to the host's shared Traefik.
command = [c for c in vps['services']['traefik']['command'] if 'certificatesresolvers' not in c and not c.startswith('--providers.docker')]
command += ['--log.level=ERROR']
node_modules = ['/home/ovhtest/projects/erp_dev/repo_erp/node_modules', '/home/ovhtest/projects/erp_dev/repo_erp/backend/node_modules']
compose = {'services': {
  'traefik': {'image': vps['services']['traefik']['image'], 'command': command,
              'ports': [f'127.0.0.1:{p_web}:80', f'127.0.0.1:{p_api}:443', f'127.0.0.1:{p_agent}:8443'],
              'volumes': [f'{work}/dynamic:/etc/traefik/dynamic:ro'], 'networks': ['edge']},
  'backend': {'image': 'node:20-bookworm-slim', 'working_dir': f'{repo}/backend',
              'command': ['node_modules/.bin/tsx', 'scripts/onec-ingress-e2e-server.ts'],
              'environment': {'ONEC_E2E_DATABASE_URL': '${ONEC_E2E_DATABASE_URL}', 'ONEC_E2E_SECRET': '${ONEC_E2E_SECRET}',
                              'ONEC_E2E_ENABLED': '${ONEC_E2E_ENABLED}', 'ONEC_E2E_BIND': '0.0.0.0',
                              'ONEC_E2E_MAIN_PORT': '3000', 'ONEC_E2E_AGENT_PORT': '3001'},
              'volumes': [f'{repo}:{repo}:ro'] + [f'{p}:{p}:ro' for p in node_modules],
              'networks': ['edge', 'pg']}},
  'networks': {'edge': {'name': f'{project}_edge'}, 'pg': {'name': pg_network, 'external': True}}}
yaml.safe_dump(compose, open(f'{work}/compose.yml', 'w'), sort_keys=False)
PY

start_backend() { # enabled
  ONEC_E2E_ENABLED="$1" compose up -d --force-recreate backend >/dev/null 2>&1 || { echo "FAIL backend container"; exit 1; }
  for _ in $(seq 1 120); do compose logs backend 2>/dev/null | grep -q "READY enabled=$1" && return 0; sleep 0.5; done
  echo "FAIL backend did not start"; compose logs backend 2>&1 | grep -vE 'postgresql://' | tail -20; exit 1
}

ONEC_E2E_ENABLED=true compose up -d traefik >/dev/null 2>&1 || { echo "FAIL traefik"; exit 1; }
start_backend true
AGENT=(curl -s --max-time 15 --cacert "$WORK/dynamic/server.crt" --resolve "$AGENT_HOST:$P_AGENT:127.0.0.1")
API=(curl -s --max-time 15 --cacert "$WORK/dynamic/server.crt" --resolve "$API_HOST:$P_API:127.0.0.1")
BASE="https://$AGENT_HOST:$P_AGENT/api/integration/1c-agents/v1"
REG=(--cert "$WORK/certs/registered.crt" --key "$WORK/certs/registered.key")
UNREG=(--cert "$WORK/certs/unregistered.crt" --key "$WORK/certs/unregistered.key")
SESSION_BODY="{\"agentId\":\"$AGENT_ID\",\"siteId\":\"e2e\",\"agentVersion\":\"1.2.0\"}"
code_of() { "$@" -o "$WORK/body" -w '%{http_code}' || true; }
for _ in $(seq 1 40); do [[ "$(code_of "${API[@]}" "https://$API_HOST:$P_API/api/v1/ping")" == 200 ]] && break; sleep 0.5; done

c="$(code_of "${AGENT[@]}" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 200 && "$(jq -r .accepted "$WORK/body")" == true ]]; check "registered certificate: session/start 200 accepted ($c)" "$?"
c="$(code_of "${AGENT[@]}" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\",\"version\":\"1.2.0\",\"state\":\"healthy\"}" "$BASE/heartbeat")"
rows="$(echo "SELECT count(*) FROM $SCHEMA.onec_agent_status WHERE agent_id='$AGENT_ID';" | psql_exec -At)"
[[ "$c" == 204 && "$rows" == 1 ]]; check "registered certificate: heartbeat 204 and stored in DB ($c, rows=$rows)" "$?"
c="$(code_of "${AGENT[@]}" "${UNREG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 403 && "$(jq -r .error.code "$WORK/body")" == CERT_UNKNOWN ]]; check "unregistered certificate: 403 CERT_UNKNOWN ($c)" "$?"
c="$(code_of "${AGENT[@]}" "${REG[@]}" -H 'X-Agent-Id: someone-else' -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 403 && "$(jq -r .error.code "$WORK/body")" == AGENT_CERT_MISMATCH ]]; check "forged X-Agent-Id: 403 AGENT_CERT_MISMATCH ($c)" "$?"
c="$(code_of "${API[@]}" "https://$API_HOST:$P_API/api/v1/ping")"
[[ "$c" == 200 ]]; check "regular API host works while the module is enabled ($c)" "$?"

# --- E2 command queue through the real ingress ---------------------------------------
code_of "${AGENT[@]}" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start" >/dev/null
SESSION_ID="$(jq -r .sessionId "$WORK/body")"
LEASE() { code_of "${AGENT[@]}" --max-time "$(( $1 + 20 ))" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"supportedCommandTypes\":[\"integration_probe\"],\"maxWaitSeconds\":$1}" "$BASE/commands/lease"; }
t0=$(date +%s); c="$(LEASE 70)"; t1=$(date +%s)
[[ "$c" == 200 && "$(jq -r .hasCommand "$WORK/body")" == false && $(( t1 - t0 )) -ge 68 ]]
check "empty long poll held ~70 s through Traefik and answered hasCommand=false ($c, $(( t1 - t0 )) s)" "$?"
CMD_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
CANON='{"marker":"E2E-\u0422\u0435\u0441\u0442"}'
HASH="$(printf '%s' "$CANON" | openssl dgst -sha256 -binary | base64)"
echo "INSERT INTO $SCHEMA.onec_agent_commands (command_id, agent_id, source_id, command_type, command_kind, payload_version, payload_canonical, payload_hash, payload_bytes, source_module, idempotency_key)
  SELECT '$CMD_ID', '$AGENT_ID', source_id, 'integration_probe', 'business', 1, '$CANON', '$HASH', ${#CANON}, 'e2e', 'e2e-$CMD_ID' FROM $SCHEMA.onec_agents WHERE agent_id = '$AGENT_ID';" | psql_exec
c="$(LEASE 20)"
[[ "$c" == 200 && "$(jq -r .command.commandId "$WORK/body")" == "$CMD_ID" ]] && grep -qF "\"payload\":$CANON}" "$WORK/body"
check "lease delivers the command with the canonical payload bytes verbatim ($c)" "$?"
LEASE_ID="$(jq -r .leaseId "$WORK/body")"
c="$(code_of "${AGENT[@]}" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' \
  -d "{\"leaseId\":\"$LEASE_ID\",\"payloadHash\":\"$HASH\"}" "$BASE/commands/$CMD_ID/received")"
[[ "$c" == 204 ]]; check "received 204 ($c)" "$?"
RESULT="{\"commandId\":\"$CMD_ID\",\"status\":\"succeeded\",\"resultVersion\":1,\"document\":{\"type\":\"integration_probe\"}}"
c1="$(code_of "${AGENT[@]}" "${REG[@]}" -X PUT -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$RESULT" "$BASE/commands/$CMD_ID/result")"
c2="$(code_of "${AGENT[@]}" "${REG[@]}" -X PUT -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$RESULT" "$BASE/commands/$CMD_ID/result")"
c3="$(code_of "${AGENT[@]}" "${REG[@]}" -X PUT -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "${RESULT/succeeded/dead_letter}" "$BASE/commands/$CMD_ID/result")"
stored="$(echo "SELECT status || '|' || (result_sha256 = encode(sha256(convert_to(result_body, 'UTF8')), 'hex'))::text FROM $SCHEMA.onec_agent_commands WHERE command_id = '$CMD_ID';" | psql_exec -At)"
[[ "$c1" == 204 && "$c2" == 204 && "$c3" == 409 && "$stored" == "succeeded|true" ]]
check "result stored byte for byte; same bytes 204, different 409 ($c1/$c2/$c3, $stored)" "$?"
c="$(code_of "${API[@]}" -H 'Content-Type: application/json' -H "X-Onec-Ingress-Auth: $SECRET" -H "X-Agent-Id: $AGENT_ID" \
  -d "$SESSION_BODY" "https://$API_HOST:$P_API/api/integration/1c-agents/v1/session/start")"
[[ "$c" == 404 ]]; check "agent API unreachable via the regular API host even with the secret ($c)" "$?"
echo "UPDATE $SCHEMA.onec_agent_certificates SET status='revoked', revoked_at=now();" | psql_exec
c="$(code_of "${AGENT[@]}" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 403 && "$(jq -r .error.code "$WORK/body")" == CERT_UNKNOWN ]]; check "revoked certificate refused on the very next request ($c)" "$?"
audits="$(echo "SELECT count(*) FROM $SCHEMA.audit_log WHERE event='onec.auth.denied';" | psql_exec -At)"
[[ "$audits" -ge 2 ]]; check "denials audited as onec.auth.denied ($audits rows)" "$?"

# Rollback: module disabled -> agent listener gone, regular API unaffected.
start_backend false
for _ in $(seq 1 40); do [[ "$(code_of "${API[@]}" "https://$API_HOST:$P_API/api/v1/ping")" == 200 ]] && break; sleep 0.5; done
c="$(code_of "${API[@]}" "https://$API_HOST:$P_API/api/v1/ping")"
[[ "$c" == 200 ]]; check "rollback: regular API host works with the module disabled ($c)" "$?"
c="$(code_of "${AGENT[@]}" "${REG[@]}" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" != 200 && "$c" != 204 ]]; check "rollback: agent API not served ($c)" "$?"

exit "$FAILED"

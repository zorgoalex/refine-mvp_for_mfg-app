#!/usr/bin/env bash
# Local end-to-end check of the 1C agent mTLS ingress through a REAL Traefik
# (same image, same file-provider TLS options, the exact router/middleware
# labels from ops/templates/docker-compose.vps.yml + docker-compose.onec-agent.yml).
# A throwaway echo container stands in for the backend (ports 3000/3001) and
# returns the headers Traefik forwarded. Nothing touches the running stacks:
# own compose project, own network, loopback-only ports, docker label constraint.
#
# Usage: ops/onec-agent-ingress-harness.sh            (prints PASS/FAIL lines; exit 1 on failure)
set -Euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PROJECT="onec-ingress-harness-$$"
SECRET="harness-ingress-secret-$(openssl rand -hex 16)"
API_HOST=api.harness.test
AGENT_HOST=onec.harness.test
P_WEB=18480 P_API=18443 P_AGENT=18843
FAILED=0

cleanup() {
  docker compose -p "$PROJECT" -f "$WORK/compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

check() { # name, condition-result (0 ok)
  if [[ "$2" == "0" ]]; then echo "PASS $1"; else echo "FAIL $1"; FAILED=1; fi
}

mkdir -p "$WORK/dynamic" "$WORK/certs"
cp "$REPO_DIR/ops/traefik/dynamic/onec-mtls.yml" "$WORK/dynamic/"
# Server certificate for the agent host (production uses Let's Encrypt).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -keyout "$WORK/certs/server.key" -out "$WORK/certs/server.crt" \
  -subj "/CN=$AGENT_HOST" -addext "subjectAltName=DNS:$AGENT_HOST,DNS:$API_HOST" >/dev/null 2>&1
cat > "$WORK/dynamic/harness-certs.yml" <<EOF
tls:
  certificates:
    - certFile: /etc/traefik/dynamic/server.crt
      keyFile: /etc/traefik/dynamic/server.key
EOF
cp "$WORK/certs/server.crt" "$WORK/certs/server.key" "$WORK/dynamic/"
# Agent client certificate (self-signed, as in production).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -keyout "$WORK/certs/client.key" -out "$WORK/certs/client.crt" -subj "/CN=harness-agent" >/dev/null 2>&1

python3 - "$REPO_DIR" "$WORK" "$SECRET" "$API_HOST" "$AGENT_HOST" "$P_WEB" "$P_API" "$P_AGENT" "$PROJECT" <<'PY'
import sys, yaml
repo, work, secret, api_host, agent_host, p_web, p_api, p_agent, project = sys.argv[1:]
vps = yaml.safe_load(open(f'{repo}/ops/templates/docker-compose.vps.yml'))
overlay = yaml.safe_load(open(f'{repo}/ops/templates/docker-compose.onec-agent.yml'))
subst = {'${BACKEND_FQDN}': api_host, '${ONEC_AGENT_FQDN}': agent_host, '${ONEC_INGRESS_SECRET}': secret,
         '${ONEC_AGENT_PORT:-3001}': '3001'}
import json, subprocess
json.dump(subst, open(f'{work}/subst.json', 'w'))
# Routes come from the SAME template labels, translated to the file provider.
subprocess.run(['python3', f'{repo}/ops/onec_ingress_labels_to_file.py', repo, f'{work}/dynamic/routes.yml', f'{work}/subst.json', 'backend'], check=True)
# No docker provider: the harness must stay invisible to, and independent of, the host's shared Traefik.
command = [c for c in vps['services']['traefik']['command'] if 'certificatesresolvers' not in c and not c.startswith('--providers.docker')]
command += ['--log.level=ERROR']
echo = """const http=require('http');for(const port of [3000,3001])http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({port,headers:q.headers}))}).listen(port)"""
compose = {
  'services': {
    'traefik': {'image': vps['services']['traefik']['image'], 'command': command,
                'ports': [f'127.0.0.1:{p_web}:80', f'127.0.0.1:{p_api}:443', f'127.0.0.1:{p_agent}:8443'],
                'volumes': [f'{work}/dynamic:/etc/traefik/dynamic:ro'], 'networks': ['edge']},
    'backend': {'image': 'node:20-bookworm-slim', 'command': ['node', '-e', echo], 'networks': ['edge']},
  },
  'networks': {'edge': {'name': f'{project}_edge'}},
}
yaml.safe_dump(compose, open(f'{work}/compose.yml', 'w'), sort_keys=False)
PY

docker compose -p "$PROJECT" -f "$WORK/compose.yml" up -d >/dev/null 2>&1
for _ in $(seq 1 40); do
  curl -sk --resolve "$API_HOST:$P_API:127.0.0.1" "https://$API_HOST:$P_API/x" -o /dev/null -w '%{http_code}' 2>/dev/null | grep -q 200 && break
  sleep 0.5
done

AGENT_CURL=(curl -s --cacert "$WORK/certs/server.crt" --resolve "$AGENT_HOST:$P_AGENT:127.0.0.1")
API_CURL=(curl -s --cacert "$WORK/certs/server.crt" --resolve "$API_HOST:$P_API:127.0.0.1")
AGENT_URL="https://$AGENT_HOST:$P_AGENT/api/integration/1c-agents/v1/heartbeat"

# 1. No client certificate -> TLS handshake refused.
"${AGENT_CURL[@]}" -o /dev/null "$AGENT_URL" && rc=1 || rc=0
check "agent host refuses TLS without a client certificate" "$rc"

# 2. Client certificate -> routed to backend port 3001 with Traefik-set trust headers.
body="$("${AGENT_CURL[@]}" --cert "$WORK/certs/client.crt" --key "$WORK/certs/client.key" "$AGENT_URL")"
[[ "$(jq -r .port <<<"$body")" == 3001 ]]; check "agent host routes to the agent listener (3001)" "$?"
[[ "$(jq -r '.headers["x-onec-ingress-auth"]' <<<"$body")" == "$SECRET" ]]; check "agent router adds the ingress secret" "$?"
expected_der="$(openssl x509 -in "$WORK/certs/client.crt" -outform DER | base64 -w0)"
forwarded="$(jq -r '.headers["x-forwarded-tls-client-cert"]' <<<"$body" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')"
[[ "$forwarded" == "$expected_der" ]]; check "agent router forwards the exact client certificate (base64 DER)" "$?"

# 3. Forged trust headers from the client are overwritten on the agent router.
body="$("${AGENT_CURL[@]}" --cert "$WORK/certs/client.crt" --key "$WORK/certs/client.key" \
  -H 'X-Onec-Ingress-Auth: forged' -H 'X-Forwarded-Tls-Client-Cert: forged' "$AGENT_URL")"
[[ "$(jq -r '.headers["x-onec-ingress-auth"]' <<<"$body")" == "$SECRET" ]]; check "agent router overwrites a forged ingress secret" "$?"
forwarded="$(jq -r '.headers["x-forwarded-tls-client-cert"]' <<<"$body" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')"
[[ "$forwarded" == "$expected_der" ]]; check "agent router overwrites a forged client-certificate header" "$?"

# 4. Regular API host: own service (3000), forged agent trust headers stripped, no client cert needed.
body="$("${API_CURL[@]}" -H 'X-Onec-Ingress-Auth: forged' -H 'X-Forwarded-Tls-Client-Cert: forged' \
  -H 'X-Forwarded-Tls-Client-Cert-Info: forged' "https://$API_HOST:$P_API/api/v1/health")"
[[ "$(jq -r .port <<<"$body")" == 3000 ]]; check "regular API host still routes to backend port 3000" "$?"
[[ "$(jq -r '.headers["x-onec-ingress-auth"] // "absent"' <<<"$body")" == absent ]]; check "regular API host strips X-Onec-Ingress-Auth" "$?"
[[ "$(jq -r '.headers["x-forwarded-tls-client-cert"] // "absent"' <<<"$body")" == absent ]]; check "regular API host strips X-Forwarded-Tls-Client-Cert" "$?"

# 5. The agent entrypoint serves only the agent host. Unknown SNI falls back to
#    Traefik's default TLS options (onec-mtls applies only to its router) and gets 404.
code="$("${AGENT_CURL[@]}" -k --resolve "other.harness.test:$P_AGENT:127.0.0.1" -o /dev/null -w '%{http_code}' \
  "https://other.harness.test:$P_AGENT/api/integration/1c-agents/v1/heartbeat" || true)"
[[ "$code" == 404 ]]; check "agent entrypoint answers 404 for an unknown host ($code)" "$?"
code="$("${API_CURL[@]}" --resolve "$API_HOST:$P_AGENT:127.0.0.1" -k --cert "$WORK/certs/client.crt" --key "$WORK/certs/client.key" \
  -o /dev/null -w '%{http_code}' "https://$API_HOST:$P_AGENT/api/v1/health" || true)"
[[ "$code" != 200 ]]; check "regular API host is not served on the agent entrypoint" "$?"

# 6. Traefik rate limit on the agent router.
# 200 requests, 25 in parallel: well above average=20/s, burst=50.
export HC_CA="$WORK/certs/server.crt" HC_CERT="$WORK/certs/client.crt" HC_KEY="$WORK/certs/client.key" HC_RESOLVE="$AGENT_HOST:$P_AGENT:127.0.0.1" HC_URL="$AGENT_URL"
codes="$(seq 1 200 | xargs -P 25 -I{} sh -c 'curl -s --cacert "$HC_CA" --resolve "$HC_RESOLVE" --cert "$HC_CERT" --key "$HC_KEY" -o /dev/null -w "%{http_code}\n" "$HC_URL" || true' | sort | uniq -c | tr '\n' ' ' || true)"
rc=1; [[ "$codes" == *" 429"* ]] && rc=0
check "agent router rate-limits bursts ($codes)" "$rc"

exit "$FAILED"

#!/usr/bin/env bash
# Live canary of an enabled 1C agent ingress (stage or production), run by the
# operator after deploy and after rollback. Read-only for business data: it
# opens one session and sends one heartbeat as a dedicated TEST agent.
#
# Prerequisites (UI «Интеграция 1С»): a test source + agent (e.g. agent id
# "e2e-canary-agent") with the canary certificate registered. The canary
# private key stays on the operator machine and is never committed.
#
# Usage:
#   ops/onec-agent-ingress-canary.sh --agent-host onec-agent-test.example.com[:8443] \
#     --api-host backend-test.example.com --agent-id e2e-canary-agent \
#     --cert canary.crt --key canary.key [--expect-disabled]
# --expect-disabled: rollback check (module off): regular API must work, the
# agent API must not answer 2xx.
set -Euo pipefail

AGENT_HOST="" API_HOST="" AGENT_ID="" CERT="" KEY="" EXPECT_DISABLED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-host) AGENT_HOST="$2"; shift 2 ;;
    --api-host) API_HOST="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --expect-disabled) EXPECT_DISABLED=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
[[ -n "$AGENT_HOST" && -n "$API_HOST" && -n "$AGENT_ID" && -f "$CERT" && -f "$KEY" ]] || { echo "usage: see header"; exit 2; }
[[ "$AGENT_HOST" == *:* ]] || AGENT_HOST="$AGENT_HOST:8443"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAILED=0
check() { if [[ "$2" == "0" ]]; then echo "PASS $1"; else echo "FAIL $1"; FAILED=1; fi; }
code_of() { curl -s --max-time 20 "$@" -o "$WORK/body" -w '%{http_code}' || true; }
BASE="https://$AGENT_HOST/api/integration/1c-agents/v1"
SESSION_BODY="{\"agentId\":\"$AGENT_ID\",\"siteId\":\"canary\",\"agentVersion\":\"99.0.0\"}"

c="$(code_of "https://$API_HOST/health/live")"
[[ "$c" == 200 ]]; check "regular backend host healthy ($c)" "$?"

if [[ "$EXPECT_DISABLED" == 1 ]]; then
  c="$(code_of --cert "$CERT" --key "$KEY" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
  [[ "$c" != 200 && "$c" != 204 ]]; check "module disabled: agent API not served ($c)" "$?"
  exit "$FAILED"
fi

curl -s --max-time 20 -o /dev/null "$BASE/session/start" && rc=1 || rc=0
check "TLS without a client certificate is refused" "$rc"

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -keyout "$WORK/u.key" -out "$WORK/u.crt" \
  -subj "/CN=onec-canary-unregistered" >/dev/null 2>&1
c="$(code_of --cert "$WORK/u.crt" --key "$WORK/u.key" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 403 ]]; check "unregistered certificate refused ($c $(jq -r '.error.code // empty' "$WORK/body" 2>/dev/null))" "$?"

c="$(code_of --cert "$CERT" --key "$KEY" -H 'X-Agent-Id: canary-forged' -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 403 ]]; check "forged X-Agent-Id refused ($c)" "$?"

c="$(code_of --cert "$CERT" --key "$KEY" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" "$BASE/session/start")"
[[ "$c" == 200 ]]; check "registered certificate: session/start ($c, accepted=$(jq -r '.accepted // empty' "$WORK/body" 2>/dev/null))" "$?"

c="$(code_of --cert "$CERT" --key "$KEY" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\",\"version\":\"99.0.0\",\"state\":\"healthy\",\"stateReason\":\"CANARY\"}" "$BASE/heartbeat")"
[[ "$c" == 204 ]]; check "registered certificate: heartbeat ($c)" "$?"

c="$(code_of -H "X-Onec-Ingress-Auth: forged" -H "X-Agent-Id: $AGENT_ID" -H 'Content-Type: application/json' -d "$SESSION_BODY" \
  "https://$API_HOST/api/integration/1c-agents/v1/session/start")"
[[ "$c" == 404 ]]; check "agent API not reachable through the regular backend host ($c)" "$?"

exit "$FAILED"

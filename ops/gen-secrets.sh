#!/usr/bin/env bash
# gen-secrets.sh — fill cryptographic REPLACE_ME placeholders in .env.
# Idempotent: replaces a token only while it is still the placeholder. Leaves
# operator-only fields (FQDNs, email, TWENTY_TAG, TWENTY_SYNC_API_KEY) alone.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env"
[ "${1:-}" = "--env-file" ] && { ENV_FILE="${2:?}"; shift 2; }
[ -f "$ENV_FILE" ] || { echo "gen-secrets: .env not found: $ENV_FILE" >&2; exit 1; }

# token -> freshly generated value; one global replace per token (only acts on
# placeholders, so a re-run with no placeholders left changes nothing).
declare -A MAP=(
  [REPLACE_ME_MAIN_DB_PASSWORD]="$(openssl rand -hex 32)"
  [REPLACE_ME_HASURA_METADATA_DB_PASSWORD]="$(openssl rand -hex 32)"
  [REPLACE_ME_HASURA_ADMIN_SECRET]="$(openssl rand -hex 32)"
  [REPLACE_ME_SHARED_JWT_SECRET_AT_LEAST_32_CHARS]="$(openssl rand -hex 32)"
  [REPLACE_ME_REFRESH_TOKEN_PEPPER_AT_LEAST_32_CHARS]="$(openssl rand -hex 32)"
  [REPLACE_ME_CAD_TOKEN_openssl_rand_hex_32]="$(openssl rand -hex 32)"
  [REPLACE_ME_TWENTY_DB_PASSWORD_NO_SPECIAL_CHARS]="$(openssl rand -hex 24)"
  [REPLACE_ME_TWENTY_ENCRYPTION_KEY]="$(openssl rand -base64 32)"
)

# Escape replacement for sed (slashes, ampersands, backslashes).
sed_escape() { printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'; }

tmp="$(mktemp)"; cp "$ENV_FILE" "$tmp"
for tok in "${!MAP[@]}"; do
  val="$(sed_escape "${MAP[$tok]}")"
  sed -i "s/${tok}/${val}/g" "$tmp"
done

# CAD basic-auth: replace the whole line only if still a placeholder.
if grep -q '^CAD_BASICAUTH_USERS=.*REPLACE' "$tmp"; then
  CAD_PW="$(openssl rand -hex 12)"
  APR1="$(openssl passwd -apr1 "$CAD_PW")"
  APR1_ESC="$(printf '%s' "$APR1" | sed 's/\$/$$/g')"   # double $ for compose
  APR1_ESC="$(sed_escape "$APR1_ESC")"
  sed -i "s|^CAD_BASICAUTH_USERS=.*|CAD_BASICAUTH_USERS=cad:${APR1_ESC}|" "$tmp"
  CAD_NOTICE="$CAD_PW"
fi

mv "$tmp" "$ENV_FILE"

echo "gen-secrets: cryptographic secrets filled in $ENV_FILE"
[ -n "${CAD_NOTICE:-}" ] && {
  echo "  >> CAD UI basic-auth login: cad / ${CAD_NOTICE}"
  echo "     SAVE THIS NOW — it cannot be recovered from the stored hash."
}
echo "  Still for the operator (not auto-filled):"
echo "   - all *_FQDN, FRONTEND_ORIGIN, *_CORS*, LETSENCRYPT_EMAIL, TWENTY_SERVER_URL"
echo "   - TWENTY_TAG (immutable release tag), TWENTY_SYNC_API_KEY (Twenty workspace key)"
echo "   - optional GAS_*/VLM_*/AUTH0_* if those integrations are used"

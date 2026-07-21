import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const compose = readFileSync(resolve(root, 'ops/ui-redesign/docker-compose.yml'), 'utf8');
const cloneScript = readFileSync(resolve(root, 'ops/ui-redesign/clone-current-data.sh'), 'utf8');
const nginx = readFileSync(resolve(root, 'ops/ui-redesign/nginx.conf'), 'utf8');
const runtime = JSON.parse(
  readFileSync(resolve(root, 'ops/ui-redesign/runtime-config.json'), 'utf8'),
) as { apiUrl?: string; ui?: { evolutionEnabled?: boolean; forceLegacy?: boolean } };

describe('UI redesign review-stack isolation guard', () => {
  it('uses review-only auth secrets and a distinct API/cookie path', () => {
    expect(compose).toContain('JWT_ACCESS_SECRET: ${UI_REDESIGN_JWT_SECRET');
    expect(compose).toContain('REFRESH_TOKEN_PEPPER: ${UI_REDESIGN_REFRESH_TOKEN_PEPPER');
    expect(compose).toContain('HASURA_GRAPHQL_ADMIN_SECRET: ${UI_REDESIGN_HASURA_ADMIN_SECRET');
    expect(compose).toContain('API_PREFIX: /api/v1');
    expect(compose).not.toContain('JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET');
    expect(nginx).toContain('location /ui-redesign/api/v1/');
    expect(nginx).toContain('proxy_pass http://backend:3000/api/v1/;');
    expect(nginx).toContain('proxy_cookie_path /api/v1/auth /ui-redesign/api/v1/auth;');
    expect(runtime.apiUrl).toBe('/ui-redesign');
  });

  it('binds only the frontend to the explicit Tailscale address', () => {
    expect(compose).toContain('${PG_TAILSCALE_BIND_IP:?Tailscale bind IP is required}:4174:80');
    expect(compose).not.toContain('0.0.0.0:4174');
    expect(compose).toContain('127.0.0.1:3301:3000');
    expect(compose).toContain('127.0.0.1:8586:8080');
    expect(compose).toContain('internal: true');
  });

  it('pins and validates source containers before cloning', () => {
    expect(cloneScript).toContain('readonly SOURCE_POSTGRES_CONTAINER="erp_test-postgresdb-1"');
    expect(cloneScript).toContain('readonly SOURCE_METADATA_CONTAINER="erp_test-hasura_metadata_db-1"');
    expect(cloneScript).toContain('if [[ "${project}" != "erp_test" || "${state}" != "running" ]]');
    expect(cloneScript).toContain('test "$POSTGRES_DB" = "$EXPECTED_DB"');
  });

  it('removes copied auth sessions after restoring the snapshot', () => {
    expect(cloneScript).toContain('DELETE FROM refresh_tokens; DELETE FROM auth_sessions;');
    expect(cloneScript).toContain('UI_REDESIGN_JWT_SECRET=${jwt_secret}');
    expect(cloneScript).toContain('chmod 600 "${SECRETS_FILE}"');
  });

  it('forces evolution only inside the branch-local review runtime', () => {
    expect(runtime.ui).toEqual({ evolutionEnabled: true, forceLegacy: false });
  });
});

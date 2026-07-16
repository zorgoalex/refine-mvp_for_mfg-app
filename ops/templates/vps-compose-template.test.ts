import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

function readTemplate(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('VPS compose backend runtime flags', () => {
  it('passes the Bazis-cut flag with a safe default and documents activation', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');
    const localCompose = readTemplate('backend/docker-compose.yml');
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(compose).toContain('BACKEND_ENABLE_BAZIS_CUT: ${BACKEND_ENABLE_BAZIS_CUT:-false}');
    expect(localCompose).toContain('BACKEND_ENABLE_BAZIS_CUT: ${BACKEND_ENABLE_BAZIS_CUT:-false}');
    expect(envExample).toContain('BACKEND_ENABLE_BAZIS_CUT=false');
  });

  it('passes Groups feature flags to the backend container with safe defaults', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');

    expect(compose).toContain('BACKEND_ENABLE_GROUPS: ${BACKEND_ENABLE_GROUPS:-false}');
    expect(compose).toContain('BACKEND_GROUPS_READ_ONLY: ${BACKEND_GROUPS_READ_ONLY:-true}');
    expect(compose).toContain(
      'BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE: ${BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE:-false}',
    );
    expect(compose).toContain(
      'BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS: ${BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS:-false}',
    );
  });

  it('documents Groups feature flags in the VPS env example with safe defaults', () => {
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(envExample).toContain('BACKEND_ENABLE_GROUPS=false');
    expect(envExample).toContain('BACKEND_GROUPS_READ_ONLY=true');
    expect(envExample).toContain('BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE=false');
    expect(envExample).toContain('BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS=false');
  });

  it('passes status automation through and documents its default-off behavior', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(compose).toContain(
      'BACKEND_STATUS_AUTOMATION: ${BACKEND_STATUS_AUTOMATION:-false}',
    );
    expect(envExample).toContain('# событийные автостатусы, движок off by default');
    expect(envExample).toContain('BACKEND_STATUS_AUTOMATION=false');
  });

  it('publishes the CAD service on a public traefik subdomain with internal access', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');

    expect(compose).toContain('cad-service:');
    expect(compose).toContain('context: ${CAD_BUILD_CONTEXT:-./repo_svgdxf}');
    expect(compose).toContain('traefik.http.routers.cad.rule=Host(`${CAD_FQDN}`)');
    expect(compose).toContain('traefik.http.services.cad.loadbalancer.server.port=8000');
    expect(compose).toContain('CAD_SERVICE_TRUST_PROXY_HEADERS: ${CAD_SERVICE_TRUST_PROXY_HEADERS:-1}');
    expect(compose).toContain('CAD_SERVICE_BASE_URL: ${CAD_SERVICE_BASE_URL:-http://cad-service:8000}');
  });

  it('documents the CAD service env vars in the VPS env example', () => {
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(envExample).toContain('CAD_FQDN=cad-test.example.com');
    expect(envExample).toContain('CAD_BUILD_CONTEXT=./repo_svgdxf');
    expect(envExample).toContain('CAD_SERVICE_TRUST_PROXY_HEADERS=1');
    expect(envExample).toContain('CAD_SERVICE_BASE_URL=http://cad-service:8000');
  });
});

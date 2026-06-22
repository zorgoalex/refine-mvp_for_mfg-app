import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

function readTemplate(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('VPS compose backend runtime flags', () => {
  it('passes Projects feature flags to the backend container with safe defaults', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');

    expect(compose).toContain('BACKEND_ENABLE_PROJECTS: ${BACKEND_ENABLE_PROJECTS:-false}');
    expect(compose).toContain('BACKEND_PROJECTS_READ_ONLY: ${BACKEND_PROJECTS_READ_ONLY:-true}');
    expect(compose).toContain(
      'BACKEND_ENABLE_PROJECT_P8_NOTIFICATIONS: ${BACKEND_ENABLE_PROJECT_P8_NOTIFICATIONS:-false}',
    );
  });

  it('documents Projects feature flags in the VPS env example with safe defaults', () => {
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(envExample).toContain('BACKEND_ENABLE_PROJECTS=false');
    expect(envExample).toContain('BACKEND_PROJECTS_READ_ONLY=true');
    expect(envExample).toContain('BACKEND_ENABLE_PROJECT_P8_NOTIFICATIONS=false');
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

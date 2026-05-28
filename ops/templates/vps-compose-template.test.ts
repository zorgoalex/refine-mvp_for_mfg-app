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
  });

  it('documents Projects feature flags in the VPS env example with safe defaults', () => {
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(envExample).toContain('BACKEND_ENABLE_PROJECTS=false');
    expect(envExample).toContain('BACKEND_PROJECTS_READ_ONLY=true');
  });
});

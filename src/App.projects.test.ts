import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('App projects gating', () => {
  it('registers projects resource and route by flag so auth changes cannot stale-hide them', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('...(featureFlags.useBackendProjects');
    expect(source).toContain('{featureFlags.useBackendProjects && (');
    expect(source).not.toContain('const projectsFrontendEnabled = canUseBackendProjects(');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('App groups gating', () => {
  it('registers groups resource and route by flag so auth changes cannot stale-hide them', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('...(featureFlags.useBackendGroups');
    expect(source).toContain('{featureFlags.useBackendGroups && (');
    expect(source).not.toContain('const groupsFrontendEnabled = canUseBackendGroups(');
  });
});

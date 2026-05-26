import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('App projects gating', () => {
  it('uses the combined projects flag and permission gate for resource and route wiring', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const projectsFrontendEnabled = canUseBackendProjects(');
    expect(source).toContain('...(projectsFrontendEnabled');
    expect(source).toContain('{projectsFrontendEnabled && (');
    expect(source).not.toContain('...(featureFlags.useBackendProjects');
    expect(source).not.toContain('{featureFlags.useBackendProjects && (');
  });
});

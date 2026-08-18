import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./useAppSettings.ts', import.meta.url), 'utf8');

describe('useAppSettings guard', () => {
  it('bypasses browser cache for app_settings reads used by MDF board rules', () => {
    expect(source).toContain("meta: { fetchOptions: { cache: 'no-store' } }");
  });
});

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('dirty registry owns the single beforeunload', () => {
  it('installs exactly one beforeunload listener (only in useGlobalUnloadGuard)', () => {
    const src = readFileSync(resolve(__dirname, 'useTabDirty.ts'), 'utf8');
    expect((src.match(/addEventListener\(['"]beforeunload/g) || []).length).toBe(1);
  });
  it('useTabDirty bridges into the registry via setDirty', () => {
    const src = readFileSync(resolve(__dirname, 'useTabDirty.ts'), 'utf8');
    const bridge = src.slice(
      src.indexOf('export const useTabDirty'),
      src.indexOf('export const useGlobalUnloadGuard'),
    );
    expect(bridge).toContain('setDirty');
    expect(bridge).not.toContain('addEventListener');
  });
});

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, 'useTabSync.ts'), 'utf8');

describe('useTabSync guards', () => {
  it('ignores redirect-only / non-tab routes', () => {
    expect(src).toContain("['/', '/login']");
  });
  it('preserves query in the stored path', () => {
    expect(src).toContain('location.search');
  });
  it('rehydrates the authenticated user before opening the current route', () => {
    expect(src.indexOf('syncWorkspaceTabsForCurrentUser();')).toBeGreaterThan(-1);
    expect(src.indexOf('syncWorkspaceTabsForCurrentUser();')).toBeLessThan(src.indexOf('openTab({'));
  });
  it('records the opener key from the previous workspace tab for newly opened tabs', () => {
    expect(src).toContain('previousTabKeyRef');
    expect(src).toContain('previousTabKeyRef.current = null');
    expect(src).toContain('resolveTabOpenerKey(tabsBeforeOpen, location.pathname, previousTabKeyRef.current)');
    expect(src).toContain('openerKey,');
  });
});

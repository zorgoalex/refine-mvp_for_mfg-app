import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, 'list.tsx'), 'utf8');

describe('orders list keep-alive gating', () => {
  it('reads isActive from KeepAliveContext', () => {
    expect(src).toContain('useKeepAlive()');
    expect(src).toContain('const { isActive }');
  });
  it('every query hook is gated on isActive', () => {
    const hookCalls = (src.match(/use(Table|List|Many|Select)\(/g) || []).length;
    const gated = (src.match(/enabled:\s*isActive/g) || []).length;
    // useAppSettings is gated via its own arg; count it separately
    expect(src).toContain('useAppSettings({ enabled: isActive })');
    expect(gated).toBeGreaterThanOrEqual(hookCalls);
  });
  it('disables refetchOnWindowFocus on the main table', () => {
    expect(src).toContain('refetchOnWindowFocus: false');
  });
});

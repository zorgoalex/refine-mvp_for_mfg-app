import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, 'list.tsx'), 'utf8');

describe('orders list keep-alive gating', () => {
  it('reads isActive from KeepAliveContext', () => {
    expect(src).toContain('useKeepAlive()');
    expect(src).toContain('const { isActive }');
  });
  it('routes Refine reads through the treatment-aware lifecycle wrappers', () => {
    expect(src).toContain('from "../../query/orderLifecycleQueries"');
    expect(src).toContain('useCancelInactiveOrderQueriesOnDeactivate()');
    expect(src).toContain('enabled: isActive && ordinaryReadActive');
  });
  it('prevents a hidden list from writing its table state into the active route', () => {
    expect(src).toContain('syncWithLocation: isActive');
  });
  it('disables refetchOnWindowFocus on the main table', () => {
    expect(src).toContain('refetchOnWindowFocus: false');
  });
});

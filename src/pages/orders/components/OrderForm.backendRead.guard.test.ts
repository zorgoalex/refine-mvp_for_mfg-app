import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./OrderForm.tsx', import.meta.url), 'utf8');

describe('OrderForm backend-read ownership', () => {
  it('guards store publication and delayed initialization by auth, resource and lifecycle', () => {
    expect(source).toContain('useOrderAsyncReadGuard(');
    expect(source).toContain('`order-form-backend-load:${orderId ?? \'new\'}`');
    expect(source).toContain('const loadToken = backendOrderLoadGuard.capture()');
    expect(source).toContain('canPublish: () => backendOrderLoadGuard.isCurrent(loadToken)');
    expect(source).toMatch(/setTimeout\(\(\) => \{[\s\S]*backendOrderLoadGuard\.isCurrent\(loadToken\)/);
    expect(source).toContain('backendOrderLoadingState?.scopeKey === backendOrderLoadScopeKey');
  });

  it('resets an existing draft before paint when the auth namespace changes', () => {
    expect(source).toContain('useLayoutEffect(() => {');
    expect(source).toContain('prevAuthNamespaceRef.current === authCacheNamespace');
    expect(source).toContain('reset();');
    expect(source).toContain('didInit.current = false;');
  });

  it('guards create-form auxiliary reads before state or draft publication', () => {
    expect(source).toContain('useOrderAsyncReadGuard(projectOptionsResourceScope)');
    expect(source).toContain('projectOptionsState?.scopeKey === projectOptionsScopeKey');
    expect(source).toContain('projectOptionsReadGuard.isCurrent(token)');
    expect(source).toContain('const nameHintToken = bazisNameHintGuard.capture()');
    expect(source).toMatch(/ordersApi\.list\([\s\S]*bazisNameHintGuard\.isCurrent\(nameHintToken\)/);
    expect(source).toMatch(/store\.updateHeaderField\('order_name', next\)/);
    expect(source).toContain('deadlineDefaultsGuard.isCurrent(token)');
  });
});

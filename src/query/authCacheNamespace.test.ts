import { beforeEach, describe, expect, it } from 'vitest';
import { authSession } from '../api/authSession';
import { appQueryClient } from './appQueryClient';
import { getAuthCacheNamespace } from './authCacheNamespace';
import type { AuthorizationPolicyScopes, AuthorizationScope } from '../types/auth';

describe('auth cache namespace', () => {
  beforeEach(() => {
    authSession.clear();
    appQueryClient.clear();
  });

  it('changes on actor/scope transition but survives token refresh', () => {
    authSession.setUser({ id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] });
    const first = getAuthCacheNamespace('backend');
    authSession.setAccessToken('token-a');
    authSession.setAccessToken('token-b');
    expect(getAuthCacheNamespace('backend')).toBe(first);

    authSession.setUser({ id: '7', username: 'a', role: 'admin', permissions: ['orders.update'] });
    expect(getAuthCacheNamespace('backend')).not.toBe(first);
  });

  it('clears shared query cache before logout namespace becomes inaccessible', () => {
    authSession.setUser({ id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] });
    appQueryClient.setQueryData(['private'], { order: 42 });
    appQueryClient.setQueryData(['auth', 'check'], { authenticated: true });
    authSession.clear();
    expect(appQueryClient.getQueryData(['private'])).toBeUndefined();
    expect(appQueryClient.getQueryData(['auth', 'check'])).toEqual({ authenticated: true });
  });

  it('clears cache and changes namespace when backend policy scope changes', () => {
    authSession.setUser({
      id: '7',
      username: 'a',
      role: 'manager',
      permissions: ['orders.view'],
      permissionsVersion: 10,
      policyScopes: policyWithOrderView('all'),
    });
    appQueryClient.setQueryData(['private-order'], { order: 42 });
    const broadNamespace = getAuthCacheNamespace('backend');

    authSession.setUser({
      id: '7',
      username: 'a',
      role: 'manager',
      permissions: ['orders.view'],
      permissionsVersion: 11,
      policyScopes: policyWithOrderView('own'),
    });

    expect(appQueryClient.getQueryData(['private-order'])).toBeUndefined();
    expect(getAuthCacheNamespace('backend')).not.toBe(broadNamespace);
  });

  it('cancels an actor A read before actor B can observe a late publication', async () => {
    authSession.setUser({ id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] });
    const actorAKey = ['order', getAuthCacheNamespace('backend'), 42] as const;
    let resolveActorA!: (value: { order: number }) => void;
    const actorARead = appQueryClient.fetchQuery({
      queryKey: actorAKey,
      queryFn: () => new Promise<{ order: number }>((resolve) => {
        resolveActorA = resolve;
      }),
    });

    authSession.clear();
    authSession.setUser({ id: '8', username: 'b', role: 'admin', permissions: ['orders.view'] });
    const actorBKey = ['order', getAuthCacheNamespace('backend'), 42] as const;
    resolveActorA({ order: 42 });
    await actorARead.catch(() => undefined);

    expect(actorBKey).not.toEqual(actorAKey);
    expect(appQueryClient.getQueryData(actorAKey)).toBeUndefined();
    expect(appQueryClient.getQueryData(actorBKey)).toBeUndefined();
  });
});

function policyWithOrderView(view: AuthorizationScope): AuthorizationPolicyScopes {
  return {
    orders: { view, update: 'none', export: 'none', delete: 'none' },
    payments: { view: 'none', create: 'none', update: 'none', delete: 'none' },
    productionTasks: { view: 'none', update: 'none' },
  };
}

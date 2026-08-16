import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from './authSession';

describe('authSession subscriptions', () => {
  beforeEach(() => {
    authSession.clear();
  });

  it('notifies listeners when access token changes', () => {
    const listener = vi.fn();
    const unsubscribe = authSession.subscribe(listener);

    authSession.setAccessToken('token-1');

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    authSession.setAccessToken('token-2');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies listeners when user changes or session clears', () => {
    const listener = vi.fn();
    const unsubscribe = authSession.subscribe(listener);

    authSession.setUser({ id: '1', username: 'admin', role: 'admin' });
    authSession.clear();

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('advances token version when an already-empty session is invalidated', () => {
    authSession.clear();
    const before = authSession.getAccessTokenVersion();

    authSession.clear();

    expect(authSession.getAccessTokenVersion()).toBe(before + 1);
  });

  it('notifies subscribers when an already-empty session is invalidated', () => {
    authSession.clear();
    const listener = vi.fn();
    const unsubscribe = authSession.subscribe(listener);

    authSession.clear();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('advances session generation only across identity boundaries and explicit clear', () => {
    const initial = authSession.getSessionGeneration();
    authSession.setUser({
      id: '1',
      username: 'admin',
      role: 'admin',
      permissions: ['orders.view'],
    });
    const actorOne = authSession.getSessionGeneration();
    expect(actorOne).toBe(initial + 1);

    authSession.setAccessToken('token-1');
    authSession.setAccessToken('token-2');
    authSession.setUser({
      id: '1',
      username: 'renamed-admin',
      role: 'admin',
      permissions: ['orders.view'],
    });
    expect(authSession.getSessionGeneration()).toBe(actorOne);

    authSession.setUser({
      id: '1',
      username: 'renamed-admin',
      role: 'admin',
      permissions: ['orders.update'],
    });
    expect(authSession.getSessionGeneration()).toBe(actorOne + 1);

    authSession.clear();
    expect(authSession.getSessionGeneration()).toBe(actorOne + 2);
  });

  it('notifies expiry listeners only for an expired session', () => {
    const listener = vi.fn();
    const unsubscribe = authSession.subscribeExpired(listener);

    authSession.clear();
    expect(listener).not.toHaveBeenCalled();

    authSession.expire();
    expect(listener).toHaveBeenCalledTimes(1);
    authSession.expire();
    expect(listener).toHaveBeenCalledTimes(1);

    authSession.setAccessToken('new-session');
    authSession.expire();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    authSession.setAccessToken('newer-session');
    authSession.expire();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

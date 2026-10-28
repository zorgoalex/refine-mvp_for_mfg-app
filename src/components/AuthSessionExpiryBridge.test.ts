import { describe, expect, it, vi } from 'vitest';
import {
  consumeSessionExpiredNotice,
  redirectExpiredAuthSession,
  SESSION_EXPIRED_NOTICE_KEY,
  watchAuthSessionExpiry,
} from './AuthSessionExpiryBridge';

describe('AuthSessionExpiryBridge', () => {
  it('hard-redirects an expired authenticated page to login', () => {
    const replace = vi.fn();

    redirectExpiredAuthSession({ pathname: '/order-status-board', replace });

    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('does not redirect again when login is already open', () => {
    const replace = vi.fn();

    redirectExpiredAuthSession({ pathname: '/login', replace });

    expect(replace).not.toHaveBeenCalled();
  });
});

describe('session-expired notice', () => {
  const fakeSession = () => {
    let user: unknown = { id: 7 };
    const clear = new Set<(t: { reason: 'identity' | 'clear' }) => void>();
    const expired = new Set<() => void>();
    return {
      api: {
        getUser: () => user as never,
        subscribeBeforeClear: (l: never) => { clear.add(l); return () => clear.delete(l); },
        subscribeExpired: (l: () => void) => { expired.add(l); return () => expired.delete(l); },
      },
      /** what authSession.expire() does: clear (listeners see the user), then the expiry listeners */
      expire() { clear.forEach((l) => l({ reason: 'clear' })); user = null; expired.forEach((l) => l()); },
      logout() { clear.forEach((l) => l({ reason: 'clear' })); user = null; },
    };
  };

  it('is raised only when a signed-in session expires', async () => {
    const session = fakeSession();
    const seen: boolean[] = [];
    watchAuthSessionExpiry(session.api, (wasSignedIn) => seen.push(wasSignedIn));
    session.expire();
    session.expire();
    expect(seen).toEqual([true, false]);
  });

  it('a logout followed later by an expiry is not an expired session', async () => {
    const session = fakeSession();
    const seen: boolean[] = [];
    watchAuthSessionExpiry(session.api, (wasSignedIn) => seen.push(wasSignedIn));
    session.logout();
    await Promise.resolve();
    session.expire();
    expect(seen).toEqual([false]);
  });

  it('the login page reads the flag once', () => {
    const store = new Map<string, string>([[SESSION_EXPIRED_NOTICE_KEY, '1']]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    expect(consumeSessionExpiredNotice(storage)).toBe(true);
    expect(consumeSessionExpiredNotice(storage)).toBe(false);
    expect(consumeSessionExpiredNotice(null)).toBe(false);
  });
});

import { useEffect } from 'react';
import { authSession } from '../api/authSession';

interface ExpiryLocation {
  pathname: string;
  replace(url: string): void;
}

/** One-shot flag for the login page: «Сессия истекла» (set only when a signed-in session expired). */
export const SESSION_EXPIRED_NOTICE_KEY = 'erp.auth.sessionExpiredNotice';

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const sessionStore = (): NoticeStorage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export function redirectExpiredAuthSession(location: ExpiryLocation): void {
  if (location.pathname !== '/login') {
    location.replace('/login');
  }
}

/** Read and clear the flag (the login page shows the notice once). */
export function consumeSessionExpiredNotice(storage: NoticeStorage | null = sessionStore()): boolean {
  if (!storage) return false;
  try {
    const raised = storage.getItem(SESSION_EXPIRED_NOTICE_KEY) === '1';
    storage.removeItem(SESSION_EXPIRED_NOTICE_KEY);
    return raised;
  } catch {
    return false;
  }
}

/**
 * Expiry listeners: `expire()` clears the session first, so whether a user was signed in is taken from the
 * clear that `expire()` runs synchronously. A first visit without a session or a repeated expiry leaves no
 * notice; a plain logout never calls `expire()`.
 */
export function watchAuthSessionExpiry(
  session: Pick<typeof authSession, 'getUser' | 'subscribeBeforeClear' | 'subscribeExpired'>,
  onExpired: (wasSignedIn: boolean) => void,
): () => void {
  let signedInAtClear = false;
  const offClear = session.subscribeBeforeClear((transition) => {
    if (transition.reason !== 'clear') return;
    signedInAtClear = session.getUser() !== null;
    queueMicrotask(() => { signedInAtClear = false; });
  });
  const offExpired = session.subscribeExpired(() => {
    const wasSignedIn = signedInAtClear;
    signedInAtClear = false;
    onExpired(wasSignedIn);
  });
  return () => {
    offClear();
    offExpired();
  };
}

export function AuthSessionExpiryBridge() {
  useEffect(
    () => watchAuthSessionExpiry(authSession, (wasSignedIn) => {
      if (wasSignedIn) {
        try {
          sessionStore()?.setItem(SESSION_EXPIRED_NOTICE_KEY, '1');
        } catch {
          /* приватный режим: просто без уведомления */
        }
      }
      redirectExpiredAuthSession(window.location);
    }),
    [],
  );

  return null;
}

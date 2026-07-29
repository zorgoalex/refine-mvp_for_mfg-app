import { useEffect } from 'react';
import { authSession } from '../api/authSession';

interface ExpiryLocation {
  pathname: string;
  replace(url: string): void;
}

export function redirectExpiredAuthSession(location: ExpiryLocation): void {
  if (location.pathname !== '/login') {
    location.replace('/login');
  }
}

export function AuthSessionExpiryBridge() {
  useEffect(
    () => authSession.subscribeExpired(() => {
      redirectExpiredAuthSession(window.location);
    }),
    [],
  );

  return null;
}

import type { UserIdentity } from '../types/auth';
import { getUserAuthorizationScopeKey } from './authScopeIdentity';

let accessToken: string | null = null;
let accessTokenVersion = 0;
let sessionGeneration = 0;
let currentUser: UserIdentity | null = null;
let currentIdentityScopeKey = '';
let expired = false;
const listeners = new Set<() => void>();
const expiredListeners = new Set<() => void>();
const beforeClearListeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

export const authSession = {
  getAccessToken(): string | null {
    return accessToken;
  },

  setAccessToken(token: string | null): void {
    if (accessToken === token) return;
    accessToken = token;
    if (token) expired = false;
    accessTokenVersion += 1;
    notifyListeners();
  },

  getAccessTokenVersion(): number {
    return accessTokenVersion;
  },

  getSessionGeneration(): number {
    return sessionGeneration;
  },

  getUser(): UserIdentity | null {
    return currentUser;
  },

  setUser(user: UserIdentity | null): void {
    const nextIdentityScopeKey = identityScopeKey(user);
    if (currentUser === user && currentIdentityScopeKey === nextIdentityScopeKey) return;
    if (currentIdentityScopeKey !== nextIdentityScopeKey) {
      beforeClearListeners.forEach((listener) => listener());
      sessionGeneration += 1;
    }
    currentUser = user;
    currentIdentityScopeKey = nextIdentityScopeKey;
    notifyListeners();
  },

  clear(): void {
    // Clearing is also an explicit invalidation boundary for any in-flight
    // refresh, even when local state is already empty (cookie-only bootstrap).
    accessTokenVersion += 1;
    beforeClearListeners.forEach((listener) => listener());
    sessionGeneration += 1;
    accessToken = null;
    currentUser = null;
    currentIdentityScopeKey = '';
    notifyListeners();
  },

  expire(): void {
    this.clear();
    if (expired) return;
    expired = true;
    expiredListeners.forEach((listener) => listener());
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  subscribeExpired(listener: () => void): () => void {
    expiredListeners.add(listener);
    return () => {
      expiredListeners.delete(listener);
    };
  },

  subscribeBeforeClear(listener: () => void): () => void {
    beforeClearListeners.add(listener);
    return () => {
      beforeClearListeners.delete(listener);
    };
  },
};

function identityScopeKey(user: UserIdentity | null): string {
  if (!user) return '';
  return JSON.stringify([user.id, getUserAuthorizationScopeKey(user)]);
}

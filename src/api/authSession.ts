import type { UserIdentity } from '../types/auth';

let accessToken: string | null = null;
let accessTokenVersion = 0;
let currentUser: UserIdentity | null = null;
const listeners = new Set<() => void>();

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
    accessTokenVersion += 1;
    notifyListeners();
  },

  getAccessTokenVersion(): number {
    return accessTokenVersion;
  },

  getUser(): UserIdentity | null {
    return currentUser;
  },

  setUser(user: UserIdentity | null): void {
    if (currentUser === user) return;
    currentUser = user;
    notifyListeners();
  },

  clear(): void {
    // Clearing is also an explicit invalidation boundary for any in-flight
    // refresh, even when local state is already empty (cookie-only bootstrap).
    accessTokenVersion += 1;
    if (!accessToken && !currentUser) return;
    accessToken = null;
    currentUser = null;
    notifyListeners();
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

import type { UserIdentity } from '../types/auth';

let accessToken: string | null = null;
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
    notifyListeners();
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

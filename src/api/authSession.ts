import type { UserIdentity } from '../types/auth';

let accessToken: string | null = null;
let currentUser: UserIdentity | null = null;

export const authSession = {
  getAccessToken(): string | null {
    return accessToken;
  },

  setAccessToken(token: string | null): void {
    accessToken = token;
  },

  getUser(): UserIdentity | null {
    return currentUser;
  },

  setUser(user: UserIdentity | null): void {
    currentUser = user;
  },

  clear(): void {
    accessToken = null;
    currentUser = null;
  },
};

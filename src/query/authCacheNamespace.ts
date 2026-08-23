import { useSyncExternalStore } from 'react';
import { authSession } from '../api/authSession';
import { getUserAuthorizationScopeKey } from '../api/authScopeIdentity';

export function getAuthCacheNamespace(backendMode: string): string {
  const user = authSession.getUser();
  if (!user) return `anonymous|session:${authSession.getSessionGeneration()}|mode:${backendMode}`;
  const scope = getUserAuthorizationScopeKey(user);
  return [
    `actor:${user.id}`,
    `session:${authSession.getSessionGeneration()}`,
    `scope:${hashScope(scope)}`,
    `mode:${backendMode}`,
  ].join('|');
}

export function useAuthCacheNamespace(backendMode: string): string {
  return useSyncExternalStore(
    authSession.subscribe,
    () => getAuthCacheNamespace(backendMode),
    () => getAuthCacheNamespace(backendMode),
  );
}

function hashScope(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

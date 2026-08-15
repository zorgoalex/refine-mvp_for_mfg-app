import type { UserIdentity } from '../types/auth';

export function getUserAuthorizationScopeKey(user: UserIdentity): string {
  return [
    user.role,
    user.roleId ?? user.role_id ?? '',
    [...(user.permissions ?? [])].sort().join(','),
    user.permissionsVersion ?? '',
    stableSerialize(user.policyScopes ?? null),
  ].join('|');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`)
    .join(',')}}`;
}

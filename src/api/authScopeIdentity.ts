import type { UserIdentity } from '../types/auth';

export function getUserAuthorizationScopeKey(user: UserIdentity): string {
  return JSON.stringify([
    user.role,
    user.roleId ?? user.role_id ?? null,
    [...(user.permissions ?? [])].sort(),
  ]);
}

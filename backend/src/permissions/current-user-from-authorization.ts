import { ApiError } from '../common/errors/api-error';
import type { CurrentUser } from './current-user';
import type { UserAuthorizationSnapshot } from './permissions.service';

/**
 * The one way every login path (password, refresh, WorkOS, Bitrix24 widget) builds the request user from the
 * effective authorization snapshot (access groups plan, stage 0A). Role, permissions, scalar scopes, scope sets
 * and version come from the same one-statement snapshot, so a token never carries grants older than its version.
 */
export function currentUserFromAuthorization(
  snapshot: UserAuthorizationSnapshot | null,
  context: { sessionId?: string },
): CurrentUser {
  if (!snapshot) {
    throw new ApiError(401, 'AUTH_USER_NOT_FOUND', 'User not found');
  }
  if (!snapshot.isActive) {
    throw new ApiError(401, 'AUTH_USER_INACTIVE', 'User is inactive');
  }
  if (!snapshot.role) {
    throw new ApiError(500, 'UNKNOWN_ROLE', 'User role is not supported by backend', { roleId: snapshot.roleId });
  }
  return {
    id: snapshot.userId,
    username: snapshot.username,
    role: snapshot.role,
    roleId: snapshot.roleId,
    permissions: snapshot.permissions,
    policyScopes: snapshot.scopes,
    policyScopeSets: snapshot.scopeSets,
    permissionsVersion: snapshot.version,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
  };
}

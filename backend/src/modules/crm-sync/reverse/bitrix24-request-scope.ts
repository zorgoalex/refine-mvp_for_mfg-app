import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';

export type Bitrix24RequestScope = { mode: 'all' } | { mode: 'assigned'; userId: number };

/**
 * Which Bitrix24 requests the user sees: every request, or those assigned to him. Decided by permissions
 * (access groups 0A.3; formerly by role names: superadmin/admin/top_manager → all, manager/operator → assigned).
 * Both grants → all. Neither → 403.
 */
export function bitrix24RequestScope(user: Pick<CurrentUser, 'id' | 'permissions'>): Bitrix24RequestScope {
  if (user.permissions.includes('bitrix24.requests.view_all')) return { mode: 'all' };
  if (user.permissions.includes('bitrix24.requests.view_assigned')) return { mode: 'assigned', userId: Number(user.id) };
  throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient Bitrix24 request scope');
}

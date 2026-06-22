import type { DeniedAuditEvent } from '../../../common/audit/audit-event.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { UserDenialReason } from '../../../permissions/policies/user-access.policy';

export const USERS_AUDIT_SOURCE = 'backend-users-command';
export const USER_PERMISSION_DENIED = 'user.permission_denied';

export interface BuildUserDeniedInput {
  actor: CurrentUser;
  requestId: string;
  action: string;
  targetUserId: string | number | null;
  reason: UserDenialReason;
}

export function buildUserDeniedEvent(input: BuildUserDeniedInput): DeniedAuditEvent {
  const numericTargetId = input.targetUserId == null ? null : Number(input.targetUserId);
  return {
    event: USER_PERMISSION_DENIED,
    entityType: 'user',
    entityId: input.targetUserId ?? 'users',
    actorUserId: input.actor.id,
    actorUsername: input.actor.username ?? null,
    actorRole: input.actor.role ?? null,
    requestId: input.requestId,
    source: USERS_AUDIT_SOURCE,
    relatedUserId:
      numericTargetId !== null && Number.isFinite(numericTargetId) ? numericTargetId : null,
    reason: input.reason,
    requiredPermissions: [`users.${input.action}`],
  };
}

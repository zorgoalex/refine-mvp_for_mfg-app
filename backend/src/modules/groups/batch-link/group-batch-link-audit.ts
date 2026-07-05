import type { DeniedAuditEvent } from '../../../common/audit/audit-event.types';
import type { CurrentUser } from '../../../permissions/current-user';

export const GROUPS_AUDIT_SOURCE = 'backend-groups-command'; // reuse existing GROUP_SOURCE (group.repository.ts:87)
export const BATCH_LINK_ROLE_DENIED = 'group_batch_link.role_denied';

export interface BuildBatchLinkRoleDeniedInput {
  currentUser: CurrentUser;
  requestId: string;
  groupId?: string | number | null; // DryRunGroupBatchLinkCommand.groupId is a string
  allowedRoles: readonly string[];
}

export function buildBatchLinkRoleDeniedEvent(input: BuildBatchLinkRoleDeniedInput): DeniedAuditEvent {
  return {
    event: BATCH_LINK_ROLE_DENIED, entityType: 'group',
    entityId: input.groupId ?? 'group_batch_link',
    actorUserId: input.currentUser.id, actorUsername: input.currentUser.username ?? null,
    actorRole: input.currentUser.role ?? null, requestId: input.requestId,
    source: GROUPS_AUDIT_SOURCE, reason: 'role_denied',
    requiredPermissions: ['groups.manage_links'],
    metadata: { allowedRoles: [...input.allowedRoles] },
  };
}

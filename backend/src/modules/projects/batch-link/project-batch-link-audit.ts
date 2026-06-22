import type { DeniedAuditEvent } from '../../../common/audit/audit-event.types';
import type { CurrentUser } from '../../../permissions/current-user';

export const PROJECTS_AUDIT_SOURCE = 'backend-projects-command'; // reuse existing PROJECT_SOURCE (project.repository.ts:87)
export const BATCH_LINK_ROLE_DENIED = 'project_batch_link.role_denied';

export interface BuildBatchLinkRoleDeniedInput {
  currentUser: CurrentUser;
  requestId: string;
  projectId?: string | number | null; // DryRunProjectBatchLinkCommand.projectId is a string
  allowedRoles: readonly string[];
}

export function buildBatchLinkRoleDeniedEvent(input: BuildBatchLinkRoleDeniedInput): DeniedAuditEvent {
  return {
    event: BATCH_LINK_ROLE_DENIED, entityType: 'project',
    entityId: input.projectId ?? 'project_batch_link',
    actorUserId: input.currentUser.id, actorUsername: input.currentUser.username ?? null,
    actorRole: input.currentUser.role ?? null, requestId: input.requestId,
    source: PROJECTS_AUDIT_SOURCE, reason: 'role_denied',
    requiredPermissions: ['projects.manage_links'],
    metadata: { allowedRoles: [...input.allowedRoles] },
  };
}

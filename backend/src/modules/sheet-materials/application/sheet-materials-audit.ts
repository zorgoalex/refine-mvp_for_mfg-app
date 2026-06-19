import type { AuditEvent, DeniedAuditEvent } from '../../../common/audit/audit-event.types';
import { computeDiff } from '../../../common/audit/audit-diff';
import type { CurrentUser } from '../../../permissions/current-user';

export const SHEET_MATERIALS_AUDIT_EVENTS = {
  created: 'sheet_material.created',
  updated: 'sheet_material.updated',
  deactivated: 'sheet_material.deactivated',
  permissionDenied: 'sheet_material.permission_denied',
} as const;

export const SHEET_MATERIALS_AUDIT_SOURCE = 'backend-sheet-materials';

export interface BuildSheetMaterialAuditInput {
  event: string;
  currentUser: CurrentUser;
  sheetMaterialTypeId: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string;
}

export function buildSheetMaterialAuditEvent(input: BuildSheetMaterialAuditInput): AuditEvent {
  const diff = input.before && input.after ? computeDiff(input.before, input.after) : null;
  return {
    event: input.event,
    entityType: 'sheet_material_type',
    entityId: input.sheetMaterialTypeId,
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username ?? null,
    actorRole: input.currentUser.role ?? null,
    requestId: input.requestId,
    source: SHEET_MATERIALS_AUDIT_SOURCE,
    before: input.before,
    after: input.after,
    diff,
    relatedEntities: [{ entityType: 'sheet_material_type', entityId: input.sheetMaterialTypeId }],
  };
}

export interface BuildSheetMaterialDeniedInput {
  currentUser: CurrentUser;
  requiredPermissions: string[];
  requestId: string;
  targetId?: number;
}

export function buildSheetMaterialDeniedEvent(input: BuildSheetMaterialDeniedInput): DeniedAuditEvent {
  return {
    event: SHEET_MATERIALS_AUDIT_EVENTS.permissionDenied,
    entityType: 'sheet_material_type',
    entityId: input.targetId ?? 'sheet_material_types',
    actorUserId: input.currentUser.id,
    actorUsername: input.currentUser.username ?? null,
    actorRole: input.currentUser.role ?? null,
    requestId: input.requestId,
    source: SHEET_MATERIALS_AUDIT_SOURCE,
    reason: 'permission_denied',
    requiredPermissions: input.requiredPermissions,
  };
}

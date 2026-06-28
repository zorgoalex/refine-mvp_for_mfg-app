import type {
  AuditEvent,
  AuditRelatedEntity,
  DeniedAuditEvent,
} from '../../../common/audit/audit-event.types';

/**
 * Cut-job audit contract (plan §11, audit-first). All cut commands write
 * audit_log in-tx + normalized related dimensions via the bridge
 * audit_log_related_entity (migration 020). Primary entity = cut_job. Related
 * rows are written per distinct source orderId, sheet_material_type_id and
 * cut_group_id so "which cut touched order Y" and "which cuts used sheet type X"
 * are direct indexed queries, not JSON scans. Variant B: material_id is retired;
 * sheet_material_type_id is the sole sheet dimension.
 */
export const CUT_AUDIT_EVENTS = {
  created: 'cut_job.created',
  itemAdded: 'cut_job.item_added',
  itemRemoved: 'cut_job.item_removed',
  calculated: 'cut_job.calculated',
  archived: 'cut_job.archived',
  calculateFailed: 'cut_job.calculate_failed',
  permissionDenied: 'cut_job.permission_denied',
  profileChanged: 'cut_job.profile_changed',
  sheetMaterialChanged: 'cut_job.sheet_material_changed',
  combineFilmsChanged: 'cut_job.combine_films_changed',
  splitByMaterialChanged: 'cut_job.split_by_material_changed',
} as const;

export type CutAuditEventName = (typeof CUT_AUDIT_EVENTS)[keyof typeof CUT_AUDIT_EVENTS];

export interface CutAuditActor {
  id: string | number;
  username?: string | null;
  role?: string | null;
}

export interface CutRelatedDimensions {
  orderIds?: readonly number[];
  sheetMaterialTypeIds?: readonly number[];
  cutGroupIds?: readonly number[];
}

export interface BuildCutAuditEventInput {
  event: CutAuditEventName;
  cutJobId: number;
  actor: CutAuditActor;
  requestId: string;
  source: string;
  related?: CutRelatedDimensions;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  diff?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface BuildCutDeniedEventInput {
  cutJobId: number;
  actor: CutAuditActor;
  requestId: string;
  source: string;
  reason: string;
  requiredPermissions?: readonly string[];
  related?: Pick<CutRelatedDimensions, 'orderIds' | 'cutGroupIds'>;
  metadata?: Record<string, unknown>;
}

function distinct(values: readonly number[] | undefined): number[] {
  return values ? [...new Set(values)] : [];
}

function buildRelatedEntities(related: CutRelatedDimensions | undefined): AuditRelatedEntity[] {
  if (!related) {
    return [];
  }
  const rows: AuditRelatedEntity[] = [];
  for (const entityId of distinct(related.orderIds)) {
    rows.push({ entityType: 'order', entityId });
  }
  for (const entityId of distinct(related.sheetMaterialTypeIds)) {
    rows.push({ entityType: 'sheet_material_type', entityId });
  }
  for (const entityId of distinct(related.cutGroupIds)) {
    rows.push({ entityType: 'cut_group', entityId });
  }
  return rows;
}

export function buildCutAuditEvent(input: BuildCutAuditEventInput): AuditEvent {
  const orderIds = distinct(input.related?.orderIds);
  return {
    event: input.event,
    entityType: 'cut_job',
    entityId: input.cutJobId,
    actorUserId: input.actor.id,
    actorUsername: input.actor.username ?? null,
    actorRole: input.actor.role ?? null,
    requestId: input.requestId,
    source: input.source,
    relatedOrderId: orderIds[0] ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    diff: input.diff ?? null,
    metadata: input.metadata ?? null,
    relatedEntities: buildRelatedEntities(input.related),
  };
}

export function buildCutDeniedEvent(input: BuildCutDeniedEventInput): DeniedAuditEvent {
  const orderIds = distinct(input.related?.orderIds);
  return {
    event: CUT_AUDIT_EVENTS.permissionDenied,
    entityType: 'cut_job',
    entityId: input.cutJobId,
    actorUserId: input.actor.id,
    actorUsername: input.actor.username ?? null,
    actorRole: input.actor.role ?? null,
    requestId: input.requestId,
    source: input.source,
    relatedOrderId: orderIds[0] ?? null,
    reason: input.reason,
    requiredPermissions: input.requiredPermissions,
    relatedEntities: buildRelatedEntities(input.related),
    metadata: input.metadata,
  };
}

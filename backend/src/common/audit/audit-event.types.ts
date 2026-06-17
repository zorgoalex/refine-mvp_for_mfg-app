export type { AuditRelatedEntity } from './related-entities';
import type { AuditRelatedEntity } from './related-entities';

/** Query/report-ready audit event. Maps 1:1 onto audit_log columns. */
export interface AuditEvent {
  /** audit_log.event (action is a generated column derived from event). */
  event: string;
  entityType: string;
  entityId: string | number;
  actorUserId?: string | number | null;
  actorUsername?: string | null;
  actorRole?: string | null;
  requestId: string;
  source: string;
  relatedOrderId?: number | null;
  relatedClientId?: number | null;
  relatedPaymentId?: number | null;
  relatedProductionEventId?: number | null;
  relatedDeadlineId?: number | null;
  relatedUserId?: number | null;
  statusField?: string | null;
  statusId?: number | null;
  statusName?: string | null;
  statusCode?: string | null;
  stageCode?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  diff?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  relatedEntities?: AuditRelatedEntity[];
}

/** Convenience shape for permission-denied audit rows. */
export interface DeniedAuditEvent {
  event: string;
  entityType: string;
  entityId: string | number;
  actorUserId?: string | number | null;
  actorUsername?: string | null;
  actorRole?: string | null;
  requestId: string;
  source: string;
  relatedOrderId?: number | null;
  relatedClientId?: number | null;
  reason: string;
  requiredPermissions?: readonly string[];
  metadata?: Record<string, unknown>;
}

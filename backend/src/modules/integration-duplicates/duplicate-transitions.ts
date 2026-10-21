import { randomUUID } from 'node:crypto';
import { auditService } from '../../common/audit/audit.service';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { SOURCE, type DuplicateAction, type DuplicateEntityKind, type DuplicateSystem } from './integration-duplicates';

export interface CaseHead {
  caseId: number;
  ruleCode: string;
  entityKind: string;
  status: string;
}

export interface MemberRef {
  system: DuplicateSystem;
  entityKind: DuplicateEntityKind;
  recordKey: string;
  erpEntityId: number | null;
}

export interface TransitionContext {
  requestId: string;
  correlationId: string;
  /** null — the system. */
  actor: CurrentUser | null;
}

/** Transitions a consumer may rely on; `source_refreshed` only keeps the 1C dependency fresh and is not announced. */
const ANNOUNCED: ReadonlySet<DuplicateAction> = new Set(['detected', 'member_joined', 'member_left', 'dismissed', 'marked_external', 'reopened', 'resolved']);

/**
 * One transition of a case: its history row, the audit row and (for announced transitions) the domain event, all in
 * the caller's transaction. Only references, codes and counts — never a value of a key.
 */
export async function recordTransition(
  tx: TransactionClient, head: CaseHead, action: DuplicateAction, ctx: TransitionContext,
  members: readonly MemberRef[], details: Record<string, unknown> = {},
): Promise<number> {
  const actorUserId = ctx.actor ? Number(ctx.actor.id) : null;
  const payloadMembers = members.map((m) => ({ system: m.system, entityKind: m.entityKind, recordKey: m.recordKey, erpEntityId: m.erpEntityId }));
  const eventId = Number((await tx.query<{ event_id: string }>(
    `INSERT INTO integration_duplicate_events (case_id, action, actor_user_id, request_id, correlation_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING event_id`,
    [head.caseId, action, actorUserId, ctx.requestId, ctx.correlationId, JSON.stringify({ ...details, members: payloadMembers })])).rows[0].event_id);
  const firstClient = members.find((m) => m.system === 'erp' && m.entityKind === 'client' && m.erpEntityId !== null);
  await auditService.record(tx, {
    event: `integration_duplicate.${action}`, entityType: 'integration_duplicate_case', entityId: head.caseId,
    actorUserId, actorUsername: ctx.actor?.username ?? null, actorRole: ctx.actor?.role ?? null,
    requestId: ctx.requestId, source: SOURCE,
    relatedClientId: firstClient?.erpEntityId ?? null,
    relatedEntities: members.filter((m) => m.system === 'erp' && m.erpEntityId !== null)
      .map((m) => ({ entityType: m.entityKind, entityId: m.erpEntityId as number })),
    statusCode: head.status,
    metadata: { ruleCode: head.ruleCode, entityKind: head.entityKind, eventId, correlationId: ctx.correlationId, ...details, members: payloadMembers },
  });
  if (ANNOUNCED.has(action)) {
    const eventType = `integration_duplicate.${action}`;
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ($1, 'integration_duplicate_case', $2, $3::jsonb, $4) ON CONFLICT DO NOTHING`,
      [eventType, String(head.caseId), JSON.stringify({
        eventId: randomUUID(), eventType, caseId: head.caseId, ruleCode: head.ruleCode, entityKind: head.entityKind, status: head.status, action,
        actorUserId, actor: actorUserId === null ? 'system' : 'user', requestId: ctx.requestId, correlationId: ctx.correlationId,
        members: payloadMembers, ...details, source: SOURCE,
      }), `${eventType}:${head.caseId}:${eventId}`]);
  }
  return eventId;
}

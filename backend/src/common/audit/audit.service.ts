import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import { redactLogFields } from '../logging/redaction';
import type { AuditEvent, DeniedAuditEvent } from './audit-event.types';
import { insertRelatedEntities } from './related-entities';

interface AuditRow extends QueryResultRow {
  audit_id: string;
}

const AUDIT_INSERT = `
  INSERT INTO audit_log (
    event, entity_type, entity_id, user_id, username, role_code, role,
    request_id, source,
    related_order_id, related_client_id, related_payment_id,
    related_production_event_id, related_deadline_id, related_user_id,
    status_field, status_id, status_name, status_code, stage_code,
    before_json, after_json, diff_json, metadata_json
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $6,
    $7, $8,
    $9, $10, $11,
    $12, $13, $14,
    $15, $16, $17, $18, $19,
    $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb
  )
  RETURNING audit_id
`;

/**
 * VLM usage-count keys: integers that would otherwise collide with /token/i.
 * Exact-match only — substring keys like `access_token` remain redacted.
 */
const AUDIT_REDACT_ALLOWLIST: ReadonlySet<string> = new Set(['inputTokens', 'outputTokens']);

function redactJson(value?: Record<string, unknown> | null): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(redactLogFields(value, AUDIT_REDACT_ALLOWLIST));
}

/**
 * Centralized, transaction-participating audit writer. Pass the caller's
 * TransactionClient so the audit row commits atomically with the command;
 * pass the pool-backed DatabaseService for denied-action rows that fire
 * outside a write transaction.
 */
export class AuditService {
  async record(client: DatabaseClient, event: AuditEvent): Promise<string> {
    const result = await client.query<AuditRow>(AUDIT_INSERT, [
      event.event,
      event.entityType,
      String(event.entityId),
      event.actorUserId ?? null,
      event.actorUsername ?? null,
      event.actorRole ?? null,
      event.requestId,
      event.source,
      event.relatedOrderId ?? null,
      event.relatedClientId ?? null,
      event.relatedPaymentId ?? null,
      event.relatedProductionEventId ?? null,
      event.relatedDeadlineId ?? null,
      event.relatedUserId ?? null,
      event.statusField ?? null,
      event.statusId ?? null,
      event.statusName ?? null,
      event.statusCode ?? null,
      event.stageCode ?? null,
      redactJson(event.before),
      redactJson(event.after),
      redactJson(event.diff),
      redactJson(event.metadata),
    ]);
    const auditId = result.rows[0]?.audit_id ?? '';
    if (auditId) {
      await insertRelatedEntities(client, auditId, event.relatedEntities ?? []);
    }
    return auditId;
  }

  async recordDenied(client: DatabaseClient, event: DeniedAuditEvent): Promise<string> {
    return this.record(client, {
      event: event.event, entityType: event.entityType, entityId: event.entityId,
      actorUserId: event.actorUserId ?? null, actorUsername: event.actorUsername ?? null,
      actorRole: event.actorRole ?? null, requestId: event.requestId, source: event.source,
      relatedOrderId: event.relatedOrderId ?? null, relatedClientId: event.relatedClientId ?? null,
      relatedPaymentId: event.relatedPaymentId ?? null,
      relatedProductionEventId: event.relatedProductionEventId ?? null,
      relatedDeadlineId: event.relatedDeadlineId ?? null, relatedUserId: event.relatedUserId ?? null,
      statusField: 'denied', statusCode: event.reason,
      before: {}, after: {}, diff: {},
      metadata: { ...(event.metadata ?? {}), source: event.source, denied: true, reason: event.reason, requiredPermissions: event.requiredPermissions ?? [] },
      relatedEntities: event.relatedEntities ?? [],
    });
  }
}

/** Shared singleton; AuditService is stateless, so one instance is safe. */
export const auditService = new AuditService();

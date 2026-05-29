import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import { redactLogFields } from '../logging/redaction';
import type { AuditEvent, DeniedAuditEvent } from './audit-event.types';

interface AuditRow extends QueryResultRow {
  audit_id: string;
}

const AUDIT_INSERT = `
  INSERT INTO audit_log (
    event, entity_type, entity_id, user_id, username, role_code, role,
    request_id, source,
    related_order_id, related_client_id, related_payment_id,
    related_production_event_id, related_deadline_id,
    status_field, status_id, status_name, status_code, stage_code,
    before_json, after_json, diff_json, metadata_json
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $6,
    $7, $8,
    $9, $10, $11,
    $12, $13,
    $14, $15, $16, $17, $18,
    $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb
  )
  RETURNING audit_id
`;

function redactJson(value?: Record<string, unknown> | null): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(redactLogFields(value));
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
    return result.rows[0]?.audit_id ?? '';
  }

  async recordDenied(client: DatabaseClient, event: DeniedAuditEvent): Promise<string> {
    return this.record(client, {
      event: event.event,
      entityType: event.entityType,
      entityId: event.entityId,
      actorUserId: event.actorUserId ?? null,
      actorUsername: event.actorUsername ?? null,
      actorRole: event.actorRole ?? null,
      requestId: event.requestId,
      source: event.source,
      relatedOrderId: event.relatedOrderId ?? null,
      relatedClientId: event.relatedClientId ?? null,
      before: {},
      after: {},
      diff: {},
      metadata: {
        ...(event.metadata ?? {}),
        source: event.source,
        denied: true,
        reason: event.reason,
        requiredPermissions: event.requiredPermissions ?? [],
      },
    });
  }
}

/** Shared singleton; AuditService is stateless, so one instance is safe. */
export const auditService = new AuditService();

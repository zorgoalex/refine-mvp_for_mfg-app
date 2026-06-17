import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { redactLogValue } from '../../../common/logging/redaction';
import type { AuditLogEventDto, AuditLogListResponseDto } from '../dto/audit.dto';
import type { AuditLogFilters, AuditLogRepositoryPort, ListAuditCommand } from '../application/audit-query.types';

interface CountRow extends QueryResultRow { total: number | string }
interface AuditRow extends QueryResultRow {
  audit_id: string; event: string; entity_type: string | null; entity_id: string | null;
  user_id: string | number | null; username: string | null; role: string | null; source: string | null;
  related_order_id: string | number | null; related_client_id: string | number | null;
  related_payment_id: string | number | null; related_deadline_id: string | number | null;
  related_production_event_id: string | number | null;
  related_user_id: string | number | null;
  status_field: string | null; status_id: string | number | null; status_name: string | null;
  status_code: string | null; stage_code: string | null; request_id: string;
  ip_address: string | null; user_agent: string | null;
  before_json: unknown; after_json: unknown; diff_json: unknown; metadata_json: unknown;
  related_entities: unknown;
  created_at: string | Date;
}

const SELECT_COLUMNS = `
  audit_id, event, entity_type, entity_id, user_id, username, role, source,
  related_order_id, related_client_id, related_payment_id, related_deadline_id, related_production_event_id,
  related_user_id,
  status_field, status_id, status_name, status_code, stage_code,
  request_id, ip_address, user_agent, before_json, after_json, diff_json, metadata_json,
  COALESCE(
    (SELECT json_agg(json_build_object('entityType', r.entity_type, 'entityId', r.entity_id))
     FROM audit_log_related_entity r WHERE r.audit_id = audit_log.audit_id),
    '[]'::json
  ) AS related_entities,
  created_at
`;

function buildWhere(filters: AuditLogFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, op: string, value: unknown) => {
    params.push(value);
    clauses.push(`${column} ${op} $${params.length}`);
  };
  if (filters.event) add('event', '=', filters.event);
  if (filters.entityType) add('entity_type', '=', filters.entityType);
  if (filters.entityId) add('entity_id', '=', filters.entityId);
  if (filters.userId != null) add('user_id', '=', filters.userId);
  if (filters.role) add('role', '=', filters.role);
  if (filters.source) add('source', '=', filters.source);
  if (filters.relatedOrderId != null) add('related_order_id', '=', filters.relatedOrderId);
  if (filters.relatedClientId != null) add('related_client_id', '=', filters.relatedClientId);
  if (filters.relatedPaymentId != null) add('related_payment_id', '=', filters.relatedPaymentId);
  if (filters.relatedDeadlineId != null) add('related_deadline_id', '=', filters.relatedDeadlineId);
  if (filters.relatedProductionEventId != null) add('related_production_event_id', '=', filters.relatedProductionEventId);
  if (filters.relatedUserId != null) {
    params.push(filters.relatedUserId);
    const p = params.length;
    clauses.push(
      `(related_user_id = $${p} OR EXISTS (SELECT 1 FROM audit_log_related_entity r ` +
        `WHERE r.audit_id = audit_log.audit_id AND r.entity_type = 'user' AND r.entity_id = $${p}))`,
    );
  }
  if (filters.relatedEntityType && filters.relatedEntityId != null) {
    params.push(filters.relatedEntityType);
    const pt = params.length;
    params.push(filters.relatedEntityId);
    const pid = params.length;
    clauses.push(
      `EXISTS (SELECT 1 FROM audit_log_related_entity r ` +
        `WHERE r.audit_id = audit_log.audit_id AND r.entity_type = $${pt} AND r.entity_id = $${pid})`,
    );
  }
  if (filters.requestId) add('request_id', '=', filters.requestId);
  if (filters.createdFrom) add('created_at', '>=', filters.createdFrom);
  if (filters.createdTo) add('created_at', '<=', filters.createdTo);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function num(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRow(row: AuditRow): AuditLogEventDto {
  return {
    auditId: row.audit_id,
    event: row.event,
    entityType: row.entity_type,
    entityId: row.entity_id,
    userId: num(row.user_id),
    username: row.username,
    role: row.role,
    source: row.source,
    relatedOrderId: num(row.related_order_id),
    relatedClientId: num(row.related_client_id),
    relatedPaymentId: num(row.related_payment_id),
    relatedDeadlineId: num(row.related_deadline_id),
    relatedProductionEventId: num(row.related_production_event_id),
    relatedUserId: num(row.related_user_id),
    statusField: row.status_field,
    statusId: num(row.status_id),
    statusName: row.status_name,
    statusCode: row.status_code,
    stageCode: row.stage_code,
    requestId: row.request_id,
    ip: row.ip_address,
    userAgent: row.user_agent,
    before: row.before_json == null ? null : redactLogValue(row.before_json),
    after: row.after_json == null ? null : redactLogValue(row.after_json),
    diff: row.diff_json == null ? null : redactLogValue(row.diff_json),
    metadata: row.metadata_json == null ? null : redactLogValue(row.metadata_json),
    relatedEntities: Array.isArray(row.related_entities)
      ? (row.related_entities as Array<{ entityType: string; entityId: unknown }>).map((e) => ({
          entityType: e.entityType,
          entityId: num(e.entityId as string | number | null) ?? 0,
        }))
      : [],
    createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
  };
}

export class PgAuditLogRepository implements AuditLogRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async list(command: ListAuditCommand): Promise<AuditLogListResponseDto> {
    const { where, params } = buildWhere(command.filters);
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);
    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const rowsResult = await this.database.query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_log ${where} ORDER BY created_at DESC, audit_id DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, command.pageSize, (command.page - 1) * command.pageSize],
    );
    return {
      data: rowsResult.rows.map(mapRow),
      pagination: {
        page: command.page,
        pageSize: command.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / command.pageSize)),
      },
      requestId: command.requestId,
    };
  }
}

import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { redactLogValue } from '../../../common/logging/redaction';
import type {
  AuditFilterOptionsDto,
  AuditFilterOptionsResponseDto,
  AuditLogEventDto,
  AuditLogListResponseDto,
  AuditOrderFilterOptionDto,
  AuditOrderFilterOptionsResponseDto,
  AuditParticipantFilterOptionDto,
  AuditParticipantFilterOptionsResponseDto,
  AuditRelatedEntityFilterOptionDto,
  AuditUserFilterOptionDto,
} from '../dto/audit.dto';
import type {
  AuditFilterOptionsCommand,
  AuditLogFilters,
  AuditLogRepositoryPort,
  AuditLookupOptionsCommand,
  ListAuditCommand,
} from '../application/audit-query.types';
import {
  BUSINESS_HISTORY_EVENT_LIKE_PATTERNS,
  BUSINESS_HISTORY_EXCLUDED_EVENT_LIKE_PATTERNS,
} from '../application/business-history-events';

const FILTER_OPTIONS_RECENT_LIMIT = 5000;
const FILTER_OPTION_LIMIT = 200;

interface CountRow extends QueryResultRow {
  total: number | string;
}
interface AuditRow extends QueryResultRow {
  audit_id: string;
  event: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
  entity_detail_number: string | number | null;
  user_id: string | number | null;
  username: string | null;
  role: string | null;
  source: string | null;
  related_order_id: string | number | null;
  related_client_id: string | number | null;
  related_order_name: string | null;
  related_client_name: string | null;
  related_payment_id: string | number | null;
  related_deadline_id: string | number | null;
  related_production_event_id: string | number | null;
  related_user_id: string | number | null;
  status_field: string | null;
  status_id: string | number | null;
  status_name: string | null;
  status_code: string | null;
  stage_code: string | null;
  request_id: string;
  ip_address: string | null;
  user_agent: string | null;
  before_json: unknown;
  after_json: unknown;
  diff_json: unknown;
  metadata_json: unknown;
  related_entities: unknown;
  created_at: string | Date;
}

interface AuditFilterOptionsRow extends QueryResultRow {
  events: unknown;
  entity_types: unknown;
  entity_ids: unknown;
  users: unknown;
  roles: unknown;
  sources: unknown;
  related_order_ids: unknown;
  related_client_ids: unknown;
  related_payment_ids: unknown;
  related_deadline_ids: unknown;
  related_production_event_ids: unknown;
  related_user_ids: unknown;
  related_entity_types: unknown;
  related_entities: unknown;
  request_ids: unknown;
}

interface AuditOrderOptionRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
}

interface AuditParticipantOptionRow extends QueryResultRow {
  user_id: string | number;
  username: string;
  role: string | null;
}

const SELECT_COLUMNS = `
  audit_log.audit_id, audit_log.event, audit_log.entity_type, audit_log.entity_id,
  COALESCE(
    CASE WHEN audit_log.entity_type = 'order' THEN entity_order.order_name END,
    CASE WHEN audit_log.entity_type = 'client' THEN entity_client.client_name::text END
  ) AS entity_name,
  CASE
    WHEN audit_log.entity_type IN ('order_detail', 'detail') THEN entity_detail.detail_number
    ELSE NULL
  END AS entity_detail_number,
  audit_log.user_id, audit_log.username, audit_log.role, audit_log.source,
  audit_log.related_order_id, related_order.order_name AS related_order_name,
  audit_log.related_client_id, related_client.client_name::text AS related_client_name,
  audit_log.related_payment_id, audit_log.related_deadline_id, audit_log.related_production_event_id,
  audit_log.related_user_id,
  audit_log.status_field, audit_log.status_id, audit_log.status_name, audit_log.status_code, audit_log.stage_code,
  audit_log.request_id, audit_log.ip_address, audit_log.user_agent,
  audit_log.before_json, audit_log.after_json, audit_log.diff_json, audit_log.metadata_json,
  COALESCE(
    (
      SELECT json_agg(
        json_build_object(
          'entityType', r.entity_type,
          'entityId', r.entity_id,
          'entityName', CASE
            WHEN r.entity_type = 'order' THEN related_entity_order.order_name
            WHEN r.entity_type = 'client' THEN related_entity_client.client_name::text
            ELSE NULL
          END,
          'detailNumber', CASE
            WHEN r.entity_type IN ('order_detail', 'detail') THEN related_entity_detail.detail_number
            ELSE NULL
          END
        )
      )
      FROM audit_log_related_entity r
      LEFT JOIN orders related_entity_order
        ON r.entity_type = 'order' AND related_entity_order.order_id = r.entity_id
      LEFT JOIN clients related_entity_client
        ON r.entity_type = 'client' AND related_entity_client.client_id = r.entity_id
      LEFT JOIN order_details related_entity_detail
        ON r.entity_type IN ('order_detail', 'detail') AND related_entity_detail.detail_id = r.entity_id
      WHERE r.audit_id = audit_log.audit_id
    ),
    '[]'::json
  ) AS related_entities,
  audit_log.created_at
`;

const AUDIT_LABEL_JOINS = `
  LEFT JOIN orders related_order ON related_order.order_id = audit_log.related_order_id
  LEFT JOIN clients related_client ON related_client.client_id = audit_log.related_client_id
  LEFT JOIN orders entity_order
    ON entity_order.order_id = CASE
      WHEN audit_log.entity_type = 'order' AND audit_log.entity_id ~ '^[0-9]{1,18}$'
        THEN audit_log.entity_id::bigint
      ELSE NULL
    END
  LEFT JOIN clients entity_client
    ON entity_client.client_id = CASE
      WHEN audit_log.entity_type = 'client' AND audit_log.entity_id ~ '^[0-9]{1,18}$'
        THEN audit_log.entity_id::bigint
      ELSE NULL
    END
  LEFT JOIN order_details entity_detail
    ON entity_detail.detail_id = CASE
      WHEN audit_log.entity_type IN ('order_detail', 'detail') AND audit_log.entity_id ~ '^[0-9]{1,18}$'
        THEN audit_log.entity_id::bigint
      ELSE NULL
    END
`;

function filterOptionsSql(where: string, recentLimitParam: number, optionLimitParam: number): string {
  return `
WITH recent AS (
  SELECT audit_id, event, entity_type, entity_id, user_id, username, role, source,
         related_order_id, related_client_id, related_payment_id, related_deadline_id,
         related_production_event_id, related_user_id, request_id, created_at
  FROM audit_log
  ${where}
  ORDER BY created_at DESC, audit_id DESC
  LIMIT $${recentLimitParam}
),
related AS (
  SELECT r.entity_type, r.entity_id, max(recent.created_at) AS latest
  FROM audit_log_related_entity r
  JOIN recent ON recent.audit_id = r.audit_id
  GROUP BY r.entity_type, r.entity_id
),
related_enriched AS (
  SELECT
    related.entity_type,
    related.entity_id,
    related.latest,
    CASE
      WHEN related.entity_type = 'order' THEN related_order.order_name
      WHEN related.entity_type = 'client' THEN related_client.client_name::text
      ELSE NULL
    END AS entity_name,
    CASE
      WHEN related.entity_type IN ('order_detail', 'detail') THEN related_detail.detail_number
      ELSE NULL
    END AS detail_number
  FROM related
  LEFT JOIN orders related_order
    ON related.entity_type = 'order' AND related_order.order_id = related.entity_id
  LEFT JOIN clients related_client
    ON related.entity_type = 'client' AND related_client.client_id = related.entity_id
  LEFT JOIN order_details related_detail
    ON related.entity_type IN ('order_detail', 'detail') AND related_detail.detail_id = related.entity_id
)
SELECT
  COALESCE((SELECT jsonb_agg(event ORDER BY latest DESC, event)
    FROM (SELECT event, max(created_at) AS latest FROM recent WHERE event IS NOT NULL GROUP BY event ORDER BY latest DESC, event LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS events,
  COALESCE((SELECT jsonb_agg(entity_type ORDER BY latest DESC, entity_type)
    FROM (SELECT entity_type, max(created_at) AS latest FROM recent WHERE entity_type IS NOT NULL GROUP BY entity_type ORDER BY latest DESC, entity_type LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS entity_types,
  COALESCE((SELECT jsonb_agg(entity_id ORDER BY latest DESC, entity_id)
    FROM (SELECT entity_id, max(created_at) AS latest FROM recent WHERE entity_id IS NOT NULL GROUP BY entity_id ORDER BY latest DESC, entity_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS entity_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('userId', user_id, 'username', username, 'role', role) ORDER BY created_at DESC, user_id)
    FROM (
      SELECT user_id, username, role, created_at
      FROM (SELECT DISTINCT ON (user_id) user_id, username, role, created_at FROM recent WHERE user_id IS NOT NULL ORDER BY user_id, created_at DESC) distinct_users
      ORDER BY created_at DESC, user_id
      LIMIT $${optionLimitParam}
    ) s), '[]'::jsonb) AS users,
  COALESCE((SELECT jsonb_agg(role ORDER BY latest DESC, role)
    FROM (SELECT role, max(created_at) AS latest FROM recent WHERE role IS NOT NULL GROUP BY role ORDER BY latest DESC, role LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS roles,
  COALESCE((SELECT jsonb_agg(source ORDER BY latest DESC, source)
    FROM (SELECT source, max(created_at) AS latest FROM recent WHERE source IS NOT NULL GROUP BY source ORDER BY latest DESC, source LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS sources,
  COALESCE((SELECT jsonb_agg(related_order_id ORDER BY latest DESC, related_order_id)
    FROM (SELECT related_order_id, max(created_at) AS latest FROM recent WHERE related_order_id IS NOT NULL GROUP BY related_order_id ORDER BY latest DESC, related_order_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_order_ids,
  COALESCE((SELECT jsonb_agg(related_client_id ORDER BY latest DESC, related_client_id)
    FROM (SELECT related_client_id, max(created_at) AS latest FROM recent WHERE related_client_id IS NOT NULL GROUP BY related_client_id ORDER BY latest DESC, related_client_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_client_ids,
  COALESCE((SELECT jsonb_agg(related_payment_id ORDER BY latest DESC, related_payment_id)
    FROM (SELECT related_payment_id, max(created_at) AS latest FROM recent WHERE related_payment_id IS NOT NULL GROUP BY related_payment_id ORDER BY latest DESC, related_payment_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_payment_ids,
  COALESCE((SELECT jsonb_agg(related_deadline_id ORDER BY latest DESC, related_deadline_id)
    FROM (SELECT related_deadline_id, max(created_at) AS latest FROM recent WHERE related_deadline_id IS NOT NULL GROUP BY related_deadline_id ORDER BY latest DESC, related_deadline_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_deadline_ids,
  COALESCE((SELECT jsonb_agg(related_production_event_id ORDER BY latest DESC, related_production_event_id)
    FROM (SELECT related_production_event_id, max(created_at) AS latest FROM recent WHERE related_production_event_id IS NOT NULL GROUP BY related_production_event_id ORDER BY latest DESC, related_production_event_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_production_event_ids,
  COALESCE((SELECT jsonb_agg(id ORDER BY latest DESC, id)
    FROM (
      SELECT id, max(latest) AS latest
      FROM (
        SELECT related_user_id AS id, created_at AS latest FROM recent WHERE related_user_id IS NOT NULL
        UNION ALL
        SELECT entity_id AS id, latest FROM related WHERE entity_type = 'user'
      ) related_users
      GROUP BY id
      ORDER BY latest DESC, id
      LIMIT $${optionLimitParam}
    ) s), '[]'::jsonb) AS related_user_ids,
  COALESCE((SELECT jsonb_agg(entity_type ORDER BY latest DESC, entity_type)
    FROM (SELECT entity_type, max(latest) AS latest FROM related_enriched GROUP BY entity_type ORDER BY latest DESC, entity_type LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_entity_types,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('entityType', entity_type, 'entityId', entity_id, 'entityName', entity_name, 'detailNumber', detail_number) ORDER BY latest DESC, entity_type, entity_id)
    FROM (SELECT entity_type, entity_id, entity_name, detail_number, latest FROM related_enriched ORDER BY latest DESC, entity_type, entity_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS related_entities,
  COALESCE((SELECT jsonb_agg(request_id ORDER BY latest DESC, request_id)
    FROM (SELECT request_id, max(created_at) AS latest FROM recent WHERE request_id IS NOT NULL GROUP BY request_id ORDER BY latest DESC, request_id LIMIT $${optionLimitParam}) s), '[]'::jsonb) AS request_ids
`;
}

function buildWhere(filters: AuditLogFilters): {
  where: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, op: string, value: unknown) => {
    params.push(value);
    clauses.push(`${column} ${op} $${params.length}`);
  };
  const addArrayParam = (value: readonly number[] | readonly string[]): number => {
    params.push(value);
    return params.length;
  };
  if (filters.scope === 'business') {
    const includeParam = addArrayParam(BUSINESS_HISTORY_EVENT_LIKE_PATTERNS);
    const excludeParam = addArrayParam(BUSINESS_HISTORY_EXCLUDED_EVENT_LIKE_PATTERNS);
    clauses.push(
      `(audit_log.event LIKE ANY($${includeParam}::text[]) ` +
        `AND NOT (audit_log.event LIKE ANY($${excludeParam}::text[])))`,
    );
  }
  if (filters.events && filters.events.length > 0) {
    const p = addArrayParam(filters.events);
    clauses.push(`audit_log.event = ANY($${p}::text[])`);
  } else if (filters.event) add('audit_log.event', '=', filters.event);
  if (filters.entityType) add('audit_log.entity_type', '=', filters.entityType);
  if (filters.entityId) add('audit_log.entity_id', '=', filters.entityId);
  if (filters.userId != null) add('audit_log.user_id', '=', filters.userId);
  if (filters.orderIds && filters.orderIds.length > 0) {
    const p = addArrayParam(filters.orderIds);
    clauses.push(
      `(` +
        `audit_log.related_order_id = ANY($${p}::bigint[]) OR ` +
        `(audit_log.entity_type = 'order' AND audit_log.entity_id ~ '^[0-9]{1,18}$' ` +
        `AND audit_log.entity_id::bigint = ANY($${p}::bigint[])) OR ` +
        `EXISTS (SELECT 1 FROM audit_log_related_entity r ` +
        `WHERE r.audit_id = audit_log.audit_id AND r.entity_type = 'order' AND r.entity_id = ANY($${p}::bigint[]))` +
      `)`,
    );
  }
  if (filters.participantUserIds && filters.participantUserIds.length > 0) {
    const p = addArrayParam(filters.participantUserIds);
    clauses.push(
      `(` +
        `audit_log.user_id = ANY($${p}::bigint[]) OR ` +
        `audit_log.related_user_id = ANY($${p}::bigint[]) OR ` +
        `EXISTS (SELECT 1 FROM audit_log_related_entity r ` +
        `WHERE r.audit_id = audit_log.audit_id AND r.entity_type = 'user' AND r.entity_id = ANY($${p}::bigint[]))` +
      `)`,
    );
  }
  if (filters.role) add('audit_log.role', '=', filters.role);
  if (filters.source) add('audit_log.source', '=', filters.source);
  if (filters.relatedOrderId != null) add('audit_log.related_order_id', '=', filters.relatedOrderId);
  if (filters.relatedClientId != null) add('audit_log.related_client_id', '=', filters.relatedClientId);
  if (filters.relatedPaymentId != null) add('audit_log.related_payment_id', '=', filters.relatedPaymentId);
  if (filters.relatedDeadlineId != null) add('audit_log.related_deadline_id', '=', filters.relatedDeadlineId);
  if (filters.relatedProductionEventId != null)
    add('audit_log.related_production_event_id', '=', filters.relatedProductionEventId);
  if (filters.relatedUserId != null) {
    params.push(filters.relatedUserId);
    const p = params.length;
    clauses.push(
      `(audit_log.related_user_id = $${p} OR EXISTS (SELECT 1 FROM audit_log_related_entity r ` +
        `WHERE r.audit_id = audit_log.audit_id AND r.entity_type = 'user' AND r.entity_id = $${p}))`
    );
  }
  if (filters.relatedEntityType && filters.relatedEntityId != null) {
    params.push(filters.relatedEntityType);
    const pt = params.length;
    params.push(filters.relatedEntityId);
    const pid = params.length;
    clauses.push(
      `EXISTS (SELECT 1 FROM audit_log_related_entity r ` +
        `WHERE r.audit_id = audit_log.audit_id AND r.entity_type = $${pt} AND r.entity_id = $${pid})`
    );
  }
  if (filters.requestId) add('audit_log.request_id', '=', filters.requestId);
  if (filters.createdFrom) add('audit_log.created_at', '>=', filters.createdFrom);
  if (filters.createdTo) add('audit_log.created_at', '<=', filters.createdTo);
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function num(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function mapRow(row: AuditRow): AuditLogEventDto {
  return {
    auditId: row.audit_id,
    event: row.event,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: str(row.entity_name),
    entityDetailNumber: num(row.entity_detail_number),
    userId: num(row.user_id),
    username: row.username,
    role: row.role,
    source: row.source,
    relatedOrderId: num(row.related_order_id),
    relatedOrderName: str(row.related_order_name),
    relatedClientId: num(row.related_client_id),
    relatedClientName: str(row.related_client_name),
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
      ? (
          row.related_entities as Array<{
            entityType: string;
            entityId: unknown;
            entityName?: unknown;
            detailNumber?: unknown;
          }>
        ).map((e) => {
          const entity: AuditLogEventDto['relatedEntities'][number] = {
            entityType: e.entityType,
            entityId: num(e.entityId as string | number | null) ?? 0,
          };
          const entityName = str(e.entityName);
          const detailNumber = num(e.detailNumber as string | number | null);
          if (entityName) entity.entityName = entityName;
          if (detailNumber != null) entity.detailNumber = detailNumber;
          return entity;
        })
      : [],
    createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of value) {
    const next = num(item as string | number | null);
    if (next == null || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
  }
  return result;
}

function userOptions(value: unknown): AuditUserFilterOptionDto[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: AuditUserFilterOptionDto[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as {
      userId?: unknown;
      username?: unknown;
      role?: unknown;
    };
    const userId = num(row.userId as string | number | null);
    if (userId == null || seen.has(userId)) continue;
    seen.add(userId);
    result.push({
      userId,
      username: typeof row.username === 'string' ? row.username : null,
      role: typeof row.role === 'string' ? row.role : null,
    });
  }
  return result;
}

function relatedEntityOptions(value: unknown): AuditRelatedEntityFilterOptionDto[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: AuditRelatedEntityFilterOptionDto[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as {
      entityType?: unknown;
      entityId?: unknown;
      entityName?: unknown;
      detailNumber?: unknown;
    };
    if (typeof row.entityType !== 'string' || row.entityType.trim().length === 0) continue;
    const entityId = num(row.entityId as string | number | null);
    if (entityId == null) continue;
    const key = `${row.entityType}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const option: AuditRelatedEntityFilterOptionDto = {
      entityType: row.entityType,
      entityId,
    };
    const entityName = str(row.entityName);
    const detailNumber = num(row.detailNumber as string | number | null);
    if (entityName) option.entityName = entityName;
    if (detailNumber != null) option.detailNumber = detailNumber;
    result.push(option);
  }
  return result;
}

function mapFilterOptions(row: AuditFilterOptionsRow | undefined): AuditFilterOptionsDto {
  return {
    events: stringArray(row?.events),
    entityTypes: stringArray(row?.entity_types),
    entityIds: stringArray(row?.entity_ids),
    users: userOptions(row?.users),
    roles: stringArray(row?.roles),
    sources: stringArray(row?.sources),
    relatedOrderIds: numberArray(row?.related_order_ids),
    relatedClientIds: numberArray(row?.related_client_ids),
    relatedPaymentIds: numberArray(row?.related_payment_ids),
    relatedDeadlineIds: numberArray(row?.related_deadline_ids),
    relatedProductionEventIds: numberArray(row?.related_production_event_ids),
    relatedUserIds: numberArray(row?.related_user_ids),
    relatedEntityTypes: stringArray(row?.related_entity_types),
    relatedEntities: relatedEntityOptions(row?.related_entities),
    requestIds: stringArray(row?.request_ids),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildLookupParams(query: AuditLookupOptionsCommand['query']): {
  ids: readonly number[];
  search: string | null;
  limit: number;
} {
  return {
    ids: query.ids ?? [],
    search: query.search ? `%${escapeLike(query.search)}%` : null,
    limit: query.limit,
  };
}

function mapOrderOption(row: AuditOrderOptionRow): AuditOrderFilterOptionDto {
  return {
    orderId: num(row.order_id) ?? 0,
    orderName: row.order_name,
  };
}

function mapParticipantOption(row: AuditParticipantOptionRow): AuditParticipantFilterOptionDto {
  return {
    userId: num(row.user_id) ?? 0,
    username: row.username,
    role: row.role,
  };
}

export class PgAuditLogRepository implements AuditLogRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async list(command: ListAuditCommand): Promise<AuditLogListResponseDto> {
    const { where, params } = buildWhere(command.filters);
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
      params
    );
    const total = Number(countResult.rows[0]?.total ?? 0);
    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const rowsResult = await this.database.query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_log ${AUDIT_LABEL_JOINS} ${where} ORDER BY audit_log.created_at DESC, audit_log.audit_id DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...params, command.pageSize, (command.page - 1) * command.pageSize]
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

  async filterOptions(command: AuditFilterOptionsCommand): Promise<AuditFilterOptionsResponseDto> {
    const { where, params } = buildWhere({ scope: command.scope });
    const recentLimitParam = params.length + 1;
    const optionLimitParam = params.length + 2;
    const result = await this.database.query<AuditFilterOptionsRow>(filterOptionsSql(where, recentLimitParam, optionLimitParam), [
      ...params,
      FILTER_OPTIONS_RECENT_LIMIT,
      FILTER_OPTION_LIMIT,
    ]);
    return {
      data: mapFilterOptions(result.rows[0]),
      requestId: command.requestId,
    };
  }

  async orderOptions(command: AuditLookupOptionsCommand): Promise<AuditOrderFilterOptionsResponseDto> {
    const lookup = buildLookupParams(command.query);
    const result = await this.database.query<AuditOrderOptionRow>(
      `
      WITH selected AS (
        SELECT o.order_id, o.order_name, o.order_date, 0 AS selected_rank
        FROM orders o
        WHERE o.order_id = ANY($1::bigint[])
      ),
      searched AS (
        SELECT o.order_id, o.order_name, o.order_date, 1 AS selected_rank
        FROM orders o
        WHERE NOT (o.order_id = ANY($1::bigint[]))
          AND ($2::text IS NULL OR o.order_id::text ILIKE $2 ESCAPE '\\' OR o.order_name ILIKE $2 ESCAPE '\\')
        ORDER BY o.order_date DESC NULLS LAST, o.order_id DESC
        LIMIT $3
      )
      SELECT order_id, order_name
      FROM (
        SELECT * FROM selected
        UNION ALL
        SELECT * FROM searched
      ) options
      ORDER BY selected_rank ASC, order_date DESC NULLS LAST, order_id DESC
      `,
      [lookup.ids, lookup.search, lookup.limit],
    );
    return {
      data: result.rows.map(mapOrderOption),
      requestId: command.requestId,
    };
  }

  async participantOptions(command: AuditLookupOptionsCommand): Promise<AuditParticipantFilterOptionsResponseDto> {
    const lookup = buildLookupParams(command.query);
    const result = await this.database.query<AuditParticipantOptionRow>(
      `
      WITH selected AS (
        SELECT u.user_id, u.username::text AS username, r.role_code AS role, u.is_active, 0 AS selected_rank
        FROM users u
        LEFT JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = ANY($1::bigint[])
      ),
      searched AS (
        SELECT u.user_id, u.username::text AS username, r.role_code AS role, u.is_active, 1 AS selected_rank
        FROM users u
        LEFT JOIN roles r ON r.role_id = u.role_id
        WHERE NOT (u.user_id = ANY($1::bigint[]))
          AND (
            $2::text IS NULL
            OR u.user_id::text ILIKE $2 ESCAPE '\\'
            OR u.username::text ILIKE $2 ESCAPE '\\'
            OR COALESCE(r.role_code, '') ILIKE $2 ESCAPE '\\'
          )
        ORDER BY u.is_active DESC, u.username ASC, u.user_id ASC
        LIMIT $3
      )
      SELECT user_id, username, role
      FROM (
        SELECT * FROM selected
        UNION ALL
        SELECT * FROM searched
      ) options
      ORDER BY selected_rank ASC, is_active DESC, username ASC, user_id ASC
      `,
      [lookup.ids, lookup.search, lookup.limit],
    );
    return {
      data: result.rows.map(mapParticipantOption),
      requestId: command.requestId,
    };
  }
}

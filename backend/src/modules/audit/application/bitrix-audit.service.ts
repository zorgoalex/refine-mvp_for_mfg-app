import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { ApiError } from '../../../common/errors/api-error';
import type { CrmSyncRuntimeConfigService } from '../../crm-sync/http/crm-sync-runtime-config.service';
import {
  BITRIX_AUDIT_PREDICATE,
  BITRIX_EVENT_CATALOG,
  bitrixEventDefinition,
} from './bitrix-audit-events';
import { safeBitrixError } from './bitrix-audit-sanitization';

export interface BitrixQueueQuery {
  direction: 'forward' | 'reverse';
  status?: 'pending' | 'processing' | 'processed' | 'failed' | 'dead';
  orderId?: number;
  entityType?: 'order' | 'client' | 'payment';
  entityId?: string;
  bitrixObject?: 'deal' | 'contact' | 'company' | 'payment';
  bitrixId?: string;
  page: number;
  pageSize: number;
}

export class BitrixAuditService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly config: CrmSyncRuntimeConfigService
  ) {}

  private authorize(user: CurrentUser | undefined): void {
    if (!user)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    if (!new PermissionsService().canUser(user, 'audit.view'))
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Требуется право audit.view'
      );
  }

  async eventOptions(user: CurrentUser | undefined, search?: string) {
    this.authorize(user);
    const pattern = `%${(search ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await this.db.query<{ event: string }>(
      `SELECT DISTINCT event FROM audit_log WHERE ${BITRIX_AUDIT_PREDICATE} AND event ILIKE $1 ESCAPE '\\' ORDER BY event LIMIT 50`,
      [pattern]
    );
    const known = BITRIX_EVENT_CATALOG.filter(
      (item) =>
        !search ||
        `${item.event} ${item.label}`
          .toLowerCase()
          .includes(search.toLowerCase())
    );
    return {
      data: [
        ...new Map(
          [
            ...known,
            ...rows.map((row) => bitrixEventDefinition(row.event)),
          ].map((item) => [item.event, item])
        ).values(),
      ],
    };
  }

  async status(user: CurrentUser | undefined) {
    this.authorize(user);
    const result = await this.db.query<{
      direction: 'forward' | 'reverse';
      pending: string;
      processing: string;
      failed: string;
      dead: string;
      oldest: Date | null;
      last: Date | null;
    }>(`SELECT 'forward' AS direction, count(*) FILTER (WHERE status='pending') AS pending,
      count(*) FILTER (WHERE status='processing') AS processing, count(*) FILTER (WHERE status='failed') AS failed,
      0::bigint AS dead, min(created_at) FILTER (WHERE status='pending') AS oldest, max(processed_at) AS last FROM crm_sync_outbox
      UNION ALL SELECT 'reverse', count(*) FILTER (WHERE status='pending'), count(*) FILTER (WHERE status='processing'),
      count(*) FILTER (WHERE status='failed'), count(*) FILTER (WHERE status='dead'),
      min(created_at) FILTER (WHERE status='pending'), max(processed_at) FROM bitrix24_inbound_event`);
    return {
      fetchedAt: new Date().toISOString(),
      data: result.rows.map((row) => {
        const flags =
          row.direction === 'forward'
            ? this.config.getFlags()
            : this.config.getReverseSync();
        return {
          direction: row.direction,
          enabled: flags.enabled,
          owner: flags.relayOwner,
          dryRun: flags.dryRun,
          pending: Number(row.pending),
          processing: Number(row.processing),
          failed: Number(row.failed),
          dead: Number(row.dead),
          oldestPendingAt: row.oldest,
          lastProcessedAt: row.last,
        };
      }),
    };
  }

  async queue(user: CurrentUser | undefined, query: BitrixQueueQuery) {
    this.authorize(user);
    const forward = query.direction === 'forward';
    const params: unknown[] = [];
    const clauses: string[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      clauses.push(`${column}=$${params.length}`);
    };
    if (query.status) add('q.status', query.status);
    if (query.orderId) add('q.order_id', String(query.orderId));
    if (query.entityType) add('q.entity_type', query.entityType);
    if (query.entityId) add('q.entity_id', query.entityId);
    if (query.bitrixObject) add('q.bitrix_object', query.bitrixObject);
    if (query.bitrixId) add('q.bitrix_id', query.bitrixId);
    const source = forward
      ? `SELECT e.outbox_event_id::text AS id, e.event_type AS event, identity.entity_type,
      identity.entity_id, CASE WHEN identity.entity_type='order' THEN identity.entity_id ELSE m.parent_erp_id END AS order_id,
      m.bitrix_object, m.bitrix_id, e.status, e.attempts, e.created_at, e.processed_at, e.next_attempt_at,
      m.last_error AS error, 'current_mapping'::text AS error_source
      FROM crm_sync_outbox e
      CROSS JOIN LATERAL (SELECT e.payload_json->>'entity' AS entity_type,
        COALESCE(e.payload_json->>'id',e.aggregate_id) AS entity_id) identity
      LEFT JOIN crm_sync_mapping m ON m.entity_type=identity.entity_type AND m.erp_id=identity.entity_id`
      : `SELECT e.inbound_event_id::text AS id, e.event_name AS event, m.entity_type, m.erp_id AS entity_id,
      COALESCE(CASE WHEN m.entity_type='order' THEN m.erp_id END, r.linked_order_id::text) AS order_id,
      e.object_type AS bitrix_object, e.bitrix_id, e.status, e.attempts, e.created_at, e.processed_at, e.next_attempt_at,
      e.last_error AS error, 'queue'::text AS error_source
      FROM bitrix24_inbound_event e LEFT JOIN crm_sync_mapping m ON m.bitrix_object=e.object_type AND m.bitrix_id=e.bitrix_id
      LEFT JOIN bitrix24_incoming_request r ON e.object_type='deal' AND r.bitrix_deal_id=e.bitrix_id`;
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const from = `FROM (${source}) q LEFT JOIN orders o ON o.order_id::text=q.order_id ${where}`;
    const count = await this.db.query<{ total: string }>(
      `SELECT count(*) AS total ${from}`,
      params
    );
    const rows = await this.db.query<{
      id: string;
      event: string;
      entity_type: string | null;
      entity_id: string | null;
      order_id: string | null;
      order_name: string | null;
      bitrix_object: string | null;
      bitrix_id: string | null;
      status: string;
      attempts: number;
      created_at: Date;
      processed_at: Date | null;
      next_attempt_at: Date;
      error: string | null;
      error_source: string;
    }>(
      `SELECT q.*, o.order_name ${from} ORDER BY q.created_at DESC, q.id DESC LIMIT $${
        params.length + 1
      } OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize]
    );
    return {
      data: rows.rows.map((row) => ({
        id: `${query.direction}:${row.id}`,
        queueId: row.id,
        direction: query.direction,
        event: row.event,
        entityType: row.entity_type,
        entityId: row.entity_id,
        orderId: row.order_id,
        orderName: row.order_name,
        bitrixObject: row.bitrix_object,
        bitrixId: row.bitrix_id,
        status: row.status,
        attempts: row.attempts,
        createdAt: row.created_at,
        processedAt: row.processed_at,
        nextAttemptAt:
          ['pending', 'failed'].includes(row.status) &&
          !(forward && row.status === 'failed')
            ? row.next_attempt_at
            : null,
        error: row.error ? safeBitrixError(row.error) : null,
        errorSource: row.error ? row.error_source : null,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: Number(count.rows[0]?.total ?? 0),
      },
    };
  }
}

import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgAuditLogRepository } from './pg-audit-log-repository';

function db(results: Array<{ rows: QueryResultRow[] }>): {
  client: DatabaseClient;
  calls: Array<{ text: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const queue = [...results];
  const client: DatabaseClient = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly unknown[] = []
    ): Promise<QueryResult<T>> {
      calls.push({ text, params: [...params] });
      const next = queue.shift() ?? { rows: [] };
      return {
        rows: next.rows as T[],
        rowCount: next.rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };
    },
  };
  return { client, calls };
}

describe('PgAuditLogRepository.list', () => {
  it('builds a parameterized WHERE from filters and paginates', async () => {
    const { client, calls } = db([
      { rows: [{ total: 3 }] },
      {
        rows: [
          {
            audit_id: 'a1',
            event: 'payments.create',
            entity_type: 'payment',
            entity_id: '42',
            user_id: 7,
            username: 'm1',
            role: 'manager',
            source: 'backend-payments-command',
            related_order_id: 1001,
            related_client_id: null,
            related_payment_id: 42,
            related_deadline_id: null,
            related_production_event_id: null,
            status_field: null,
            status_id: null,
            status_name: null,
            status_code: null,
            stage_code: null,
            request_id: 'req1',
            ip_address: null,
            user_agent: null,
            before_json: null,
            after_json: { amount: 100 },
            diff_json: null,
            metadata_json: { previousOrderId: null },
            created_at: '2026-05-29T10:00:00.000Z',
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({
      currentUser: undefined,
      filters: { relatedOrderId: 1001, event: 'payments.create' },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toMatch(/COUNT\(\*\)/i);
    expect(calls[0].text).toMatch(/related_order_id = \$/);
    expect(calls[0].text).toMatch(/event = \$/);
    expect(calls[0].params).toContain(1001);
    expect(calls[0].params).toContain('payments.create');
    expect(calls[1].text).toMatch(/LEFT JOIN orders related_order/i);
    expect(calls[1].text).toMatch(/LEFT JOIN clients related_client/i);
    expect(calls[1].text).toMatch(/LEFT JOIN order_details entity_detail/i);
    expect(calls[1].text).toMatch(/ORDER BY audit_log\.created_at DESC/i);
    expect(calls[1].text).toMatch(/LIMIT \$\d+ OFFSET \$\d+/i);
    expect(res.pagination).toEqual({
      page: 1,
      pageSize: 50,
      total: 3,
      totalPages: 1,
    });
    expect(res.data[0]).toMatchObject({
      auditId: 'a1',
      event: 'payments.create',
      relatedOrderId: 1001,
      relatedPaymentId: 42,
    });
  });

  it('maps order names, client names and detail position numbers for readable audit labels', async () => {
    const { client } = db([
      { rows: [{ total: 1 }] },
      {
        rows: [
          {
            audit_id: 'a-labels',
            event: 'orders.detail_production_status_change',
            entity_type: 'order_detail',
            entity_id: '1001',
            entity_name: null,
            entity_detail_number: 3,
            user_id: 7,
            username: 'm1',
            role: 'manager',
            source: 'backend-orders-command',
            related_order_id: 11472,
            related_order_name: '2729',
            related_client_id: 55,
            related_client_name: 'Иван Петров',
            related_payment_id: null,
            related_deadline_id: null,
            related_production_event_id: null,
            related_user_id: null,
            status_field: null,
            status_id: null,
            status_name: null,
            status_code: null,
            stage_code: null,
            request_id: 'req-labels',
            ip_address: null,
            user_agent: null,
            before_json: null,
            after_json: null,
            diff_json: null,
            metadata_json: null,
            related_entities: [
              { entityType: 'order', entityId: 11472, entityName: '2729' },
              { entityType: 'client', entityId: 55, entityName: 'Иван Петров' },
              { entityType: 'order_detail', entityId: 1001, detailNumber: 3 },
            ],
            created_at: '2026-05-29T10:00:00.000Z',
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);

    const res = await repo.list({
      currentUser: undefined,
      filters: {},
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });

    expect(res.data[0]).toMatchObject({
      auditId: 'a-labels',
      entityName: null,
      entityDetailNumber: 3,
      relatedOrderId: 11472,
      relatedOrderName: '2729',
      relatedClientId: 55,
      relatedClientName: 'Иван Петров',
      relatedEntities: [
        { entityType: 'order', entityId: 11472, entityName: '2729' },
        { entityType: 'client', entityId: 55, entityName: 'Иван Петров' },
        { entityType: 'order_detail', entityId: 1001, detailNumber: 3 },
      ],
    });
  });

  it('redacts sensitive keys in JSON columns on read', async () => {
    const { client } = db([
      { rows: [{ total: 1 }] },
      {
        rows: [
          {
            audit_id: 'a2',
            event: 'users.create',
            entity_type: 'user',
            entity_id: '9',
            user_id: 1,
            username: 'admin',
            role: 'admin',
            source: 'backend-users-command',
            related_order_id: null,
            related_client_id: null,
            related_payment_id: null,
            related_deadline_id: null,
            related_production_event_id: null,
            status_field: null,
            status_id: null,
            status_name: null,
            status_code: null,
            stage_code: null,
            request_id: 'req2',
            ip_address: null,
            user_agent: null,
            before_json: null,
            after_json: { username: 'bob', password: 'leaked-pw' },
            diff_json: null,
            metadata_json: null,
            created_at: '2026-05-29T10:00:00.000Z',
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({
      currentUser: undefined,
      filters: {},
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });
    expect(JSON.stringify(res.data[0].after)).not.toContain('leaked-pw');
    expect(JSON.stringify(res.data[0].after)).toContain('bob');
  });

  it('filters by related_user_id and role and maps relatedUserId', async () => {
    const { client, calls } = db([
      { rows: [{ total: 1 }] },
      {
        rows: [
          {
            audit_id: 'a3',
            event: 'org.direction_head_added',
            entity_type: 'direction',
            entity_id: '5',
            user_id: 1,
            username: 'admin',
            role: 'admin',
            source: 'backend-org-command',
            related_order_id: null,
            related_client_id: null,
            related_payment_id: null,
            related_deadline_id: null,
            related_production_event_id: null,
            related_user_id: 158,
            status_field: null,
            status_id: null,
            status_name: null,
            status_code: null,
            stage_code: null,
            request_id: 'req3',
            ip_address: null,
            user_agent: null,
            before_json: null,
            after_json: null,
            diff_json: null,
            metadata_json: null,
            created_at: '2026-06-15T10:00:00.000Z',
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({
      currentUser: undefined,
      filters: { relatedUserId: 158, role: 'admin' },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });
    expect(calls[0].text).toMatch(/related_user_id = \$/);
    expect(calls[0].text).toMatch(/role = \$/);
    expect(calls[0].params).toContain(158);
    expect(calls[0].params).toContain('admin');
    expect(res.data[0].relatedUserId).toBe(158);
  });

  it('emits no WHERE when no filters are set and computes offset', async () => {
    const { client, calls } = db([{ rows: [{ total: 0 }] }, { rows: [] }]);
    const repo = new PgAuditLogRepository(client);
    await repo.list({
      currentUser: undefined,
      filters: {},
      page: 2,
      pageSize: 25,
      requestId: 'rq',
    });
    expect(calls[0].text).not.toMatch(/WHERE/i);
    expect(calls[1].params).toContain(25); // offset = (2-1)*25
  });

  it('widens relatedUserId filter to also match bridge user rows (single bind)', async () => {
    const { client, calls } = db([
      { rows: [{ total: 1 }] },
      {
        rows: [
          {
            audit_id: 'a4',
            event: 'org.user_added',
            entity_type: 'org',
            entity_id: '1',
            user_id: 1,
            username: 'admin',
            role: 'admin',
            source: 'backend-org-command',
            related_order_id: null,
            related_client_id: null,
            related_payment_id: null,
            related_deadline_id: null,
            related_production_event_id: null,
            related_user_id: null,
            status_field: null,
            status_id: null,
            status_name: null,
            status_code: null,
            stage_code: null,
            request_id: 'req4',
            ip_address: null,
            user_agent: null,
            before_json: null,
            after_json: null,
            diff_json: null,
            metadata_json: null,
            related_entities: [{ entityType: 'user', entityId: 7 }],
            created_at: '2026-06-17T10:00:00.000Z',
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({
      currentUser: undefined,
      filters: { relatedUserId: 7 },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });
    // COUNT query
    expect(calls[0].text).toMatch(/related_user_id = \$/);
    expect(calls[0].text).toMatch(/audit_log_related_entity/);
    // relatedUserId appears only once in params (single bind reused via $n reference)
    expect(calls[0].params.filter((p) => p === 7)).toHaveLength(1);
    // rows query same WHERE
    expect(calls[1].text).toMatch(/related_user_id = \$/);
    expect(calls[1].text).toMatch(/audit_log_related_entity/);
    expect(calls[1].params.filter((p) => p === 7)).toHaveLength(1);
    // relatedEntities mapped from related_entities column
    expect(res.data[0].relatedEntities).toEqual([{ entityType: 'user', entityId: 7 }]);
  });

  it('filters by relatedEntityType + relatedEntityId via bridge EXISTS', async () => {
    const { client, calls } = db([{ rows: [{ total: 2 }] }, { rows: [] }]);
    const repo = new PgAuditLogRepository(client);
    await repo.list({
      currentUser: undefined,
      filters: { relatedEntityType: 'employee', relatedEntityId: 3 },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });
    expect(calls[0].text).toMatch(/EXISTS/i);
    expect(calls[0].text).toMatch(/audit_log_related_entity/);
    expect(calls[0].params).toContain('employee');
    expect(calls[0].params).toContain(3);
  });

  it('filters business history by event array with backend-owned predicate', async () => {
    const { client, calls } = db([{ rows: [{ total: 0 }] }, { rows: [] }]);
    const repo = new PgAuditLogRepository(client);
    await repo.list({
      currentUser: undefined,
      filters: { scope: 'business', events: ['orders.update', 'payments.create'] },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });

    expect(calls[0].text).toMatch(/audit_log\.event LIKE ANY\(\$1::text\[\]\)/);
    expect(calls[0].text).toMatch(/NOT \(audit_log\.event LIKE ANY\(\$2::text\[\]\)\)/);
    expect(calls[0].text).toMatch(/audit_log\.event = ANY\(\$3::text\[\]\)/);
    expect(calls[0].params[0]).toContain('orders.%');
    expect(calls[0].params[1]).toContain('%.permission_denied');
    expect(calls[0].params[2]).toEqual(['orders.update', 'payments.create']);
  });

  it('filters orderIds across direct related order, entity order and bridge order with regex cast guard', async () => {
    const { client, calls } = db([{ rows: [{ total: 0 }] }, { rows: [] }]);
    const repo = new PgAuditLogRepository(client);
    await repo.list({
      currentUser: undefined,
      filters: { orderIds: [42, 43] },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });

    expect(calls[0].text).toMatch(/audit_log\.related_order_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].text).toMatch(/audit_log\.entity_type = 'order'/);
    expect(calls[0].text).toMatch(/audit_log\.entity_id ~ '\^\[0-9\]\{1,18\}\$'/);
    expect(calls[0].text).toMatch(/audit_log\.entity_id::bigint = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].text).toMatch(/r\.entity_type = 'order' AND r\.entity_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].params[0]).toEqual([42, 43]);
  });

  it('filters participantUserIds across actor, related user and bridge user', async () => {
    const { client, calls } = db([{ rows: [{ total: 0 }] }, { rows: [] }]);
    const repo = new PgAuditLogRepository(client);
    await repo.list({
      currentUser: undefined,
      filters: { participantUserIds: [7, 8] },
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });

    expect(calls[0].text).toMatch(/audit_log\.user_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].text).toMatch(/audit_log\.related_user_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].text).toMatch(/r\.entity_type = 'user' AND r\.entity_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].params[0]).toEqual([7, 8]);
  });

  it('mapRow returns relatedEntities: [] when related_entities is absent or not an array', async () => {
    const { client } = db([
      { rows: [{ total: 1 }] },
      {
        rows: [
          {
            audit_id: 'a5',
            event: 'test.event',
            entity_type: null,
            entity_id: null,
            user_id: null,
            username: null,
            role: null,
            source: null,
            related_order_id: null,
            related_client_id: null,
            related_payment_id: null,
            related_deadline_id: null,
            related_production_event_id: null,
            related_user_id: null,
            status_field: null,
            status_id: null,
            status_name: null,
            status_code: null,
            stage_code: null,
            request_id: 'req5',
            ip_address: null,
            user_agent: null,
            before_json: null,
            after_json: null,
            diff_json: null,
            metadata_json: null,
            // no related_entities key → undefined → must map to []
            created_at: '2026-06-17T10:00:00.000Z',
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);
    const res = await repo.list({
      currentUser: undefined,
      filters: {},
      page: 1,
      pageSize: 50,
      requestId: 'rq',
    });
    expect(res.data[0].relatedEntities).toEqual([]);
  });
});

describe('PgAuditLogRepository.filterOptions', () => {
  it('loads distinct recent filter values and maps option DTOs', async () => {
    const { client, calls } = db([
      {
        rows: [
          {
            events: ['orders.detail_transfer', 'orders.update'],
            entity_types: ['order'],
            entity_ids: ['11472'],
            users: [{ userId: '7', username: 'manager', role: 'admin' }],
            roles: ['admin'],
            sources: ['backend-orders-command'],
            related_order_ids: ['11472'],
            related_client_ids: ['55'],
            related_payment_ids: ['9'],
            related_deadline_ids: ['12'],
            related_production_event_ids: ['33'],
            related_user_ids: ['7'],
            related_entity_types: ['order_detail'],
            related_entities: [
              {
                entityType: 'order_detail',
                entityId: '1001',
                detailNumber: '3',
              },
            ],
            request_ids: ['req-1'],
          },
        ],
      },
    ]);
    const repo = new PgAuditLogRepository(client);

    const res = await repo.filterOptions({
      currentUser: undefined,
      requestId: 'rq-options',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/WITH recent AS/i);
    expect(calls[0].text).toMatch(/audit_log_related_entity/i);
    expect(calls[0].params).toEqual([5000, 200]);
    expect(res.requestId).toBe('rq-options');
    expect(res.data).toMatchObject({
      events: ['orders.detail_transfer', 'orders.update'],
      entityTypes: ['order'],
      entityIds: ['11472'],
      users: [{ userId: 7, username: 'manager', role: 'admin' }],
      roles: ['admin'],
      sources: ['backend-orders-command'],
      relatedOrderIds: [11472],
      relatedClientIds: [55],
      relatedPaymentIds: [9],
      relatedDeadlineIds: [12],
      relatedProductionEventIds: [33],
      relatedUserIds: [7],
      relatedEntityTypes: ['order_detail'],
      relatedEntities: [{ entityType: 'order_detail', entityId: 1001, detailNumber: 3 }],
      requestIds: ['req-1'],
    });
  });

  it('limits business filter options to business history scope', async () => {
    const { client, calls } = db([{ rows: [{ events: ['orders.update'] }] }]);
    const repo = new PgAuditLogRepository(client);

    await repo.filterOptions({
      currentUser: undefined,
      requestId: 'rq-options',
      scope: 'business',
    });

    expect(calls[0].text).toMatch(/WITH recent AS/i);
    expect(calls[0].text).toMatch(/FROM audit_log\s+WHERE \(audit_log\.event LIKE ANY\(\$1::text\[\]\)/i);
    expect(calls[0].params[0]).toContain('orders.%');
    expect(calls[0].params[1]).toContain('%_worker_%');
    expect(calls[0].params[2]).toBe(5000);
    expect(calls[0].params[3]).toBe(200);
  });
});

describe('PgAuditLogRepository lookup options', () => {
  it('loads order options with id hydration, escaped search and minimal fields', async () => {
    const { client, calls } = db([
      { rows: [{ order_id: '2678', order_name: '2678' }] },
    ]);
    const repo = new PgAuditLogRepository(client);

    const res = await repo.orderOptions({
      currentUser: undefined,
      requestId: 'rq-orders',
      query: { ids: [2678], search: '%_2678', limit: 20 },
    });

    expect(calls[0].text).toMatch(/SELECT o\.order_id, o\.order_name/i);
    expect(calls[0].text).toMatch(/WITH selected AS/i);
    expect(calls[0].text).toMatch(/searched AS/i);
    expect(calls[0].text).toMatch(/UNION ALL/i);
    expect(calls[0].text).not.toMatch(/delete_flag/);
    expect(calls[0].text).toMatch(/o\.order_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].text).toMatch(/NOT \(o\.order_id = ANY\(\$1::bigint\[\]\)\)/);
    expect(calls[0].text).toMatch(/o\.order_name ILIKE \$2 ESCAPE '\\'/);
    expect(calls[0].text).toMatch(/LIMIT \$3/);
    expect(calls[0].params).toEqual([[2678], '%\\%\\_2678%', 20]);
    expect(res).toEqual({ data: [{ orderId: 2678, orderName: '2678' }], requestId: 'rq-orders' });
  });

  it('loads participant options with role and minimal fields', async () => {
    const { client, calls } = db([
      { rows: [{ user_id: '7', username: 'manager', role: 'manager' }] },
    ]);
    const repo = new PgAuditLogRepository(client);

    const res = await repo.participantOptions({
      currentUser: undefined,
      requestId: 'rq-users',
      query: { ids: [7], search: 'manager', limit: 10 },
    });

    expect(calls[0].text).toMatch(/SELECT u\.user_id, u\.username::text AS username, r\.role_code AS role/i);
    expect(calls[0].text).toMatch(/LEFT JOIN roles r ON r\.role_id = u\.role_id/i);
    expect(calls[0].text).toMatch(/WITH selected AS/i);
    expect(calls[0].text).toMatch(/searched AS/i);
    expect(calls[0].text).toMatch(/UNION ALL/i);
    expect(calls[0].text).toMatch(/u\.user_id = ANY\(\$1::bigint\[\]\)/);
    expect(calls[0].text).toMatch(/NOT \(u\.user_id = ANY\(\$1::bigint\[\]\)\)/);
    expect(calls[0].text).toMatch(/u\.username::text ILIKE \$2 ESCAPE '\\'/);
    expect(calls[0].params).toEqual([[7], '%manager%', 10]);
    expect(res).toEqual({ data: [{ userId: 7, username: 'manager', role: 'manager' }], requestId: 'rq-users' });
  });
});

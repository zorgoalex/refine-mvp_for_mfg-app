import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { ORDER_HISTORY_COMMON_EVENTS, ORDER_HISTORY_FINANCIAL_EVENTS } from '../application/order-history-events';
import { PgOrderReadRepository } from './pg-order-read-repository';

const PROJECTION_KEYS = [
  'actorName', 'auditId', 'createdAt', 'entityType', 'event', 'stageCode', 'statusField', 'statusName',
];

describe('PgOrderReadRepository.getOrderHistory', () => {
  it('returns only the fixed projection, even when the audit row carries payload and technical columns', async () => {
    const database = createDatabase({
      total: 1,
      rows: [{
        audit_id: 'audit-1',
        event: 'orders.update',
        created_at: new Date('2026-10-01T07:30:00.000Z'),
        username: 'manager',
        entity_type: 'order',
        status_field: null,
        status_name: null,
        stage_code: null,
        // a careless SELECT * would bring these along
        before_json: { total_amount: 100 },
        after_json: { total_amount: 200 },
        diff_json: { total_amount: { before: 100, after: 200 } },
        metadata_json: { requestId: 'request-1', bitrixId: '18204' },
        request_id: 'request-1',
        ip_address: '10.0.0.1',
        user_agent: 'browser',
        user_id: 7,
        role: 'manager',
        related_payment_id: 5,
      }],
    });
    const repository = new PgOrderReadRepository(database.service);

    const response = await repository.getOrderHistory(
      { currentUser: user(), orderId: 100, page: 1, pageSize: 20 },
      { events: [...ORDER_HISTORY_COMMON_EVENTS], includeFinancial: false },
    );

    expect(Object.keys(response).sort()).toEqual(['data', 'pagination']);
    expect(Object.keys(response.data[0]).sort()).toEqual(PROJECTION_KEYS);
    expect(response.data[0]).toEqual({
      auditId: 'audit-1',
      event: 'orders.update',
      createdAt: '2026-10-01T07:30:00.000Z',
      actorName: 'manager',
      entityType: 'order',
      statusField: null,
      statusName: null,
      stageCode: null,
    });
    expect(JSON.stringify(response)).not.toMatch(/request-1|18204|10\.0\.0\.1|total_amount|browser/);
    expect(response.pagination).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
  });

  it('never selects audit JSON or technical columns', async () => {
    const database = createDatabase({ total: 0, rows: [] });
    const repository = new PgOrderReadRepository(database.service);

    await repository.getOrderHistory(
      { currentUser: user(), orderId: 100, page: 1, pageSize: 20 },
      { events: [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS], includeFinancial: true },
    );

    const rowsQuery = database.queries.find((query) => query.text.includes('audit_log.audit_id, audit_log.event'))!;
    const selectList = rowsQuery.text.slice(0, rowsQuery.text.indexOf('FROM audit_log'));
    for (const column of ['before_json', 'after_json', 'diff_json', 'metadata_json', 'request_id', 'ip_address', 'user_agent', 'user_id', 'role', 'source', 'related_']) {
      expect(selectList).not.toContain(column);
    }
    expect(selectList).not.toContain('*');
  });

  it('uses one predicate for count and rows, bound to the order and the allow-list', async () => {
    const database = createDatabase({ total: 37, rows: [] });
    const repository = new PgOrderReadRepository(database.service);

    const response = await repository.getOrderHistory(
      { currentUser: user(), orderId: 100, page: 3, pageSize: 10 },
      { events: ['orders.create', 'orders.update'], includeFinancial: false },
    );

    expect(database.queries).toHaveLength(2);
    const [count, rows] = database.queries;
    const predicate = (text: string) => text.slice(text.indexOf('WHERE audit_log.audit_id IN'), text.includes('ORDER BY') ? text.indexOf('ORDER BY') : undefined).replace(/\s+/g, ' ').trim();
    expect(predicate(count.text)).toBe(predicate(rows.text));
    expect(count.text).toContain('audit_log.event = ANY($3::text[])');
    expect(count.params).toEqual([100, '100', ['orders.create', 'orders.update']]);
    expect(rows.params).toEqual([100, '100', ['orders.create', 'orders.update'], 10, 20]);
    expect(rows.text).toContain('ORDER BY audit_log.created_at DESC, audit_log.audit_id DESC');
    expect(response.pagination).toEqual({ page: 3, pageSize: 10, total: 37, totalPages: 4 });
  });

  it('adds the payment-dimension guard to count and rows unless financial facts are allowed', async () => {
    const withoutFinance = createDatabase({ total: 0, rows: [] });
    await new PgOrderReadRepository(withoutFinance.service).getOrderHistory(
      { currentUser: user(), orderId: 100, page: 1, pageSize: 20 },
      { events: [...ORDER_HISTORY_COMMON_EVENTS], includeFinancial: false },
    );
    for (const query of withoutFinance.queries) {
      expect(query.text).toContain("audit_log.status_field IS DISTINCT FROM 'denied'");
      expect(query.text).toContain("audit_log.status_field IS DISTINCT FROM 'paymentStatus'");
      expect(query.text).toContain('audit_log.related_payment_id IS NULL');
      expect(query.text).toContain("payment_link.entity_type = 'payment'");
    }
    expect(withoutFinance.queries[0].params[2]).not.toContain('orders.payment_status_change');
    expect(withoutFinance.queries[0].params[2]).not.toContain('payments.create');

    const withFinance = createDatabase({ total: 0, rows: [] });
    await new PgOrderReadRepository(withFinance.service).getOrderHistory(
      { currentUser: user(), orderId: 100, page: 1, pageSize: 20 },
      { events: [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS], includeFinancial: true },
    );
    for (const query of withFinance.queries) {
      // refusals are excluded for every caller, finance rights included
      expect(query.text).toContain("audit_log.status_field IS DISTINCT FROM 'denied'");
      expect(query.text).not.toContain('paymentStatus');
      expect(query.text).not.toContain('payment_link');
    }
  });

  it('never lets integration or denied events through the allow-list parameter', async () => {
    const database = createDatabase({ total: 0, rows: [] });
    await new PgOrderReadRepository(database.service).getOrderHistory(
      { currentUser: user(), orderId: 100, page: 1, pageSize: 20 },
      { events: [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS], includeFinancial: true },
    );

    const allowed = database.queries[0].params[2] as string[];
    for (const event of ['crm_sync.upsert', 'orders.export', 'orders.export.requested', 'production.action_denied', 'status_automation.rule_skipped']) {
      expect(allowed).not.toContain(event);
    }
  });
});

function createDatabase(fixture: { total: number; rows: Record<string, unknown>[] }) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const service = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      if (text.includes('COUNT(*)::int')) return { rows: [{ total: fixture.total }] };
      return { rows: fixture.rows };
    },
  } as unknown as DatabaseService;
  return { service, queries };
}

function user(): CurrentUser {
  return { id: '15', username: 'viewer', role: 'viewer', roleId: 100, permissions: ['orders.view'] };
}

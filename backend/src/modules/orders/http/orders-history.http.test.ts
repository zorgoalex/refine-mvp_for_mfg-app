import { describe, expect, it } from 'vitest';
import type { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PgOrderReadRepository } from '../adapters/pg-order-read-repository';
import { OrderQueryService } from '../application/order-query.service';
import { createOrderDtoForQueryTest } from '../application/order-query.test-helpers';
import type { OrderReadRepositoryPort } from '../application/order-query.types';
import { OrdersController } from './orders.controller';
import type { OrdersRuntimeConfigService } from './orders-runtime-config.service';

/**
 * Route → real OrderQueryService → real PgOrderReadRepository over a database double that
 * returns WHOLE audit rows. Whatever the driver hands back, the HTTP body is the projection.
 */
describe('GET /orders/:orderId/history — full response', () => {
  it('returns only the projection for a user with orders.view and nothing else', async () => {
    const { controller, queries } = createController({ order: 'found' });

    const body = await controller.getHistory({ user: user(['orders.view']), requestId: 'request-history-1' }, '100', {});

    expect(Object.keys(body).sort()).toEqual(['data', 'pagination']);
    expect(body.pagination).toEqual({ page: 1, pageSize: 20, total: 2, totalPages: 1 });
    expect(body.data).toEqual([
      {
        auditId: 'audit-2', event: 'orders.status_change', createdAt: '2026-10-01T08:00:00.000Z', actorName: 'manager',
        entityType: 'order', statusField: 'orderStatus', statusName: 'В производстве', stageCode: null,
      },
      {
        auditId: 'audit-1', event: 'orders.update', createdAt: '2026-10-01T07:30:00.000Z', actorName: 'manager',
        entityType: 'order', statusField: null, statusName: null, stageCode: null,
      },
    ]);
    const serialized = JSON.stringify(body);
    for (const leak of ['request-history-1', 'request-command-1', 'bitrix', '18204', '10.0.0.1', 'browser', 'total_amount', 'before', 'after', 'diff', 'metadata', 'userId', 'role', 'source']) {
      expect(serialized).not.toContain(leak);
    }
    // the allow-list reaches SQL without financial events and with both guards
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.params[2]).not.toContain('orders.payment_status_change');
      expect(query.text).toContain("audit_log.status_field IS DISTINCT FROM 'denied'");
      expect(query.text).toContain("audit_log.status_field IS DISTINCT FROM 'paymentStatus'");
    }
  });

  it('adds financial events only with both finance rights; refusals stay excluded', async () => {
    const { controller, queries } = createController({ order: 'found' });

    await controller.getHistory({ user: user(['orders.view', 'orders.view_financials', 'payments.view']) }, '100', { page: '2', pageSize: '50' });

    expect(queries[0].params[2]).toContain('orders.payment_status_change');
    expect(queries[0].params[2]).toContain('payments.create');
    expect(queries[1].params.slice(3)).toEqual([50, 50]);
    for (const query of queries) {
      expect(query.text).toContain("audit_log.status_field IS DISTINCT FROM 'denied'");
      expect(query.text).not.toContain('paymentStatus');
    }
  });

  it('requires authentication, orders.view and an order the user can open', async () => {
    const found = createController({ order: 'found' });
    await expect(found.controller.getHistory({}, '100', {})).rejects.toMatchObject({ statusCode: 401 } satisfies Partial<ApiError>);
    await expect(found.controller.getHistory({ user: user([]) }, '100', {})).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions: ['orders.view'] },
    } satisfies Partial<ApiError>);
    expect(found.queries).toEqual([]);

    const missing = createController({ order: 'missing' });
    await expect(missing.controller.getHistory({ user: user(['orders.view']) }, '100', {})).rejects.toMatchObject({ statusCode: 404 });
    expect(missing.queries).toEqual([]);
  });

  it('rejects an invalid page size with 422 before any read', async () => {
    const { controller, queries } = createController({ order: 'found' });

    await expect(
      controller.getHistory({ user: user(['orders.view']) }, '100', { pageSize: '51' }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(queries).toEqual([]);
  });

  it('answers 503 while the orders API is disabled', async () => {
    const { controller } = createController({ order: 'found', ordersEnabled: false });

    await expect(controller.getHistory({ user: user(['orders.view']) }, '100', {})).rejects.toMatchObject({ statusCode: 503 });
  });
});

function createController(options: { order: 'found' | 'missing'; ordersEnabled?: boolean }) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const database = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      if (text.includes('COUNT(*)::int')) return { rows: [{ total: 2 }] };
      return {
        rows: [
          dirtyRow('audit-2', 'orders.status_change', '2026-10-01T08:00:00.000Z', { status_field: 'orderStatus', status_name: 'В производстве' }),
          dirtyRow('audit-1', 'orders.update', '2026-10-01T07:30:00.000Z', {}),
        ],
      };
    },
  } as unknown as DatabaseService;
  const reader: OrderReadRepositoryPort = {
    async listOrders() {
      throw new Error('list should not be called');
    },
    async getOrderById() {
      return options.order === 'found' ? createOrderDtoForQueryTest() : null;
    },
    async getOrderAudit() {
      throw new Error('getOrderAudit should not be called');
    },
    async getOrderFormData() {
      throw new Error('getOrderFormData should not be called');
    },
  };
  const controller = new OrdersController(
    {} as never,
    new OrderQueryService({ reader, history: new PgOrderReadRepository(database) }),
    {} as never,
    {} as never,
    {
      getFeatureFlags: () => ({ ordersEnabled: options.ordersEnabled ?? true, ordersReadOnly: true }),
    } as unknown as OrdersRuntimeConfigService,
    database,
  );
  return { controller, queries };
}

/** An audit row as a careless `SELECT *` would return it: payload and technical columns included. */
function dirtyRow(auditId: string, event: string, createdAt: string, extra: Record<string, unknown>) {
  return {
    audit_id: auditId,
    event,
    created_at: new Date(createdAt),
    username: 'manager',
    entity_type: 'order',
    status_field: null,
    status_name: null,
    stage_code: null,
    before_json: { total_amount: 100 },
    after_json: { total_amount: 200 },
    diff_json: { total_amount: { before: 100, after: 200 } },
    metadata_json: { requestId: 'request-command-1', bitrixId: '18204' },
    request_id: 'request-command-1',
    ip_address: '10.0.0.1',
    user_agent: 'browser',
    user_id: 7,
    role: 'manager',
    source: 'ui',
    related_payment_id: 5,
    ...extra,
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: 'history-user', username: 'history-user', role: 'viewer', roleId: 100, permissions };
}

import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import { PgVisibilityAdapter } from './pg-visibility';

function buildContext(overrides: Partial<NotificationEventContext>): NotificationEventContext {
  return {
    eventType: 'order.production_status_changed',
    outboxEventId: 'evt-1',
    aggregateType: 'order',
    aggregateId: '500',
    orderId: 500,
    clientId: null,
    paymentId: null,
    deadlineId: null,
    deadlineInstanceId: null,
    orderStatusId: null,
    isOrderCompleted: false,
    payload: {},
    ...overrides,
  };
}

describe('PgVisibilityAdapter (fail-closed guards)', () => {
  it('returns [] for empty userIds without querying', async () => {
    const query = vi.fn();
    const client = { query } as unknown as DatabaseClient;
    const result = await new PgVisibilityAdapter().filterByBaseVisibility(client, [], buildContext({}));
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed (returns []) when the event has no order anchor, without querying', async () => {
    const query = vi.fn();
    const client = { query } as unknown as DatabaseClient;
    const result = await new PgVisibilityAdapter().filterByBaseVisibility(
      client,
      [1, 2, 3],
      buildContext({ orderId: null }),
    );
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  // Live role matrix (same source as backend authorization), not static role defaults.
  function matrixClient(input: {
    users: Array<{ user_id: string; role_id: number; manager_id?: number; created_by?: number }>;
    permissions: Array<{ role_id: number; permission_name: string }>;
    scopes: Array<{ role_id: number; scope_key: string; scope_value: string }>;
    assigned?: string[];
  }) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('CROSS JOIN public.orders')) {
        return { rows: input.users.map((u) => ({ username: 'u', order_id: 500, created_by: u.created_by ?? 99, manager_id: u.manager_id ?? 99, ...u })) };
      }
      if (sql.includes('FROM public.role_permissions')) return { rows: input.permissions };
      if (sql.includes('FROM public.role_policy_scopes')) return { rows: input.scopes };
      if (sql.includes('FROM public.order_workshops')) return { rows: (input.assigned ?? []).map((user_id) => ({ user_id })) };
      return { rows: [] };
    });
    return { query, client: { query } as unknown as DatabaseClient };
  }
  const visible = (client: DatabaseClient, ids: number[]) =>
    new PgVisibilityAdapter().filterByBaseVisibility(client, ids, buildContext({ orderId: 500 }));

  it('keeps a user whose live role has orders.view with scope all; drops users missing from the order query', async () => {
    const { client } = matrixClient({
      users: [{ user_id: '1', role_id: 10 }],
      permissions: [{ role_id: 10, permission_name: 'orders.view' }],
      scopes: [{ role_id: 10, scope_key: 'orders.view', scope_value: 'all' }],
    });
    expect(await visible(client, [1, 2])).toEqual([1]);
  });

  it('drops a user whose live role lost orders.view (static defaults would still allow it)', async () => {
    const { client } = matrixClient({
      users: [{ user_id: '1', role_id: 10 }],
      permissions: [{ role_id: 10, permission_name: 'orders.rework' }],
      scopes: [{ role_id: 10, scope_key: 'orders.view', scope_value: 'all' }],
    });
    expect(await visible(client, [1])).toEqual([]);
  });

  it('applies the live scope: none drops, own keeps only the own order', async () => {
    const perms = [{ role_id: 10, permission_name: 'orders.view' }];
    expect(await visible(matrixClient({ users: [{ user_id: '1', role_id: 10 }], permissions: perms,
      scopes: [{ role_id: 10, scope_key: 'orders.view', scope_value: 'none' }] }).client, [1])).toEqual([]);
    expect(await visible(matrixClient({ users: [{ user_id: '1', role_id: 10 }], permissions: perms,
      scopes: [{ role_id: 10, scope_key: 'orders.view', scope_value: 'own' }] }).client, [1])).toEqual([]);
    expect(await visible(matrixClient({ users: [{ user_id: '1', role_id: 10, manager_id: 1 }], permissions: perms,
      scopes: [{ role_id: 10, scope_key: 'orders.view', scope_value: 'own' }] }).client, [1])).toEqual([1]);
  });

  it('applies the live assigned scope through order workshop responsibility', async () => {
    const base = { permissions: [{ role_id: 11, permission_name: 'orders.view' }],
      scopes: [{ role_id: 11, scope_key: 'orders.view', scope_value: 'assigned' }] };
    const users = [{ user_id: '1', role_id: 11 }, { user_id: '2', role_id: 11 }];
    expect(await visible(matrixClient({ ...base, users, assigned: ['1'] }).client, [1, 2])).toEqual([1]);
    expect(await visible(matrixClient({ ...base, users, assigned: [] }).client, [1, 2])).toEqual([]);
  });

  it('fails closed for a role without matrix rows', async () => {
    const { client } = matrixClient({ users: [{ user_id: '1', role_id: 1 }], permissions: [], scopes: [] });
    expect(await visible(client, [1])).toEqual([]);
  });
});

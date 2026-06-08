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

  it('delegates to the shared order-visibility predicate when an order anchor is present', async () => {
    // Shape rows so the shared helper resolves user 1 as base-visible (admin role_id 1, manager of the order).
    const query = vi.fn().mockResolvedValue({
      rows: [{ user_id: '1', username: 'u1', role_id: 1, order_id: 500, created_by: 1, manager_id: 1 }],
    });
    const client = { query } as unknown as DatabaseClient;
    const result = await new PgVisibilityAdapter().filterByBaseVisibility(client, [1, 2], buildContext({ orderId: 500 }));
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toContain(1);
    expect(result).not.toContain(2); // user 2 absent from the visibility query result -> dropped
  });
});

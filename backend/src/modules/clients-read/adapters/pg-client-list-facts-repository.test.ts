import { describe, expect, it, vi } from 'vitest';
import { PgClientListFactsRepository } from './pg-client-list-facts-repository';

const row = { client_id: '5', primary_phone: '87001112233', phones_count: '2', orders_count: '3', last_order_id: '90', last_order_name: '2995', last_order_date: '2026-10-01' };

describe('client list facts read model', () => {
  it('asks nothing for an empty page', async () => {
    const query = vi.fn();
    await expect(new PgClientListFactsRepository({ query } as never).facts([], { kind: 'all' })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('counts all orders for the scope «all»', async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    await expect(new PgClientListFactsRepository({ query } as never).facts([5], { kind: 'all' })).resolves.toEqual([
      { clientId: 5, primaryPhone: '87001112233', phonesCount: 2, orders: { count: 3, last: { orderId: 90, orderName: '2995', orderDate: '2026-10-01' } } },
    ]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([[5]]);
    // CRM requests and drafts are not orders: both the count and the last order skip them
    expect(sql.match(/o\.delete_flag = false AND o\.order_kind = 'production_order' AND TRUE/g)).toHaveLength(2);
    // a phone with is_primary NULL must not outrank the primary one
    expect(sql).toContain('ORDER BY COALESCE(cp.is_primary, false) DESC, cp.phone_id');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('counts only the user\'s own orders for the scope «own»', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row, orders_count: '0', last_order_id: null, last_order_name: null, last_order_date: null }] }));
    await expect(new PgClientListFactsRepository({ query } as never).facts([5], { kind: 'own', userId: 42 })).resolves.toEqual([
      { clientId: 5, primaryPhone: '87001112233', phonesCount: 2, orders: { count: 0, last: null } },
    ]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([[5], 42]);
    expect(sql.match(/o\.order_kind = 'production_order' AND \(o\.created_by = \$2 OR o\.manager_id = \$2\)/g)).toHaveLength(2);
  });

  it('does not touch orders at all when the user may not see them', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row, orders_count: null, last_order_id: null, last_order_name: null, last_order_date: null }] }));
    await expect(new PgClientListFactsRepository({ query } as never).facts([5], { kind: 'none' })).resolves.toEqual([
      { clientId: 5, primaryPhone: '87001112233', phonesCount: 2, orders: null },
    ]);
    expect((query.mock.calls[0] as unknown as [string])[0]).not.toContain('FROM orders');
  });
});

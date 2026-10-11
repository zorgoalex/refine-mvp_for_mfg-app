import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../current-user';
import { appendOrderReadVisibilitySql, canReadOrder, orderReadVisibilityIsRestricted } from './order-read-scope-sql';
import { appendReferencedOrderVisibilitySql, isOrderReadable, readableOrderIds } from './order-read-visibility';
import { scopeSetsFromPolicy } from './scope-sets';
import { ROLE_POLICIES } from './role-policies';

const user = (role: CurrentUser['role'], view?: Array<'all' | 'own' | 'assigned'>): CurrentUser => {
  const sets = scopeSetsFromPolicy(ROLE_POLICIES[role]);
  return {
    id: '7', username: role, role, roleId: 0, permissions: [],
    policyScopeSets: view ? { ...sets, orders: { ...sets.orders, view } } : sets,
  } as CurrentUser;
};

describe('order read visibility (access groups 0A.4, user decision 2026-10-11)', () => {
  it('only «own» restricts reads; all and assigned (worker) stay unrestricted', () => {
    expect(orderReadVisibilityIsRestricted(user('manager'))).toBe(true);
    expect(orderReadVisibilityIsRestricted(user('worker'))).toBe(false);
    for (const role of ['superadmin', 'admin', 'top_manager', 'operator', 'packer', 'viewer'] as const) {
      expect(orderReadVisibilityIsRestricted(user(role)), role).toBe(false);
    }
    // A set with assigned (e.g. own + assigned from groups) stays unrestricted until assigned reads are decided.
    expect(orderReadVisibilityIsRestricted(user('manager', ['own', 'assigned']))).toBe(false);
    expect(orderReadVisibilityIsRestricted(user('manager', []))).toBe(true);
  });

  it('SQL: own = created or managed by the user; unrestricted = TRUE without a parameter; no grant = FALSE', () => {
    const params: unknown[] = ['x'];
    expect(appendOrderReadVisibilitySql(params, user('manager'), 'o')).toBe('(o.created_by = $2 OR o.manager_id = $2)');
    expect(params).toEqual(['x', 7]);
    const none: unknown[] = [];
    expect(appendOrderReadVisibilitySql(none, user('top_manager'))).toBe('TRUE');
    expect(none).toEqual([]);
    expect(appendOrderReadVisibilitySql([], user('manager', []))).toBe('FALSE');
    const ref: unknown[] = [];
    expect(appendReferencedOrderVisibilitySql(ref, user('manager'), 'd.order_id'))
      .toBe('(d.order_id IS NULL OR EXISTS (SELECT 1 FROM orders vis_o WHERE vis_o.order_id = d.order_id AND (vis_o.created_by = $1 OR vis_o.manager_id = $1)))');
    expect(appendReferencedOrderVisibilitySql([], user('admin'), 'd.order_id')).toBe('TRUE');
  });

  it('in memory: own orders only for the manager, everything for the others', () => {
    expect(canReadOrder(user('manager'), { createdByUserId: 7, managerUserId: 3 })).toBe(true);
    expect(canReadOrder(user('manager'), { createdByUserId: 3, managerUserId: '7' })).toBe(true);
    expect(canReadOrder(user('manager'), { createdByUserId: 3, managerUserId: null })).toBe(false);
    expect(canReadOrder(user('worker'), { createdByUserId: 3, managerUserId: 3 })).toBe(true);
  });

  it('DB helpers query only for restricted readers', async () => {
    const calls: string[] = [];
    const client = { query: async (text: string) => { calls.push(text); return { rows: [{ order_id: 5 }], rowCount: 1 }; } } as never;
    expect(await isOrderReadable(client, user('admin'), 5)).toBe(true);
    expect(await readableOrderIds(client, user('admin'), [5, 6])).toBeNull();
    expect(calls).toEqual([]);
    expect(await isOrderReadable(client, user('manager'), 5)).toBe(true);
    expect(await readableOrderIds(client, user('manager'), [5, 6, 6])).toEqual(new Set([5]));
    expect(calls).toHaveLength(2);
  });
});

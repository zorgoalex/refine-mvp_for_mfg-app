import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { scopeSetsFromPolicy } from '../../../permissions/policies/scope-sets';
import { decideDowelingWrite, type DowelingLinkedOrder } from './doweling-access';

// Orders: 101 mine (author + manager), 102 foreign, 103 mine as author with NULL manager, 104 deleted mine,
// 105 a mine non-production order.
const ORDERS = new Map<number, DowelingLinkedOrder>([
  [101, order(101, '7', '7')],
  [102, order(102, '8', '8')],
  [103, order(103, '7', null)],
  [104, { ...order(104, '7', '7'), deleted: true }],
  [105, { ...order(105, '7', '7'), productionOrder: false }],
]);

describe('decideDowelingWrite — the doweling rule shared by the commands, the order save and the snapshot import', () => {
  it('lets a user with update scope «all» change any doweling order and link it anywhere', () => {
    const user = userWith({ update: ['all'], view: ['all'] });
    expect(decide(user, [101, 102], [103])).toEqual({ kind: 'allowed' });
  });

  it('own-scope manager: own orders only, NULL manager_id counts as «own» when he is the author', () => {
    const user = userWith({ update: ['own'], view: ['all'] });
    expect(decide(user, [101], [103])).toEqual({ kind: 'allowed' });
    expect(decide(user, [101, 102], [])).toEqual({ kind: 'denied', orderIds: [102] });
    expect(decide(user, [101], [102])).toEqual({ kind: 'denied', orderIds: [102] });
  });

  it('answers «not found» for an order to link that the user cannot read, does not exist, is deleted or not production', () => {
    const user = userWith({ update: ['own'], view: ['own'] });
    // 102 is foreign and his reads are restricted to own orders: its existence is not disclosed.
    expect(decide(user, [], [102], new Set([101, 103, 104, 105]))).toEqual({ kind: 'order_not_found', orderIds: [102] });
    expect(decide(user, [], [999], new Set([101]))).toEqual({ kind: 'order_not_found', orderIds: [999] });
    expect(decide(user, [], [104], new Set([104]))).toEqual({ kind: 'order_not_found', orderIds: [104] });
    expect(decide(user, [], [105], new Set([105]))).toEqual({ kind: 'order_not_found', orderIds: [105] });
  });

  it('hides the doweling order itself when one of its current orders is unreadable', () => {
    const user = userWith({ update: ['own'], view: ['own'] });
    expect(decide(user, [101, 102], [], new Set([101]))).toEqual({ kind: 'doweling_hidden', orderIds: [102] });
  });

  it('a currently linked deleted order still needs update scope (unlinking it is a change of that order)', () => {
    const owner = userWith({ update: ['own'], view: ['all'] });
    expect(decide(owner, [104], [])).toEqual({ kind: 'allowed' });
  });

  it('scope «assigned» gives no write access without an assignment (same as the Hasura predicate)', () => {
    const user = userWith({ update: ['assigned'], view: ['all'] });
    expect(decide(user, [101], [])).toEqual({ kind: 'denied', orderIds: [101] });
  });

  it('a standalone doweling order (no orders) needs only doweling.update, checked by the caller', () => {
    const user = userWith({ update: ['own'], view: ['own'] });
    expect(decide(user, [], [], new Set())).toEqual({ kind: 'allowed' });
  });

  it('without orders.update nothing linked to an order can be changed', () => {
    const user = { ...userWith({ update: ['all'], view: ['all'] }), permissions: ['doweling.update', 'orders.view'] };
    expect(decide(user, [101], [])).toEqual({ kind: 'denied', orderIds: [101] });
  });
});

function decide(user: CurrentUser, current: number[], added: number[], readable: Set<number> | null = null) {
  return decideDowelingWrite(user, { currentOrderIds: current, addedOrderIds: added, orders: ORDERS, readableOrderIds: readable });
}

function order(orderId: number, createdBy: string | null, manager: string | null): DowelingLinkedOrder {
  return { orderId, createdByUserId: createdBy, managerUserId: manager, deleted: false, productionOrder: true };
}

function userWith(scopes: { update: Array<'all' | 'own' | 'assigned'>; view: Array<'all' | 'own' | 'assigned'> }): CurrentUser {
  const base = scopeSetsFromPolicy(ROLE_POLICIES.manager);
  return {
    id: '7',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
    policyScopeSets: { ...base, orders: { ...base.orders, update: scopes.update, view: scopes.view } },
  };
}

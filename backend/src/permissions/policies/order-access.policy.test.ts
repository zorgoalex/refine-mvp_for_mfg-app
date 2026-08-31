import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../current-user';
import { getPermissionsForRole } from '../permissions';
import { OrderAccessPolicy } from './order-access.policy';

function user(role: CurrentUser['role'], id = 'user_1'): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}

describe('OrderAccessPolicy', () => {
  const policy = new OrderAccessPolicy();
  const ownOrder = { orderId: 1, createdByUserId: 'user_1' };
  const otherOrder = { orderId: 2, createdByUserId: 'user_2' };
  const assignedOrder = { orderId: 3, assignedUserIds: ['user_1'] };

  it('allows admin and superadmin across all orders', () => {
    expect(policy.canUpdate(user('admin'), otherOrder)).toBe(true);
    expect(policy.canDelete(user('superadmin'), otherOrder)).toBe(true);
  });

  it('limits manager update/export to own orders', () => {
    expect(policy.canUpdate(user('manager'), ownOrder)).toBe(true);
    expect(policy.canUpdate(user('manager'), otherOrder)).toBe(false);
    expect(policy.canExport(user('manager'), ownOrder)).toBe(true);
  });

  it('allows top manager to delete any order and manager to delete only own orders', () => {
    expect(policy.canDelete(user('top_manager'), otherOrder)).toBe(true);
    expect(policy.canDelete(user('manager'), ownOrder)).toBe(true);
    expect(policy.canDelete(user('manager'), otherOrder)).toBe(false);
  });

  it('allows worker only assigned order view and no whole-order update', () => {
    expect(policy.canView(user('worker'), assignedOrder)).toBe(true);
    expect(policy.canView(user('worker'), otherOrder)).toBe(false);
    expect(policy.canUpdate(user('worker'), assignedOrder)).toBe(false);
  });

  it('keeps viewer read-only', () => {
    expect(policy.canView(user('viewer'), otherOrder)).toBe(true);
    expect(policy.canUpdate(user('viewer'), otherOrder)).toBe(false);
    expect(policy.canExport(user('viewer'), otherOrder)).toBe(false);
  });
});

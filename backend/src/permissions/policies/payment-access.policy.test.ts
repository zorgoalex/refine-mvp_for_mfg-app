import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../current-user';
import { getPermissionsForRole } from '../permissions';
import { PaymentAccessPolicy } from './payment-access.policy';

function user(role: CurrentUser['role'], id = 'user_1'): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}

describe('PaymentAccessPolicy', () => {
  const policy = new PaymentAccessPolicy();

  it('allows manager payments on own order only', () => {
    expect(
      policy.canUpdate(user('manager'), {
        paymentId: 1,
        order: { createdByUserId: 'user_1' },
      }),
    ).toBe(true);
    expect(
      policy.canUpdate(user('manager'), {
        paymentId: 1,
        order: { createdByUserId: 'user_2' },
      }),
    ).toBe(false);
  });

  it('denies operator payments until business decision is confirmed', () => {
    expect(
      policy.canView(user('operator'), {
        paymentId: 1,
        order: { createdByUserId: 'user_1' },
      }),
    ).toBe(false);
  });

  it('allows admin payment delete', () => {
    expect(
      policy.canDelete(user('admin'), {
        paymentId: 1,
        order: { createdByUserId: 'user_2' },
      }),
    ).toBe(true);
  });
});

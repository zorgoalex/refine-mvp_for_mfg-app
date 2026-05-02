import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { InMemoryOrderExportRateLimiter } from './order-export-rate-limiter';

describe('InMemoryOrderExportRateLimiter', () => {
  it('limits export attempts by user and order', () => {
    const limiter = new InMemoryOrderExportRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const command = {
      currentUser: manager(),
      orderId: 42,
      request: { format: 'xlsx' as const, fileName: null },
    };

    limiter.assertAllowed(command);
    limiter.assertAllowed(command);

    expect(() => limiter.assertAllowed(command)).toThrow('Order export rate limit exceeded');
    expect(() => limiter.assertAllowed({ ...command, orderId: 43 })).not.toThrow();
  });
});

function manager(): CurrentUser {
  return {
    id: 'manager-id',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

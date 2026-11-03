import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { assertImportedManagerAllowed } from './pg-order-snapshot';

function user(id: string, permissions: PermissionName[]): CurrentUser {
  return { id, username: `u${id}`, role: 'top_manager', roleId: 15, permissions };
}

function tx(activeIds: string[]) {
  const queries: unknown[][] = [];
  return {
    queries,
    query: async (_sql: string, params: unknown[]) => {
      queries.push(params);
      return { rows: [{ ok: activeIds.includes(String(params[0])) }] };
    },
  };
}

const run = (managerId: number | null, currentUser: CurrentUser, active: string[] = ['10', '12']) =>
  assertImportedManagerAllowed(tx(active) as never, managerId, { currentUser } as never);

describe('snapshot import: the manager rule of save-order', () => {
  it('a snapshot without a manager, or naming the importing user, passes', async () => {
    await expect(run(null, user('7', ['orders.import']))).resolves.toBeUndefined();
    await expect(run(7, user('7', ['orders.import']))).resolves.toBeUndefined();
  });

  it('another manager without orders.manager.change is refused (403): no bypass through the import', async () => {
    await expect(run(12, user('7', ['orders.import']))).rejects.toMatchObject({ statusCode: 403, code: 'ORDER_MANAGER_CHANGE_FORBIDDEN' });
  });

  it('with the permission, an inactive or service user is refused (422), an active one passes', async () => {
    await expect(run(99, user('7', ['orders.import', 'orders.manager.change']))).rejects.toMatchObject({ statusCode: 422 });
    await expect(run(12, user('7', ['orders.import', 'orders.manager.change']))).resolves.toBeUndefined();
  });
});

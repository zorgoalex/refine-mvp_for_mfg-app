import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderResourceDemandService } from './order-resource-demand.service';

describe('OrderResourceDemandService', () => {
  it('requires orders.view before reading the projection', async () => {
    const list = vi.fn();
    const service = new OrderResourceDemandService({ demands: { list } });

    await expect(service.list({
      currentUser: user([]),
      query: { page: 1, pageSize: 20 },
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(list).not.toHaveBeenCalled();
  });

  it('delegates an authorized query unchanged', async () => {
    const expected = {
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
      refreshedAt: '2026-07-31T00:00:00.000Z',
    };
    const list = vi.fn().mockResolvedValue(expected);
    const service = new OrderResourceDemandService({ demands: { list } });
    const command = {
      currentUser: user(['orders.view']),
      query: { page: 1, pageSize: 20, supplierId: 7 },
    };

    await expect(service.list(command)).resolves.toBe(expected);
    expect(list).toHaveBeenCalledWith(command);
  });
});

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '7',
    username: 'worker@example.test',
    role: 'viewer',
    roleId: 7,
    permissions,
  };
}

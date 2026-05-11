import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { UnavailableOrderReadRepository } from './unavailable-order-read-repository';

describe('UnavailableOrderReadRepository', () => {
  it('fails closed for list and getById before DB adapter is configured', async () => {
    const repository = new UnavailableOrderReadRepository();
    const command = {
      currentUser: {
        id: 'manager-id',
        username: 'manager',
        role: 'manager' as const,
        roleId: 10,
        permissions: getPermissionsForRole('manager'),
      },
      query: {
        page: 1,
        pageSize: 25,
        sortBy: 'updatedAt' as const,
        sortOrder: 'desc' as const,
        onlyMyOrders: false,
      },
    };

    await expect(repository.listOrders(command)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        feature: 'orders',
        adapter: 'order_read_repository',
      },
    } satisfies Partial<ApiError>);
    await expect(
      repository.getOrderById({ currentUser: command.currentUser, orderId: 42 }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    } satisfies Partial<ApiError>);
    await expect(
      repository.getOrderFormData({ currentUser: command.currentUser }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    } satisfies Partial<ApiError>);
  });
});

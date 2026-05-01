import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderListResponseDto } from '../dto/order.dto';
import type { OrderReadRepositoryPort } from './order-query.types';
import { OrderQueryService } from './order-query.service';
import { createOrderDtoForQueryTest } from './order-query.test-helpers';

describe('OrderQueryService', () => {
  it('requires orders.view permission before listing orders', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.list({ currentUser: userWithoutOrderView(), query: defaultQuery() }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view'],
      },
    } satisfies Partial<ApiError>);
  });

  it('delegates list to read repository after permission check', async () => {
    const response: OrderListResponseDto = {
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    };
    const calls: string[] = [];
    const service = new OrderQueryService({
      reader: {
        async listOrders(command) {
          calls.push(`${command.currentUser.id}:${command.query.sortBy}`);
          return response;
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
      },
    });

    await expect(
      service.list({ currentUser: currentUser(), query: defaultQuery() }),
    ).resolves.toEqual(response);
    expect(calls).toEqual(['manager-id:updatedAt']);
  });

  it('returns order by id and maps missing order to ORDER_NOT_FOUND', async () => {
    const order = createOrderDtoForQueryTest(42);
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById(command) {
          return command.orderId === 42 ? order : null;
        },
      },
    });

    await expect(service.getById({ currentUser: currentUser(), orderId: 42 })).resolves.toBe(
      order,
    );
    await expect(service.getById({ currentUser: currentUser(), orderId: 99 })).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
      details: { orderId: 99 },
    } satisfies Partial<ApiError>);
  });
});

function currentUser(): CurrentUser {
  return {
    id: 'manager-id',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

function userWithoutOrderView(): CurrentUser {
  return {
    id: 'no-view',
    username: 'no-view',
    role: 'viewer',
    roleId: 100,
    permissions: [],
  };
}

function defaultQuery() {
  return {
    page: 1,
    pageSize: 25,
    sortBy: 'updatedAt' as const,
    sortOrder: 'desc' as const,
    onlyMyOrders: false,
  };
}

function readerThatShouldNotBeCalled(): OrderReadRepositoryPort {
  return {
    async listOrders() {
      throw new Error('list should not be called');
    },
    async getOrderById() {
      throw new Error('getById should not be called');
    },
  };
}

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type { OrderAuditListResponseDto, OrderListResponseDto } from '../dto/order.dto';
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
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
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
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
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

  it('requires orders.view permission before loading order form data', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.getFormData({ currentUser: userWithoutOrderView() }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view'],
      },
    } satisfies Partial<ApiError>);
  });

  it('requires orders.view_audit permission before loading order audit', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.getAudit({
        currentUser: currentUser(),
        orderId: 42,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-1',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view_audit'],
      },
    } satisfies Partial<ApiError>);
  });

  it('checks order existence and delegates audit loading after permission checks', async () => {
    const order = createOrderDtoForQueryTest(42);
    const response: OrderAuditListResponseDto = {
      data: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
      requestId: 'request-audit-1',
    };
    const calls: string[] = [];
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById(command) {
          calls.push(`get:${command.orderId}`);
          return command.orderId === 42 ? order : null;
        },
        async getOrderAudit(command) {
          calls.push(`audit:${command.orderId}:${command.page}:${command.pageSize}`);
          return response;
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    await expect(
      service.getAudit({
        currentUser: currentUserWithAuditPermission(),
        orderId: 42,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-1',
      }),
    ).resolves.toBe(response);
    await expect(
      service.getAudit({
        currentUser: currentUserWithAuditPermission(),
        orderId: 99,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-2',
      }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
      details: { orderId: 99 },
    } satisfies Partial<ApiError>);
    expect(calls).toEqual(['get:42', 'audit:42:1:50', 'get:99']);
  });

  it('delegates form data loading to read repository after permission check', async () => {
    const response = createOrderFormDataResponse();
    const calls: string[] = [];
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData(command) {
          calls.push(`form-data:${command.currentUser.id}`);
          return response;
        },
      },
    });

    await expect(service.getFormData({ currentUser: currentUser() })).resolves.toBe(response);
    expect(calls).toEqual(['form-data:manager-id']);
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

function currentUserWithAuditPermission(): CurrentUser {
  return {
    id: 'top-manager-id',
    username: 'top-manager',
    role: 'top_manager',
    roleId: 15,
    permissions: getPermissionsForRole('top_manager'),
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
    async getOrderAudit() {
      throw new Error('getOrderAudit should not be called');
    },
    async getOrderFormData() {
      throw new Error('getOrderFormData should not be called');
    },
  };
}

function createOrderFormDataResponse(): OrderFormDataResponseDto {
  return {
    clients: [{ id: 1, name: 'Client' }],
    materials: [{ id: 2, name: 'MDF', unitId: 1 }],
    millingTypes: [{ id: 3, name: 'Modern', costPerSqm: 120 }],
    edgeTypes: [{ id: 4, name: 'PVC' }],
    films: [{ id: 5, name: 'White' }],
    orderStatuses: [{ id: 6, name: 'New', color: '#ffffff' }],
    paymentStatuses: [{ id: 7, name: 'Unpaid', code: 'unpaid', color: '#ff0000' }],
    paymentTypes: [{ id: 8, name: 'Cash' }],
    productionStatuses: [{ id: 9, name: 'Cut', code: 'cut', color: '#00ff00' }],
    workshops: [{ id: 10, name: 'Workshop' }],
    employees: [{ id: 11, fullName: 'Employee' }],
    units: [{ id: 12, code: 'pcs', name: 'Pieces', symbol: 'pcs' }],
  };
}

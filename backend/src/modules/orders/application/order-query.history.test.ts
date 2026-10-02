import { describe, expect, it } from 'vitest';
import type { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import type { OrderHistoryListResponseDto } from '../dto/order.dto';
import { ORDER_HISTORY_COMMON_EVENTS, ORDER_HISTORY_FINANCIAL_EVENTS, type OrderHistoryVisibility } from './order-history-events';
import { OrderQueryService } from './order-query.service';
import { createOrderDtoForQueryTest } from './order-query.test-helpers';
import type { GetOrderByIdCommand, OrderReadRepositoryPort } from './order-query.types';

const emptyHistory: OrderHistoryListResponseDto = {
  data: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
};

describe('OrderQueryService.getHistory', () => {
  it('requires orders.view and reads nothing without it', async () => {
    const calls: string[] = [];
    const service = createService({ calls, order: 'found' });

    await expect(
      service.getHistory({ currentUser: user([]), orderId: 42, page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['orders.view'] },
    } satisfies Partial<ApiError>);
    expect(calls).toEqual([]);
  });

  it('returns 404 for an order the user cannot open and never reads its history', async () => {
    const calls: string[] = [];
    const service = createService({ calls, order: 'missing' });

    await expect(
      service.getHistory({ currentUser: user(['orders.view']), orderId: 42, page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toEqual(['getOrderById:42:deleted=false']);
  });

  it('serves a user with orders.view only — no audit, finance or payment rights needed', async () => {
    const calls: string[] = [];
    const visibilities: OrderHistoryVisibility[] = [];
    const service = createService({ calls, order: 'found', visibilities });

    await expect(
      service.getHistory({ currentUser: user(['orders.view']), orderId: 42, page: 2, pageSize: 10 }),
    ).resolves.toEqual(emptyHistory);
    expect(calls).toEqual(['getOrderById:42:deleted=false', 'getOrderHistory:42:2:10']);
    expect(visibilities).toEqual([{ events: [...ORDER_HISTORY_COMMON_EVENTS], includeFinancial: false }]);
  });

  it.each([
    [['orders.view', 'orders.view_financials'] as PermissionName[], false],
    [['orders.view', 'payments.view'] as PermissionName[], false],
    [['orders.view', 'audit.view', 'orders.view_audit'] as PermissionName[], false],
    [['orders.view', 'orders.view_financials', 'payments.view'] as PermissionName[], true],
  ])('permissions %j → financial facts %s', async (permissions, includeFinancial) => {
    const visibilities: OrderHistoryVisibility[] = [];
    const service = createService({ calls: [], order: 'found', visibilities });

    await service.getHistory({ currentUser: user(permissions), orderId: 42, page: 1, pageSize: 20 });

    expect(visibilities).toHaveLength(1);
    expect(visibilities[0].includeFinancial).toBe(includeFinancial);
    expect(visibilities[0].events).toEqual(
      includeFinancial
        ? [...ORDER_HISTORY_COMMON_EVENTS, ...ORDER_HISTORY_FINANCIAL_EVENTS]
        : [...ORDER_HISTORY_COMMON_EVENTS],
    );
  });

  it('answers 503 when the history reader is not wired', async () => {
    const service = new OrderQueryService({ reader: reader({ calls: [], order: 'found' }) });

    await expect(
      service.getHistory({ currentUser: user(['orders.view']), orderId: 42, page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

interface Fixture {
  calls: string[];
  order: 'found' | 'missing';
  visibilities?: OrderHistoryVisibility[];
}

function createService(fixture: Fixture): OrderQueryService {
  return new OrderQueryService({
    reader: reader(fixture),
    history: {
      async getOrderHistory(command, visibility) {
        fixture.calls.push(`getOrderHistory:${command.orderId}:${command.page}:${command.pageSize}`);
        fixture.visibilities?.push(visibility);
        return emptyHistory;
      },
    },
  });
}

function reader(fixture: Fixture): OrderReadRepositoryPort {
  return {
    async listOrders() {
      throw new Error('list should not be called');
    },
    async getOrderById(command: GetOrderByIdCommand) {
      fixture.calls.push(`getOrderById:${command.orderId}:deleted=${command.includeDeleted === true}`);
      return fixture.order === 'found' ? createOrderDtoForQueryTest() : null;
    },
    async getOrderAudit() {
      throw new Error('getOrderAudit should not be called');
    },
    async getOrderFormData() {
      throw new Error('getOrderFormData should not be called');
    },
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return { id: 'history-user', username: 'history-user', role: 'viewer', roleId: 100, permissions };
}

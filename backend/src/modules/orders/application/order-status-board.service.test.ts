import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderStatusBoardResponseDto } from '../dto/order-status-board.dto';
import { OrderStatusBoardService } from './order-status-board.service';

describe('OrderStatusBoardService', () => {
  it('requires orders.view before calling the repository', async () => {
    const service = new OrderStatusBoardService({
      boards: {
        async getBoard() {
          throw new Error('repository must not be called');
        },
      },
    });

    await expect(
      service.get({
        currentUser: user('viewer', []),
        query: defaultQuery(),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });

  it('masks every financial card field without orders.view_financials', async () => {
    const service = new OrderStatusBoardService({
      boards: { async getBoard() { return response(); } },
    });

    const result = await service.get({
      currentUser: user('viewer', ['orders.view']),
      query: defaultQuery(),
    });

    expect(result.financialsVisible).toBe(false);
    expect(result.columns[0]?.cards[0]).toMatchObject({
      paymentStatusId: null,
      paymentStatusName: null,
      finalAmount: null,
      paidAmount: null,
      debtAmount: null,
      partsCount: 5,
    });
  });

  it('rejects the production board for packer before calling the repository', async () => {
    const service = new OrderStatusBoardService({
      boards: {
        async getBoard() {
          throw new Error('repository must not be called');
        },
      },
    });

    await expect(
      service.get({
        currentUser: user('packer', getPermissionsForRole('packer')),
        query: { ...defaultQuery(), board: 'production' },
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: { requiredPermissions: ['productionTasks.view'] },
    });
  });

  it('keeps financials for an authorized role', async () => {
    const expected = response();
    const service = new OrderStatusBoardService({
      boards: { async getBoard() { return expected; } },
    });

    await expect(
      service.get({
        currentUser: user('manager', getPermissionsForRole('manager')),
        query: defaultQuery(),
      }),
    ).resolves.toMatchObject({
      financialsVisible: true,
      columns: [{ cards: [{ finalAmount: 1000, debtAmount: 750 }] }],
    });
  });
});

function defaultQuery() {
  return {
    board: 'order' as const,
    limit: 24,
    onlyMyOrders: false,
    overdueOnly: false,
  };
}

function user(role: CurrentUser['role'], permissions: readonly string[]): CurrentUser {
  return {
    id: '42',
    username: role,
    role,
    roleId: 100,
    permissions: permissions as CurrentUser['permissions'],
  };
}

function response(): OrderStatusBoardResponseDto {
  return {
    board: 'order',
    generatedAt: '2026-07-19T00:00:00.000Z',
    filterKey: 'sha256:test',
    financialsVisible: true,
    columns: [
      {
        key: '1',
        status: {
          id: 1,
          code: null,
          name: 'Новый',
          color: '#999',
          sortOrder: 10,
          isActive: true,
        },
        total: 1,
        nextCursor: null,
        cards: [
          {
            orderId: 10,
            orderName: '10',
            fullNumber: 'МП-10',
            clientId: 1,
            clientName: 'Client',
            priority: 100,
            plannedCompletionDate: null,
            pastPlannedDate: false,
            orderStatusId: 1,
            orderStatusName: 'Новый',
            productionStatusId: null,
            productionStatusName: null,
            productionStatusFromDetailsEnabled: true,
            paymentStatusId: 2,
            paymentStatusName: 'Частично',
            finalAmount: 1000,
            paidAmount: 250,
            debtAmount: 750,
            partsCount: 5,
            totalArea: 3.2,
            managerId: 42,
            managerName: 'Manager',
            updatedAt: '2026-07-19T00:00:00.000Z',
            version: 3,
            canChangeOrderStatus: false,
            canChangeProductionStatus: false,
          },
        ],
      },
    ],
  };
}

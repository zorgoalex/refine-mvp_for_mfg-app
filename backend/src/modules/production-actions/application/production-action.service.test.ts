import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { ProductionActionRepositoryPort } from './production-action.types';
import { ProductionActionService } from './production-action.service';

describe('ProductionActionService', () => {
  it('requires command-specific permissions before delegating', async () => {
    const service = new ProductionActionService({ productionActions: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.moveCalendarDate({
        currentUser: viewer,
        orderId: 15,
        dto: { plannedCompletionDate: '2026-05-20', version: 3, idempotencyKey: 'move-key-1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('delegates allowed commands to the repository', async () => {
    const calls: string[] = [];
    const service = new ProductionActionService({
      productionActions: createRepository({
        async moveCalendarDate(command) {
          calls.push(`move:${command.orderId}`);
          return response();
        },
        async changeOrderStatus(command) {
          calls.push(`status:${command.dto.orderStatusId}`);
          return response();
        },
        async changePaymentStatus(command) {
          calls.push(`payment-status:${command.dto.paymentStatusId}`);
          return response();
        },
        async changeProductionStatus(command) {
          calls.push(`production-status:${command.dto.productionStatusId}`);
          return response();
        },
        async activateProductionStage(command) {
          calls.push(`activate:${command.productionStatusId}`);
          return response();
        },
        async deactivateProductionStage(command) {
          calls.push(`deactivate:${command.productionStatusId}`);
          return response();
        },
        async activateDetailProductionStage(command) {
          calls.push(`detail-activate:${command.detailId}:${command.productionStatusId}`);
          return response();
        },
      }),
    });
    const admin = currentUser('admin');

    await service.moveCalendarDate({
      currentUser: admin,
      orderId: 15,
      dto: { plannedCompletionDate: '2026-05-20', version: 3, idempotencyKey: 'move-key-1' },
    });
    await service.changeOrderStatus({
      currentUser: admin,
      orderId: 15,
      dto: { orderStatusId: 5, version: 4, idempotencyKey: 'status-key-1' },
    });
    await service.changePaymentStatus({
      currentUser: admin,
      orderId: 15,
      dto: { paymentStatusId: 3, version: 5, idempotencyKey: 'payment-status-key-1' },
    });
    await service.changeProductionStatus({
      currentUser: admin,
      orderId: 15,
      dto: { productionStatusId: 2, version: 6, idempotencyKey: 'production-status-key-1' },
    });
    await service.activateProductionStage({
      currentUser: admin,
      orderId: 15,
      productionStatusId: 4,
      dto: { version: 6, idempotencyKey: 'stage-on-key-1' },
    });
    await service.deactivateProductionStage({
      currentUser: admin,
      orderId: 15,
      productionStatusId: 4,
      dto: { version: 6, idempotencyKey: 'stage-off-key-1' },
    });
    await service.activateDetailProductionStage({
      currentUser: admin,
      detailId: 99,
      productionStatusId: 4,
      dto: { idempotencyKey: 'detail-stage-key-1', note: 'started cutting' },
    });

    expect(calls).toEqual([
      'move:15',
      'status:5',
      'payment-status:3',
      'production-status:2',
      'activate:4',
      'deactivate:4',
      'detail-activate:99:4',
    ]);
  });

  it('requires order production status permissions for detail production events', async () => {
    const service = new ProductionActionService({ productionActions: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.activateDetailProductionStage({
        currentUser: viewer,
        detailId: 99,
        productionStatusId: 4,
        dto: { idempotencyKey: 'detail-stage-key-1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['orders.change_production_status', 'orders.update'],
      },
    } satisfies Partial<ApiError>);
  });

  it('requires order production status permissions for manual current production status', async () => {
    const service = new ProductionActionService({ productionActions: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.changeProductionStatus({
        currentUser: viewer,
        orderId: 15,
        dto: { productionStatusId: 2, version: 6, idempotencyKey: 'production-status-key-1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['orders.change_production_status', 'orders.update'],
      },
    } satisfies Partial<ApiError>);
  });
});

function createRepository(
  overrides: Partial<ProductionActionRepositoryPort> = {},
): ProductionActionRepositoryPort {
  return {
    async moveCalendarDate() {
      throw new Error('moveCalendarDate should not be called');
    },
    async changeOrderStatus() {
      throw new Error('changeOrderStatus should not be called');
    },
    async changePaymentStatus() {
      throw new Error('changePaymentStatus should not be called');
    },
    async changeProductionStatus() {
      throw new Error('changeProductionStatus should not be called');
    },
    async activateProductionStage() {
      throw new Error('activateProductionStage should not be called');
    },
    async deactivateProductionStage() {
      throw new Error('deactivateProductionStage should not be called');
    },
    async activateDetailProductionStage() {
      throw new Error('activateDetailProductionStage should not be called');
    },
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role']): CurrentUser {
  return {
    id: `${role}-id`,
    username: role,
    role,
    roleId: 1,
    permissions: getPermissionsForRole(role),
  };
}

function response() {
  return { order: { orderId: 15, version: 4 }, requestId: 'request-1' };
}

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, type PermissionName } from '../../../permissions/permissions';
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

  describe('production command coarse gate', () => {
    it('lets a worker (only orders.change_production_status) reach the repo for changeProductionStatus', async () => {
      let called = false;
      const service = new ProductionActionService({
        productionActions: createRepository({
          async changeProductionStatus() {
            called = true;
            return response();
          },
        }),
      });
      await service.changeProductionStatus({
        currentUser: currentUser('worker'),
        orderId: 15,
        dto: { productionStatusId: 2, version: 3, idempotencyKey: 'coarse-prod-1' },
      });
      expect(called).toBe(true);
    });

    it('lets a worker reach the repo for activateProductionStage', async () => {
      let called = false;
      const service = new ProductionActionService({
        productionActions: createRepository({
          async activateProductionStage() {
            called = true;
            return response();
          },
        }),
      });
      await service.activateProductionStage({
        currentUser: currentUser('worker'),
        orderId: 15,
        productionStatusId: 4,
        dto: { version: 6, idempotencyKey: 'coarse-stage-on-1' },
      });
      expect(called).toBe(true);
    });

    it('lets a worker reach the repo for deactivateProductionStage', async () => {
      let called = false;
      const service = new ProductionActionService({
        productionActions: createRepository({
          async deactivateProductionStage() {
            called = true;
            return response();
          },
        }),
      });
      await service.deactivateProductionStage({
        currentUser: currentUser('worker'),
        orderId: 15,
        productionStatusId: 4,
        dto: { version: 6, idempotencyKey: 'coarse-stage-off-1' },
      });
      expect(called).toBe(true);
    });

    it('lets a worker reach the repo for activateDetailProductionStage', async () => {
      let called = false;
      const service = new ProductionActionService({
        productionActions: createRepository({
          async activateDetailProductionStage() {
            called = true;
            return response();
          },
        }),
      });
      await service.activateDetailProductionStage({
        currentUser: currentUser('worker'),
        detailId: 99,
        productionStatusId: 4,
        dto: { idempotencyKey: 'coarse-detail-1' },
      });
      expect(called).toBe(true);
    });

    it('still denies a viewer (no orders.change_production_status) for changeProductionStatus', async () => {
      const service = new ProductionActionService({ productionActions: createRepository() });
      await expect(
        service.changeProductionStatus({
          currentUser: currentUser('viewer'),
          orderId: 15,
          dto: { productionStatusId: 2, version: 3, idempotencyKey: 'coarse-prod-deny-1' },
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    });
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
        async restoreAutoProductionStatus(command) {
          calls.push(`restore-auto:${command.orderId}`);
          return response();
        },
        async enterManualProductionStatus(command) {
          calls.push(`enter-manual:${command.orderId}`);
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
    await service.restoreAutoProductionStatus({
      currentUser: admin,
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'restore-auto-key-1' },
    });
    await service.enterManualProductionStatus({
      currentUser: admin,
      orderId: 15,
      dto: { version: 3, idempotencyKey: 'enter-manual-key-1' },
    });

    expect(calls).toEqual([
      'move:15',
      'status:5',
      'payment-status:3',
      'production-status:2',
      'activate:4',
      'deactivate:4',
      'detail-activate:99:4',
      'restore-auto:15',
      'enter-manual:15',
    ]);
  });

  it('requires finance visibility before changing payment status', async () => {
    const service = new ProductionActionService({ productionActions: createRepository() });

    await expect(
      service.changePaymentStatus({
        currentUser: userWithPermissions('viewer', ['orders.update', 'payments.update']),
        orderId: 15,
        dto: { paymentStatusId: 3, version: 5, idempotencyKey: 'payment-status-key-1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['payments.update', 'orders.update', 'orders.view_financials'] },
    } satisfies Partial<ApiError>);
  });

  it('delegates deadline-engine order status command without user permission checks', async () => {
    const calls: string[] = [];
    const service = new ProductionActionService({
      productionActions: createRepository({
        async changeOrderStatusFromDeadline(command) {
          calls.push(`${command.source}:${command.systemActor.actorLabel}:${command.orderId}:${command.targetOrderStatusId}`);
          return {
            status: 'executed',
            response: response(),
          };
        },
      }),
    });

    await expect(
      service.changeOrderStatusFromDeadline({
        source: 'deadline-engine',
        systemActor: {
          type: 'system',
          actorUserId: null,
          actorLabel: 'deadline-engine',
        },
        orderId: 15,
        expectedSourceOrderStatusId: 5,
        targetOrderStatusId: 7,
        deadlineId: 'deadline-1',
        deadlineEventId: 'event-1',
        actionRuleId: 'rule-1',
        ruleVersionId: null,
        ruleConfigSnapshot: { snapshotHash: 'sha256:rule-1' },
        idempotencyKey: 'deadline-status-key-1',
        requestId: 'request-deadline-status',
        occurredAt: '2026-05-25T10:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'executed',
      response: { order: { orderId: 15 } },
    });
    expect(calls).toEqual(['deadline-engine:deadline-engine:15:7']);
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
        // Coarse gate relaxed to capability-only; owner/assigned scope enforced in repo.
        requiredPermissions: ['orders.change_production_status'],
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
        requiredPermissions: ['orders.change_production_status'],
      },
    } satisfies Partial<ApiError>);
  });

  it('requires order production status permissions for restore-auto mode', async () => {
    const service = new ProductionActionService({ productionActions: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.restoreAutoProductionStatus({
        currentUser: viewer,
        orderId: 15,
        dto: { version: 3, idempotencyKey: 'restore-auto-key-1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['orders.change_production_status', 'orders.update'],
      },
    } satisfies Partial<ApiError>);
  });

  it('requires order production status permissions for enter-manual mode', async () => {
    const service = new ProductionActionService({ productionActions: createRepository() });
    const viewer = currentUser('viewer');

    await expect(
      service.enterManualProductionStatus({
        currentUser: viewer,
        orderId: 15,
        dto: { version: 3, idempotencyKey: 'enter-manual-key-1' },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['orders.change_production_status', 'orders.update'],
      },
    } satisfies Partial<ApiError>);
  });

  describe('changeBatchDetailProductionStatus coarse gate', () => {
    const batchDto = {
      detailIds: [100, 101],
      productionStatusId: 5,
      version: 3,
      idempotencyKey: 'batch-key-1',
    };

    it('lets a worker (only orders.change_production_status) reach the repo', async () => {
      let called = false;
      const service = new ProductionActionService({
        productionActions: createRepository({
          async changeBatchDetailProductionStatus() {
            called = true;
            return { ...response(), selectedDetailCount: 2, affectedDetailCount: 2 };
          },
        }),
      });

      await service.changeBatchDetailProductionStatus({
        currentUser: currentUser('worker'),
        orderId: 15,
        dto: batchDto,
      });

      expect(called).toBe(true);
    });

    it('rejects a viewer without orders.change_production_status (403)', async () => {
      const service = new ProductionActionService({ productionActions: createRepository() });

      await expect(
        service.changeBatchDetailProductionStatus({
          currentUser: currentUser('viewer'),
          orderId: 15,
          dto: batchDto,
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
      } satisfies Partial<ApiError>);
    });
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
    async changeOrderStatusFromDeadline() {
      throw new Error('changeOrderStatusFromDeadline should not be called');
    },
    async changeProductionStatusFromDeadline() {
      throw new Error('changeProductionStatusFromDeadline should not be called');
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
    async restoreAutoProductionStatus() {
      throw new Error('restoreAutoProductionStatus should not be called');
    },
    async enterManualProductionStatus() {
      throw new Error('enterManualProductionStatus should not be called');
    },
    async changeBatchDetailProductionStatus() {
      throw new Error('changeBatchDetailProductionStatus should not be called');
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

function userWithPermissions(role: CurrentUser['role'], permissions: PermissionName[]): CurrentUser {
  return {
    id: `${role}-custom-id`,
    username: `${role}_custom`,
    role,
    roleId: 1,
    permissions,
  };
}

function response() {
  return { order: { orderId: 15, version: 4 }, requestId: 'request-1' };
}

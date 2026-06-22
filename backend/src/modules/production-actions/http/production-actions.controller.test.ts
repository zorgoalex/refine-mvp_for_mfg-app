import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { ProductionActionService } from '../application/production-action.service';
import type { ChangeProductionStatusCommand } from '../application/production-action.types';
import {
  parseBatchDetailProductionStatusRequest,
  parseCalendarDateRequest,
  parseOrderDetailId,
  parseOrderId,
  parseOrderStatusRequest,
  parsePaymentStatusRequest,
  parseProductionStatusRequest,
  parseProductionStatusId,
  parseDetailStageEventRequest,
  parseStageEventRequest,
  parseProductionStatusModeRequest,
  ProductionActionsController,
} from './production-actions.controller';
import { OrderDetailProductionActionsController } from './order-detail-production-actions.controller';
import type { ProductionActionsRuntimeConfigService } from './production-actions-runtime-config.service';

describe('ProductionActionsController', () => {
  it('fails closed when production actions feature flag is disabled', async () => {
    const controller = createController({ flags: { productionActionsEnabled: false } });

    await expect(
      controller.moveCalendarDate({ user: currentUser() }, '15', calendarDateBody()),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'productionActions' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before service calls', async () => {
    const controller = createController({ flags: { productionActionsEnabled: true } });

    await expect(controller.changeOrderStatus({}, '15', orderStatusBody())).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('delegates all command endpoints to ProductionActionService', async () => {
    const calls: string[] = [];
    let productionStatusCommand: ChangeProductionStatusCommand | undefined;
    const service = {
      async moveCalendarDate(command) {
        calls.push(`move:${command.orderId}:${command.dto.plannedCompletionDate}`);
        return response();
      },
      async changeOrderStatus(command) {
        calls.push(`status:${command.orderId}:${command.dto.orderStatusId}`);
        return response();
      },
      async changePaymentStatus(command) {
        calls.push(`payment-status:${command.orderId}:${command.dto.paymentStatusId}`);
        return response();
      },
      async changeProductionStatus(command: ChangeProductionStatusCommand) {
        productionStatusCommand = command;
        calls.push(`production-status:${command.orderId}:${command.dto.productionStatusId}`);
        return response();
      },
      async activateProductionStage(command) {
        calls.push(`activate:${command.orderId}:${command.productionStatusId}`);
        return response();
      },
      async deactivateProductionStage(command) {
        calls.push(`deactivate:${command.orderId}:${command.productionStatusId}`);
        return response();
      },
      async activateDetailProductionStage(command) {
        calls.push(`detail-activate:${command.detailId}:${command.productionStatusId}:${command.dto.note}`);
        return response();
      },
      async restoreAutoProductionStatus() {
        return response();
      },
      async enterManualProductionStatus() {
        return response();
      },
    };
    const controller = createController({
      flags: { productionActionsEnabled: true },
      service,
    });
    const detailController = createDetailController({
      flags: { productionActionsEnabled: true },
      service,
    });

    await controller.moveCalendarDate({ user: currentUser() }, '15', calendarDateBody());
    await controller.changeOrderStatus({ user: currentUser() }, '15', orderStatusBody());
    await controller.changePaymentStatus({ user: currentUser() }, '15', paymentStatusBody());
    const productionStatusUser = currentUser();
    const productionStatusRequest = {
      user: productionStatusUser,
      requestId: 'request-production-status',
    };
    await controller.changeProductionStatus(
      productionStatusRequest,
      '15',
      productionStatusBody(),
    );
    await controller.activateProductionStage({ user: currentUser() }, '15', '4', stageBody());
    await controller.deactivateProductionStage({ user: currentUser() }, '15', '4', stageBody());
    await detailController.activateDetailProductionStage(
      { user: currentUser() },
      '99',
      '4',
      detailStageBody(),
    );

    expect(calls).toEqual([
      'move:15:2026-05-20',
      'status:15:5',
      'payment-status:15:3',
      'production-status:15:2',
      'activate:15:4',
      'deactivate:15:4',
      'detail-activate:99:4:started cutting',
    ]);
    expect(productionStatusCommand).toEqual({
      currentUser: productionStatusUser,
      orderId: 15,
      dto: {
        productionStatusId: 2,
        version: 3,
        idempotencyKey: 'production-status-key-1',
      },
      requestId: 'request-production-status',
    });
  });

  it('keeps the legacy order-status alias for existing callers', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: { productionActionsEnabled: true },
      service: {
        async changeOrderStatus(command) {
          calls.push(`status:${command.orderId}:${command.dto.orderStatusId}`);
          return response();
        },
      },
    });

    await controller.changeOrderStatusLegacy({ user: currentUser() }, '15', orderStatusBody());

    expect(calls).toEqual(['status:15:5']);
  });

  it('validates params and request bodies', () => {
    expect(parseOrderId('15')).toBe(15);
    expect(parseOrderDetailId('99')).toBe(99);
    expect(parseProductionStatusId('4')).toBe(4);
    expect(() => parseOrderId('0')).toThrow(ApiError);
    expect(() => parseOrderDetailId('-1')).toThrow(ApiError);
    expect(() => parseProductionStatusId('x')).toThrow(ApiError);
    expect(() => parseCalendarDateRequest({ ...calendarDateBody(), version: -1 })).toThrow(ApiError);
    expect(() => parseOrderStatusRequest({ ...orderStatusBody(), orderStatusId: 0 })).toThrow(ApiError);
    expect(() => parsePaymentStatusRequest({ ...paymentStatusBody(), paymentStatusId: 0 })).toThrow(ApiError);
    expect(parseProductionStatusRequest(productionStatusBody())).toEqual(productionStatusBody());
    expect(() => parseProductionStatusRequest({ ...productionStatusBody(), productionStatusId: 0 })).toThrow(ApiError);
    expect(() => parseStageEventRequest({ version: 1, idempotencyKey: 'short' })).toThrow(ApiError);
    expect(parseDetailStageEventRequest(detailStageBody())).toEqual(detailStageBody());
    expect(() => parseDetailStageEventRequest({ ...detailStageBody(), note: 5 })).toThrow(ApiError);
    expect(parseProductionStatusModeRequest(productionStatusModeBody())).toEqual(productionStatusModeBody());
    expect(() => parseProductionStatusModeRequest({ ...productionStatusModeBody(), version: -1 })).toThrow(ApiError);
    expect(() => parseProductionStatusModeRequest({ ...productionStatusModeBody(), idempotencyKey: 'short' })).toThrow(ApiError);
  });

  it('delegates restore-auto and enter-manual endpoints to ProductionActionService', async () => {
    const calls: string[] = [];
    const service = {
      async restoreAutoProductionStatus(command) {
        calls.push(`restore-auto:${command.orderId}:${command.dto.version}`);
        return response();
      },
      async enterManualProductionStatus(command) {
        calls.push(`enter-manual:${command.orderId}:${command.dto.version}`);
        return response();
      },
    };
    const controller = createController({
      flags: { productionActionsEnabled: true },
      service,
    });
    const user = { user: currentUser(), requestId: 'req-mode' };

    await controller.restoreAutoProductionStatus(user, '15', productionStatusModeBody());
    await controller.enterManualProductionStatus(user, '15', productionStatusModeBody());

    expect(calls).toEqual([
      'restore-auto:15:3',
      'enter-manual:15:3',
    ]);
  });

  it('returns 503 on restore-auto when production actions flag is disabled', async () => {
    const controller = createController({ flags: { productionActionsEnabled: false } });

    await expect(
      controller.restoreAutoProductionStatus({ user: currentUser() }, '15', productionStatusModeBody()),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('returns 503 on enter-manual when production actions flag is disabled', async () => {
    const controller = createController({ flags: { productionActionsEnabled: false } });

    await expect(
      controller.enterManualProductionStatus({ user: currentUser() }, '15', productionStatusModeBody()),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('returns 401 on restore-auto when user is not authenticated', async () => {
    const controller = createController({ flags: { productionActionsEnabled: true } });

    await expect(
      controller.restoreAutoProductionStatus({}, '15', productionStatusModeBody()),
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
  });

  it('returns 401 on enter-manual when user is not authenticated', async () => {
    const controller = createController({ flags: { productionActionsEnabled: true } });

    await expect(
      controller.enterManualProductionStatus({}, '15', productionStatusModeBody()),
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
  });

  it('returns 422 on restore-auto with invalid payload', async () => {
    expect(() =>
      parseProductionStatusModeRequest({ version: 'not-a-number', idempotencyKey: 'valid-key-123' }),
    ).toThrow(ApiError);
  });

  it('delegates PATCH details/production-status to the service with the parsed command', async () => {
    let captured: unknown;
    const controller = createController({
      flags: { productionActionsEnabled: true },
      service: {
        async changeBatchDetailProductionStatus(command: unknown) {
          captured = command;
          return {
            order: { orderId: 15, productionStatusId: 5, version: 4 },
            selectedDetailCount: 2,
            affectedDetailCount: 2,
            requestId: 'req-batch-1',
          };
        },
      } as unknown as Partial<ProductionActionService>,
    });

    const result = await controller.changeBatchDetailProductionStatus(
      { user: currentUser(), requestId: 'req-batch-1' },
      '15',
      { detailIds: [100, 101], productionStatusId: 5, version: 3, idempotencyKey: 'batch-key-1' },
    );

    expect(result).toMatchObject({ selectedDetailCount: 2, affectedDetailCount: 2 });
    expect(captured).toMatchObject({
      orderId: 15,
      requestId: 'req-batch-1',
      dto: { detailIds: [100, 101], productionStatusId: 5, version: 3, idempotencyKey: 'batch-key-1' },
    });
  });

  it('returns 422 on details/production-status with empty detailIds', () => {
    expect(() =>
      parseBatchDetailProductionStatusRequest({
        detailIds: [],
        productionStatusId: 5,
        version: 3,
        idempotencyKey: 'batch-key-1',
      }),
    ).toThrow(ApiError);
  });

  it('returns 503 on details/production-status when production actions flag is disabled', async () => {
    const controller = createController({ flags: { productionActionsEnabled: false } });

    await expect(
      controller.changeBatchDetailProductionStatus({ user: currentUser() }, '15', {
        detailIds: [100],
        productionStatusId: 5,
        version: 3,
        idempotencyKey: 'batch-key-1',
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });
});

function createController(options: {
  flags: { productionActionsEnabled: boolean };
  service?: Partial<ProductionActionService>;
}): ProductionActionsController {
  const service = createService(options.service);
  const runtimeConfig = createRuntimeConfig(options.flags);

  return new ProductionActionsController(service, runtimeConfig);
}

function createDetailController(options: {
  flags: { productionActionsEnabled: boolean };
  service?: Partial<ProductionActionService>;
}): OrderDetailProductionActionsController {
  const service = createService(options.service);
  const runtimeConfig = createRuntimeConfig(options.flags);

  return new OrderDetailProductionActionsController(service, runtimeConfig);
}

function createService(overrides: Partial<ProductionActionService> = {}): ProductionActionService {
  const service = {
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
    async restoreAutoProductionStatus() {
      throw new Error('restoreAutoProductionStatus should not be called');
    },
    async enterManualProductionStatus() {
      throw new Error('enterManualProductionStatus should not be called');
    },
    ...overrides,
  } as unknown as ProductionActionService;

  return service;
}

function createRuntimeConfig(flags: { productionActionsEnabled: boolean }) {
  return {
    getFeatureFlags() {
      return flags;
    },
  } as ProductionActionsRuntimeConfigService;
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function calendarDateBody() {
  return { plannedCompletionDate: '2026-05-20', version: 3, idempotencyKey: 'move-key-1' };
}

function orderStatusBody() {
  return { orderStatusId: 5, version: 3, idempotencyKey: 'status-key-1' };
}

function paymentStatusBody() {
  return { paymentStatusId: 3, version: 3, idempotencyKey: 'payment-status-key-1' };
}

function productionStatusBody() {
  return { productionStatusId: 2, version: 3, idempotencyKey: 'production-status-key-1' };
}

function stageBody() {
  return { version: 3, idempotencyKey: 'stage-key-1' };
}

function detailStageBody() {
  return { idempotencyKey: 'detail-stage-key-1', note: 'started cutting' };
}

function productionStatusModeBody() {
  return { version: 3, idempotencyKey: 'mode-key-12345678' };
}

function response() {
  return { order: { orderId: 15, version: 4 }, requestId: 'request-1' };
}

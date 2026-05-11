import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { ProductionActionService } from '../application/production-action.service';
import {
  parseCalendarDateRequest,
  parseOrderId,
  parseOrderStatusRequest,
  parseProductionStatusId,
  parseStageEventRequest,
  ProductionActionsController,
} from './production-actions.controller';
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
    const controller = createController({
      flags: { productionActionsEnabled: true },
      service: {
        async moveCalendarDate(command) {
          calls.push(`move:${command.orderId}:${command.dto.plannedCompletionDate}`);
          return response();
        },
        async changeOrderStatus(command) {
          calls.push(`status:${command.orderId}:${command.dto.orderStatusId}`);
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
      },
    });

    await controller.moveCalendarDate({ user: currentUser() }, '15', calendarDateBody());
    await controller.changeOrderStatus({ user: currentUser() }, '15', orderStatusBody());
    await controller.activateProductionStage({ user: currentUser() }, '15', '4', stageBody());
    await controller.deactivateProductionStage({ user: currentUser() }, '15', '4', stageBody());

    expect(calls).toEqual([
      'move:15:2026-05-20',
      'status:15:5',
      'activate:15:4',
      'deactivate:15:4',
    ]);
  });

  it('validates params and request bodies', () => {
    expect(parseOrderId('15')).toBe(15);
    expect(parseProductionStatusId('4')).toBe(4);
    expect(() => parseOrderId('0')).toThrow(ApiError);
    expect(() => parseProductionStatusId('x')).toThrow(ApiError);
    expect(() => parseCalendarDateRequest({ ...calendarDateBody(), version: -1 })).toThrow(ApiError);
    expect(() => parseOrderStatusRequest({ ...orderStatusBody(), orderStatusId: 0 })).toThrow(ApiError);
    expect(() => parseStageEventRequest({ version: 1, idempotencyKey: 'short' })).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { productionActionsEnabled: boolean };
  service?: Partial<ProductionActionService>;
}): ProductionActionsController {
  const service = {
    async moveCalendarDate() {
      throw new Error('moveCalendarDate should not be called');
    },
    async changeOrderStatus() {
      throw new Error('changeOrderStatus should not be called');
    },
    async activateProductionStage() {
      throw new Error('activateProductionStage should not be called');
    },
    async deactivateProductionStage() {
      throw new Error('deactivateProductionStage should not be called');
    },
    ...options.service,
  } as unknown as ProductionActionService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as ProductionActionsRuntimeConfigService;

  return new ProductionActionsController(service, runtimeConfig);
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

function stageBody() {
  return { version: 3, idempotencyKey: 'stage-key-1' };
}

function response() {
  return { order: { orderId: 15, version: 4 }, requestId: 'request-1' };
}

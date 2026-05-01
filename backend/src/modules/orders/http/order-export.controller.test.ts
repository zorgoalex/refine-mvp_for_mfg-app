import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderExportService } from '../application/order-export.service';
import { OrderExportController, normalizeExportOrderRequest } from './order-export.controller';
import type { OrdersRuntimeConfigService } from './orders-runtime-config.service';

describe('OrderExportController', () => {
  it('fails closed when orders API is disabled', async () => {
    const controller = createController({
      flags: { ordersEnabled: false, ordersReadOnly: true },
    });

    await expect(
      controller.exportToGoogleDrive({ user: manager() }, '42', { format: 'xlsx' }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: { feature: 'orders' },
    } satisfies Partial<ApiError>);
  });

  it('fails closed when export feature is disabled by default', async () => {
    const controller = createController({
      flags: { ordersEnabled: true, ordersReadOnly: true },
    });

    await expect(
      controller.exportToGoogleDrive({ user: manager() }, '42', { format: 'xlsx' }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: { feature: 'order_export' },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before export service call', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
        orderExportEnabled: true,
        exportDisabled: false,
      },
    });

    await expect(
      controller.exportToGoogleDrive({}, '42', { format: 'xlsx' }),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('normalizes request and delegates to export service', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
        orderExportEnabled: true,
        exportDisabled: false,
      },
      service: {
        async exportToGoogleDrive(command) {
          calls.push(`${command.currentUser.id}:${command.orderId}:${command.request.fileName}`);
          return { success: true, fileName: 'custom.xlsx', folder: null };
        },
      },
    });

    await expect(
      controller.exportToGoogleDrive({ user: manager() }, '42', {
        format: 'xlsx',
        fileName: ' custom.xlsx ',
      }),
    ).resolves.toEqual({ success: true, fileName: 'custom.xlsx', folder: null });
    expect(calls).toEqual(['manager-id:42:custom.xlsx']);
  });

  it('validates export request body', () => {
    expect(normalizeExportOrderRequest(undefined)).toEqual({ format: 'xlsx', fileName: null });
    expect(() =>
      normalizeExportOrderRequest({ format: 'pdf' as 'xlsx' }),
    ).toThrow(ApiError);
    expect(() =>
      normalizeExportOrderRequest({ format: 'xlsx', fileName: 'x'.repeat(256) }),
    ).toThrow(ApiError);
  });
});

function createController(options: {
  flags: {
    ordersEnabled: boolean;
    ordersReadOnly: boolean;
    orderExportEnabled?: boolean;
    exportDisabled?: boolean;
  };
  service?: Partial<OrderExportService>;
}): OrderExportController {
  const service = {
    async exportToGoogleDrive() {
      throw new Error('export should not be called');
    },
    ...options.service,
  } as unknown as OrderExportService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as OrdersRuntimeConfigService;

  return new OrderExportController(service, runtimeConfig);
}

function manager(): CurrentUser {
  return {
    id: 'manager-id',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

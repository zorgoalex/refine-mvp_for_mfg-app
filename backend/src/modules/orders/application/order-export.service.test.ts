import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { OrderExportService } from './order-export.service';

describe('OrderExportService', () => {
  it('requires orders.export permission before exporter call', async () => {
    const service = new OrderExportService({
      exporter: {
        async exportToGoogleDrive() {
          throw new Error('exporter should not be called');
        },
      },
    });

    await expect(
      service.exportToGoogleDrive({
        currentUser: viewer(),
        orderId: 42,
        request: { format: 'xlsx', fileName: null },
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.export'],
      },
    } satisfies Partial<ApiError>);
  });

  it('delegates export to configured exporter after permission check', async () => {
    const calls: string[] = [];
    const service = new OrderExportService({
      exporter: {
        async exportToGoogleDrive(command) {
          calls.push(`${command.currentUser.id}:${command.orderId}:${command.request.fileName}`);
          return { success: true, fileName: 'order_42.xlsx', folder: null };
        },
      },
    });

    await expect(
      service.exportToGoogleDrive({
        currentUser: manager(),
        orderId: 42,
        request: { format: 'xlsx', fileName: 'custom.xlsx' },
      }),
    ).resolves.toEqual({ success: true, fileName: 'order_42.xlsx', folder: null });
    expect(calls).toEqual(['manager-id:42:custom.xlsx']);
  });

  it('checks rate limit before exporter call', async () => {
    const calls: string[] = [];
    const service = new OrderExportService({
      rateLimiter: {
        async assertAllowed(command) {
          calls.push(`limit:${command.currentUser.id}:${command.orderId}`);
        },
      },
      exporter: {
        async exportToGoogleDrive(command) {
          calls.push(`export:${command.orderId}`);
          return { success: true, fileName: 'order_42.xlsx', folder: null };
        },
      },
    });

    await service.exportToGoogleDrive({
      currentUser: manager(),
      orderId: 42,
      request: { format: 'xlsx', fileName: null },
    });

    expect(calls).toEqual(['limit:manager-id:42', 'export:42']);
  });
});

function manager(): CurrentUser {
  return {
    id: 'manager-id',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

function viewer(): CurrentUser {
  return {
    id: 'viewer-id',
    username: 'viewer',
    role: 'viewer',
    roleId: 100,
    permissions: getPermissionsForRole('viewer'),
  };
}

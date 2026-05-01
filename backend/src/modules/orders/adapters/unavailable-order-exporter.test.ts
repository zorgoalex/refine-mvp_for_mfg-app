import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { UnavailableOrderExporter } from './unavailable-order-exporter';

describe('UnavailableOrderExporter', () => {
  it('fails closed before real export adapter is configured', async () => {
    const exporter = new UnavailableOrderExporter();

    await expect(
      exporter.exportToGoogleDrive({
        currentUser: {
          id: 'manager-id',
          username: 'manager',
          role: 'manager',
          roleId: 10,
          permissions: getPermissionsForRole('manager'),
        },
        orderId: 42,
        request: { format: 'xlsx', fileName: null },
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        feature: 'order_export',
        adapter: 'order_exporter',
      },
    } satisfies Partial<ApiError>);
  });
});

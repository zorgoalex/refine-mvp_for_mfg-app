import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { UnavailableVlmProvider } from './unavailable-vlm-provider';

describe('UnavailableVlmProvider', () => {
  it('fails closed with service unavailable contract', async () => {
    const provider = new UnavailableVlmProvider();

    await expect(
      provider.getHealth({
        currentUser: {
          id: 'admin-id',
          username: 'admin',
          role: 'admin',
          roleId: 1,
          permissions: getPermissionsForRole('admin'),
        },
        detailsVisible: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: {
        feature: 'vlm',
        adapter: 'vlm_provider',
      },
    } satisfies Partial<ApiError>);
  });
});

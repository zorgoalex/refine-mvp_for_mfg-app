import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { UnavailableUserRepository } from './unavailable-user-repository';

describe('UnavailableUserRepository', () => {
  it('fails closed with service unavailable contract', async () => {
    const repository = new UnavailableUserRepository();

    await expect(
      repository.listUsers({
        currentUser: {
          id: 'admin-id',
          username: 'admin',
          role: 'admin',
          roleId: 1,
          permissions: getPermissionsForRole('admin'),
        },
        query: { page: 1, pageSize: 25 },
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: {
        feature: 'users',
        adapter: 'user_repository',
      },
    } satisfies Partial<ApiError>);
  });
});

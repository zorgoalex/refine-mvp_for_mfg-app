import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { AuditQueryService } from './audit-query.service';
import type { AuditLogRepositoryPort } from './audit-query.types';

function user(role: 'admin' | 'manager'): CurrentUser {
  return { id: '1', username: role, role, roleId: 1, permissions: getPermissionsForRole(role) };
}
const okResult = { data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, requestId: 'rq' };

describe('AuditQueryService.list', () => {
  it('rejects users without audit.view', async () => {
    const repo: AuditLogRepositoryPort = { list: vi.fn(async () => okResult) };
    const service = new AuditQueryService({ repository: repo });
    await expect(
      service.list({ currentUser: user('manager'), filters: {}, page: 1, pageSize: 50, requestId: 'rq' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers with 401', async () => {
    const repo: AuditLogRepositoryPort = { list: vi.fn(async () => okResult) };
    const service = new AuditQueryService({ repository: repo });
    await expect(
      service.list({ currentUser: undefined, filters: {}, page: 1, pageSize: 50, requestId: 'rq' }),
    ).rejects.toMatchObject({ statusCode: 401 } satisfies Partial<ApiError>);
  });

  it('delegates to the repository for audit.view holders', async () => {
    const repo: AuditLogRepositoryPort = { list: vi.fn(async () => okResult) };
    const service = new AuditQueryService({ repository: repo });
    await service.list({ currentUser: user('admin'), filters: { relatedOrderId: 5 }, page: 1, pageSize: 50, requestId: 'rq' });
    expect(repo.list).toHaveBeenCalledOnce();
  });
});

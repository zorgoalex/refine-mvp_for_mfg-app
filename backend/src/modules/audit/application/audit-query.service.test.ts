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
const okFilterOptions = {
  data: {
    events: [],
    entityTypes: [],
    entityIds: [],
    users: [],
    roles: [],
    sources: [],
    relatedOrderIds: [],
    relatedClientIds: [],
    relatedPaymentIds: [],
    relatedDeadlineIds: [],
    relatedProductionEventIds: [],
    relatedUserIds: [],
    relatedEntityTypes: [],
    relatedEntities: [],
    requestIds: [],
  },
  requestId: 'rq',
};
const okOrderOptions = { data: [], requestId: 'rq' };
const okParticipantOptions = { data: [], requestId: 'rq' };

function repo(): AuditLogRepositoryPort {
  return {
    list: vi.fn(async () => okResult),
    filterOptions: vi.fn(async () => okFilterOptions),
    orderOptions: vi.fn(async () => okOrderOptions),
    participantOptions: vi.fn(async () => okParticipantOptions),
  };
}

describe('AuditQueryService.list', () => {
  it('rejects users without audit.view', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    await expect(
      service.list({ currentUser: user('manager'), filters: {}, page: 1, pageSize: 50, requestId: 'rq' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers with 401', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    await expect(
      service.list({ currentUser: undefined, filters: {}, page: 1, pageSize: 50, requestId: 'rq' }),
    ).rejects.toMatchObject({ statusCode: 401 } satisfies Partial<ApiError>);
  });

  it('delegates to the repository for audit.view holders', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    await service.list({ currentUser: user('admin'), filters: { relatedOrderId: 5 }, page: 1, pageSize: 50, requestId: 'rq' });
    expect(repository.list).toHaveBeenCalledOnce();
  });
});

describe('AuditQueryService.filterOptions', () => {
  it('rejects users without audit.view', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    await expect(
      service.filterOptions({ currentUser: user('manager'), requestId: 'rq' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);
    expect(repository.filterOptions).not.toHaveBeenCalled();
  });

  it('delegates to the repository for audit.view holders', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    await service.filterOptions({ currentUser: user('admin'), requestId: 'rq' });
    expect(repository.filterOptions).toHaveBeenCalledWith({ currentUser: user('admin'), requestId: 'rq' });
  });
});

describe('AuditQueryService lookup options', () => {
  it('rejects users without audit.view', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    await expect(
      service.orderOptions({ currentUser: user('manager'), requestId: 'rq', query: { limit: 20 } }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);
    await expect(
      service.participantOptions({ currentUser: user('manager'), requestId: 'rq', query: { limit: 20 } }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' } satisfies Partial<ApiError>);
    expect(repository.orderOptions).not.toHaveBeenCalled();
    expect(repository.participantOptions).not.toHaveBeenCalled();
  });

  it('delegates to the repository for audit.view holders', async () => {
    const repository = repo();
    const service = new AuditQueryService({ repository });
    const command = { currentUser: user('admin'), requestId: 'rq', query: { ids: [7], limit: 20 } };
    await service.orderOptions(command);
    await service.participantOptions(command);
    expect(repository.orderOptions).toHaveBeenCalledWith(command);
    expect(repository.participantOptions).toHaveBeenCalledWith(command);
  });
});

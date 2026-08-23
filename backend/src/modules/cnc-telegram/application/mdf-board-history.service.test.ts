import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { MdfBoardHistoryService } from './mdf-board-history.service';
import type { MdfBoardHistoryRepositoryPort } from './mdf-board-history.types';

describe('MdfBoardHistoryService', () => {
  it('allows order viewers and delegates search and history reads', async () => {
    const repository = repositoryStub();
    const service = new MdfBoardHistoryService(repository);
    const currentUser = user(['orders.view']);

    await service.searchOrders({ currentUser, query: '2711', limit: 20 });
    await service.getHistory({ currentUser, orderId: 2711, boardDate: '2026-08-23' });

    expect(repository.searchOrders).toHaveBeenCalledWith({ currentUser, query: '2711', limit: 20 });
    expect(repository.getHistory).toHaveBeenCalledWith({ currentUser, orderId: 2711, boardDate: '2026-08-23' });
  });

  it('rejects users without order visibility before touching the repository', async () => {
    const repository = repositoryStub();
    const service = new MdfBoardHistoryService(repository);

    expect(() => service.getHistory({ currentUser: user([]), orderId: 2711 })).toThrowError(
      expect.objectContaining({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      } satisfies Partial<ApiError>),
    );
    expect(repository.getHistory).not.toHaveBeenCalled();
  });
});

function repositoryStub(): MdfBoardHistoryRepositoryPort {
  return {
    searchOrders: vi.fn().mockResolvedValue({ data: [], generatedAt: '2026-08-23T00:00:00.000Z' }),
    getHistory: vi.fn().mockResolvedValue({}),
  };
}

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return { id: '7', username: 'manager', role: 'manager', roleId: 10, permissions };
}

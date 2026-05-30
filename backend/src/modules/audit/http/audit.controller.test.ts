import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { AuditController, parseAuditListQuery } from './audit.controller';

describe('parseAuditListQuery', () => {
  it('defaults page/pageSize and coerces numeric filters', () => {
    expect(parseAuditListQuery({ relatedOrderId: '1001', event: 'orders.update' })).toEqual({
      page: 1, pageSize: 50,
      filters: { relatedOrderId: 1001, event: 'orders.update' },
    });
  });
  it('rejects invalid pageSize', () => {
    expect(() => parseAuditListQuery({ pageSize: '9999' })).toThrow(ApiError);
  });
});

describe('AuditController.list', () => {
  it('passes current user, filters, paging, requestId to the service', async () => {
    const service = { list: vi.fn(async () => ({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, requestId: 'req-1' })) };
    const controller = new AuditController(service);
    const request: RequestWithCurrentUser = {
      requestId: 'req-1',
      user: { id: '1', username: 'admin', role: 'admin', roleId: 1, permissions: ['audit.view'] },
    };
    await controller.list(request, { relatedPaymentId: '42' });
    expect(service.list).toHaveBeenCalledWith({
      currentUser: request.user,
      filters: { relatedPaymentId: 42 },
      page: 1, pageSize: 50, requestId: 'req-1',
    });
  });
});

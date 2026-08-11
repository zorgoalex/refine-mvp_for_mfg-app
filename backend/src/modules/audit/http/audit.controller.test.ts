import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import {
  AuditController,
  parseAuditFilterOptionsQuery,
  parseAuditListQuery,
  parseAuditLookupQuery,
} from './audit.controller';

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
  it('parses relatedUserId and role filters', () => {
    expect(parseAuditListQuery({ relatedUserId: '158', role: 'admin' })).toEqual({
      page: 1, pageSize: 50,
      filters: { relatedUserId: 158, role: 'admin' },
    });
  });
  it('parses relatedEntityType and relatedEntityId filters', () => {
    expect(parseAuditListQuery({ relatedEntityType: 'employee', relatedEntityId: '3' })).toEqual({
      page: 1, pageSize: 50,
      filters: { relatedEntityType: 'employee', relatedEntityId: 3 },
    });
  });
  it('strips undefined relatedEntity filters when omitted', () => {
    expect(parseAuditListQuery({ event: 'orders.update' })).toEqual({
      page: 1, pageSize: 50,
      filters: { event: 'orders.update' },
    });
  });
  it('rejects an over-long role value', () => {
    expect(() => parseAuditListQuery({ role: 'x'.repeat(65) })).toThrow(ApiError);
  });

  it('parses repeated and comma array filters with dedupe', () => {
    expect(
      parseAuditListQuery({
        events: ['orders.update, payments.create', 'orders.update'],
        orderIds: ['10,11', '10'],
        participantUserIds: ['7', '8,7'],
      }),
    ).toEqual({
      page: 1,
      pageSize: 50,
      filters: {
        events: ['orders.update', 'payments.create'],
        orderIds: [10, 11],
        participantUserIds: [7, 8],
      },
    });
  });

  it('merges legacy event and related order filters into array filters when both are present', () => {
    expect(parseAuditListQuery({ event: 'orders.update', events: 'payments.create', relatedOrderId: '42', orderIds: '43' }))
      .toEqual({
        page: 1,
        pageSize: 50,
        filters: { events: ['orders.update', 'payments.create'], orderIds: [42, 43] },
      });
  });

  it('merges legacy user filters into participant array only for business scope', () => {
    expect(parseAuditListQuery({ scope: 'business', userId: '7', relatedUserId: '8', participantUserIds: '9' }))
      .toEqual({
        page: 1,
        pageSize: 50,
        filters: { scope: 'business', participantUserIds: [7, 8, 9] },
      });

    expect(parseAuditListQuery({ userId: '7', relatedUserId: '8', participantUserIds: '9' })).toEqual({
      page: 1,
      pageSize: 50,
      filters: { userId: 7, relatedUserId: 8, participantUserIds: [9] },
    });
  });

  it('rejects invalid and over-limit array filters', () => {
    expect(() => parseAuditListQuery({ orderIds: '0' })).toThrow(ApiError);
    expect(() => parseAuditListQuery({ participantUserIds: '1.5' })).toThrow(ApiError);
    expect(() => parseAuditListQuery({ events: 'x'.repeat(129) })).toThrow(ApiError);
    expect(() => parseAuditListQuery({ orderIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) })).toThrow(ApiError);
  });
});

describe('parseAuditFilterOptionsQuery', () => {
  it('defaults to all scope and accepts business scope', () => {
    expect(parseAuditFilterOptionsQuery({})).toEqual({ scope: 'all' });
    expect(parseAuditFilterOptionsQuery({ scope: 'business' })).toEqual({ scope: 'business' });
  });

  it('rejects invalid scope', () => {
    expect(() => parseAuditFilterOptionsQuery({ scope: 'private' })).toThrow(ApiError);
  });
});

describe('parseAuditLookupQuery', () => {
  it('parses lookup ids, trims search and caps default limit', () => {
    expect(parseAuditLookupQuery({ ids: ['10,11', '10'], search: ' 2678 ', limit: '30' })).toEqual({
      ids: [10, 11],
      search: '2678',
      limit: 30,
    });
  });

  it('treats empty search as absent', () => {
    expect(parseAuditLookupQuery({ search: '   ' })).toEqual({ limit: 20 });
  });

  it('rejects invalid lookup input', () => {
    expect(() => parseAuditLookupQuery({ ids: '-1' })).toThrow(ApiError);
    expect(() => parseAuditLookupQuery({ ids: Array.from({ length: 101 }, (_, i) => String(i + 1)) })).toThrow(ApiError);
    expect(() => parseAuditLookupQuery({ search: 'x'.repeat(81) })).toThrow(ApiError);
    expect(() => parseAuditLookupQuery({ limit: '51' })).toThrow(ApiError);
  });
});

describe('AuditController.list', () => {
  it('passes current user, filters, paging, requestId to the service', async () => {
    const service = {
      list: vi.fn(async () => ({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, requestId: 'req-1' })),
      filterOptions: vi.fn(),
      orderOptions: vi.fn(),
      participantOptions: vi.fn(),
    };
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

  it('passes current user and requestId to filter options service', async () => {
    const service = {
      list: vi.fn(),
      filterOptions: vi.fn(async () => ({ data: { events: [] }, requestId: 'req-options' })),
      orderOptions: vi.fn(),
      participantOptions: vi.fn(),
    };
    const controller = new AuditController(service);
    const request: RequestWithCurrentUser = {
      requestId: 'req-options',
      user: { id: '1', username: 'admin', role: 'admin', roleId: 1, permissions: ['audit.view'] },
    };

    await controller.filterOptions(request, { scope: 'business' });

    expect(service.filterOptions).toHaveBeenCalledWith({
      currentUser: request.user,
      requestId: 'req-options',
      scope: 'business',
    });
  });

  it('passes lookup query to order and participant option services', async () => {
    const service = {
      list: vi.fn(),
      filterOptions: vi.fn(),
      orderOptions: vi.fn(async () => ({ data: [], requestId: 'req-options' })),
      participantOptions: vi.fn(async () => ({ data: [], requestId: 'req-options' })),
    };
    const controller = new AuditController(service);
    const request: RequestWithCurrentUser = {
      requestId: 'req-options',
      user: { id: '1', username: 'admin', role: 'admin', roleId: 1, permissions: ['audit.view'] },
    };

    await controller.orderOptions(request, { ids: '10,11', search: '2678', limit: '25' });
    await controller.participantOptions(request, { ids: '7', search: 'manager' });

    expect(service.orderOptions).toHaveBeenCalledWith({
      currentUser: request.user,
      requestId: 'req-options',
      query: { ids: [10, 11], search: '2678', limit: 25 },
    });
    expect(service.participantOptions).toHaveBeenCalledWith({
      currentUser: request.user,
      requestId: 'req-options',
      query: { ids: [7], search: 'manager', limit: 20 },
    });
  });
});

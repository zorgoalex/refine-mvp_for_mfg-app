import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { GroupOrderReportController } from './group-order-report.controller';

describe('GroupOrderReportController', () => {
  it('fails closed when groups API is disabled', async () => {
    const controller = new GroupOrderReportController(service(), flags(false));

    await expect(controller.list({ user: user() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new GroupOrderReportController(service(), flags(true));

    await expect(controller.list({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('normalizes query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new GroupOrderReportController(
      {
        async listOrderIds(command: unknown) {
          calls.push(command);
          return {
            data: [{ orderId: 101 }],
            pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 },
            filter: (command as { query: { filter: unknown } }).query.filter,
          };
        },
      } as never,
      flags(true),
    );

    await expect(
      controller.list(
        { user: user(), requestId: 'req-report-1' },
        {
          page: '2',
          pageSize: '10',
          groupMode: 'none',
        },
      ),
    ).resolves.toEqual({
      data: [{ orderId: 101 }],
      pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 },
      filter: { mode: 'none', temporal: { mode: 'current' } },
    });

    expect(calls).toEqual([
      {
        currentUser: user(),
        query: {
          page: 2,
          pageSize: 10,
          filter: { mode: 'none', temporal: { mode: 'current' } },
        },
        requestId: 'req-report-1',
      },
    ]);
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ groupsEnabled: enabled, groupsReadOnly: false }),
  } as never;
}

function service() {
  return {
    async listOrderIds() {
      return {
        data: [],
        pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
        filter: { mode: 'none', temporal: { mode: 'current' } },
      };
    },
  } as never;
}

function user(): CurrentUser {
  return {
    id: 'user-id',
    username: 'report-user',
    role: 'viewer',
    roleId: 100,
    permissions: ['groups.view', 'orders.view'],
  };
}

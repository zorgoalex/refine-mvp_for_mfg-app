import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { GroupOrderStatusReportController } from './group-order-status-report.controller';

describe('GroupOrderStatusReportController', () => {
  it('fails closed when groups API is disabled', async () => {
    const controller = new GroupOrderStatusReportController(service(), flags(false));

    await expect(controller.list({ user: user() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new GroupOrderStatusReportController(service(), flags(true));

    await expect(controller.list({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('normalizes query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new GroupOrderStatusReportController(
      {
        async listOrderStatusCounts(command: unknown) {
          calls.push(command);
          return {
            data: [{ statusId: 1, statusName: 'Новый', orderCount: 3 }],
            filter: (command as { query: { responseFilter: unknown } }).query.responseFilter,
          };
        },
      } as never,
      flags(true),
    );

    await expect(
      controller.list(
        { user: user(), requestId: 'req-report-1' },
        {
          groupMode: 'none',
        },
      ),
    ).resolves.toEqual({
      data: [{ statusId: 1, statusName: 'Новый', orderCount: 3 }],
      filter: { groupMode: 'none', temporalMode: 'current' },
    });

    expect(calls).toEqual([
      {
        currentUser: user(),
        query: {
          predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
          responseFilter: { groupMode: 'none', temporalMode: 'current' },
        },
        requestId: 'req-report-1',
      },
    ]);
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ groupsEnabled: enabled, groupsReadOnly: true }),
  } as never;
}

function service() {
  return {
    async listOrderStatusCounts() {
      return {
        data: [],
        filter: { groupMode: 'none', temporalMode: 'current' },
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

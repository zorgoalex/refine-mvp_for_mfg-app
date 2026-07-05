import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { GroupDeadlineStatusCountsReportController } from './group-deadline-status-counts-report.controller';

describe('GroupDeadlineStatusCountsReportController', () => {
  it('fails closed when groups API is disabled', async () => {
    const controller = new GroupDeadlineStatusCountsReportController(service(), flags(false));

    await expect(controller.list({ user: user() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new GroupDeadlineStatusCountsReportController(service(), flags(true));

    await expect(controller.list({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('normalizes query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new GroupDeadlineStatusCountsReportController(
      {
        async listDeadlineStatusCounts(command: unknown) {
          calls.push(command);
          return {
            data: [{ deadlineStatus: 'active', deadlineCount: 3 }],
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
      data: [{ deadlineStatus: 'active', deadlineCount: 3 }],
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

  it('documents strict aggregate-only Swagger response metadata', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, GroupDeadlineStatusCountsReportController.prototype.list);
    const okResponse = Array.isArray(responses)
      ? responses.find((response: { status?: number }) => response.status === 200)
      : responses?.['200'];

    expect(okResponse.schema).toEqual(
      expect.objectContaining({
        additionalProperties: false,
        properties: expect.objectContaining({
          data: expect.objectContaining({
            items: expect.objectContaining({
              required: ['deadlineStatus', 'deadlineCount'],
              additionalProperties: false,
            }),
          }),
          filter: expect.objectContaining({ oneOf: expect.any(Array) }),
        }),
      }),
    );
    expect(JSON.stringify(okResponse.schema)).not.toContain('deadlineId');
    expect(JSON.stringify(okResponse.schema)).not.toContain('orderId');
    expect(JSON.stringify(okResponse.schema)).not.toContain('groupName');
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ groupsEnabled: enabled, groupsReadOnly: true }),
  } as never;
}

function service() {
  return {
    async listDeadlineStatusCounts() {
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
    permissions: ['groups.view', 'orders.view', 'deadlines.view'],
  };
}

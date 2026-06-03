import 'reflect-metadata';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { ProjectOrderCreatedMonthCountsReportController } from './project-order-created-month-counts-report.controller';

describe('ProjectOrderCreatedMonthCountsReportController', () => {
  it('fails closed when projects API is disabled', async () => {
    const controller = new ProjectOrderCreatedMonthCountsReportController(service(), flags(false));

    await expect(controller.list({ user: user() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new ProjectOrderCreatedMonthCountsReportController(service(), flags(true));

    await expect(controller.list({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('returns 422 for invalid query filters', async () => {
    const controller = new ProjectOrderCreatedMonthCountsReportController(service(), flags(true));

    await expect(controller.list({ user: user() }, { projectMode: 'any' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('normalizes query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new ProjectOrderCreatedMonthCountsReportController(
      {
        async listOrderCreatedMonthCounts(command: unknown) {
          calls.push(command);
          return {
            data: [{ month: '2026-01-01', orderCount: 3 }],
            filter: (command as { query: { responseFilter: unknown } }).query.responseFilter,
          };
        },
      } as never,
      flags(true),
    );

    await expect(
      controller.list(
        { user: user(), requestId: 'req-created-months-1' },
        {
          projectMode: 'none',
          createdFrom: '2026-01-01T00:00:00.000Z',
          createdTo: '2026-06-01T00:00:00.000Z',
        },
      ),
    ).resolves.toEqual({
      data: [{ month: '2026-01-01', orderCount: 3 }],
      filter: {
        projectMode: 'none',
        temporalMode: 'current',
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-06-01T00:00:00.000Z',
      },
    });

    expect(calls).toEqual([
      {
        currentUser: user(),
        query: {
          predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
          responseFilter: {
            projectMode: 'none',
            temporalMode: 'current',
            createdFrom: '2026-01-01T00:00:00.000Z',
            createdTo: '2026-06-01T00:00:00.000Z',
          },
          createdRange: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-06-01T00:00:00.000Z',
          },
        },
        requestId: 'req-created-months-1',
      },
    ]);
  });

  it('uses the bearerAuth swagger security scheme', () => {
    expect(Reflect.getMetadata(DECORATORS.API_SECURITY, ProjectOrderCreatedMonthCountsReportController)).toEqual([
      { bearerAuth: [] },
    ]);
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ projectsEnabled: enabled, projectsReadOnly: true }),
  } as never;
}

function service() {
  return {
    async listOrderCreatedMonthCounts() {
      return {
        data: [],
        filter: { projectMode: 'none', temporalMode: 'current' },
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
    permissions: ['projects.view', 'orders.view'],
  };
}

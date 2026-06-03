import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { ProjectOrderRelationCountsReportController } from './project-order-relation-counts-report.controller';

describe('ProjectOrderRelationCountsReportController', () => {
  it('fails closed when projects API is disabled', async () => {
    const controller = new ProjectOrderRelationCountsReportController(service(), flags(false));

    await expect(controller.list({ user: user() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new ProjectOrderRelationCountsReportController(service(), flags(true));

    await expect(controller.list({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('normalizes query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new ProjectOrderRelationCountsReportController(
      {
        async listOrderRelationCounts(command: unknown) {
          calls.push(command);
          return {
            data: [{ relationType: 'main', isPrimary: true, orderCount: 3 }],
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
          projectMode: 'none',
        },
      ),
    ).resolves.toEqual({
      data: [{ relationType: 'main', isPrimary: true, orderCount: 3 }],
      filter: { projectMode: 'none', temporalMode: 'current' },
    });

    expect(calls).toEqual([
      {
        currentUser: user(),
        query: {
          predicateFilter: { mode: 'none', temporal: { mode: 'current' } },
          responseFilter: { projectMode: 'none', temporalMode: 'current' },
        },
        requestId: 'req-report-1',
      },
    ]);
  });

  it('returns 422 for invalid query filters', async () => {
    const controller = new ProjectOrderRelationCountsReportController(service(), flags(true));

    await expect(controller.list({ user: user() }, { projectMode: 'any' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    });
  });

  it('keeps the response top level narrow', async () => {
    const controller = new ProjectOrderRelationCountsReportController(service(), flags(true));
    const response = await controller.list({ user: user() }, { projectMode: 'none' });

    expect(Object.keys(response)).toEqual(['data', 'filter']);
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ projectsEnabled: enabled, projectsReadOnly: true }),
  } as never;
}

function service() {
  return {
    async listOrderRelationCounts() {
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

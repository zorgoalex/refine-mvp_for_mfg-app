import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { ProjectsModule } from '../projects.module';
import { PgProjectOverviewRepository, UnavailableProjectOverviewRepository } from './project-overview.repository';
import { ProjectOverviewService } from './project-overview.service';
import { ProjectOverviewController } from './project-overview.controller';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

describe('ProjectOverviewController', () => {
  it('fails closed when projects API is disabled', async () => {
    const controller = new ProjectOverviewController(service(), flags(false));

    await expect(controller.getOverview({ user: user() }, PROJECT_ID, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new ProjectOverviewController(service(), flags(true));

    await expect(controller.getOverview({}, PROJECT_ID, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('normalizes project id and query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new ProjectOverviewController(
      {
        async getOverview(command: unknown) {
          calls.push(command);
          return response((command as { projectId: string; query: { filter: unknown } }).projectId, {
            ...(command as { query: { filter: object } }).query.filter,
          });
        },
      } as never,
      flags(true),
    );

    await expect(
      controller.getOverview(
        { user: user(), requestId: 'req-overview-1' },
        PROJECT_ID.toUpperCase(),
        {
          temporalMode: 'overlap',
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:00Z',
          createdFrom: '2026-01-10T00:00:00Z',
          createdTo: '2026-01-20T00:00:00Z',
        },
      ),
    ).resolves.toEqual(
      response(PROJECT_ID.toLowerCase(), {
        temporalMode: 'overlap',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        createdFrom: '2026-01-10T00:00:00Z',
        createdTo: '2026-01-20T00:00:00Z',
      }),
    );

    expect(calls).toEqual([
      {
        currentUser: user(),
        projectId: PROJECT_ID.toLowerCase(),
        query: {
          temporal: {
            mode: 'overlap',
            from: '2026-01-01T00:00:00Z',
            to: '2026-02-01T00:00:00Z',
          },
          filter: {
            temporalMode: 'overlap',
            from: '2026-01-01T00:00:00Z',
            to: '2026-02-01T00:00:00Z',
            createdFrom: '2026-01-10T00:00:00Z',
            createdTo: '2026-01-20T00:00:00Z',
          },
          createdRange: {
            from: '2026-01-10T00:00:00Z',
            to: '2026-01-20T00:00:00Z',
          },
        },
        requestId: 'req-overview-1',
      },
    ]);
  });

  it('rejects invalid project ids as BAD_REQUEST', async () => {
    const controller = new ProjectOverviewController(service(), flags(true));

    await expect(controller.getOverview({ user: user() }, 'not-a-uuid', {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });
});

describe('ProjectsModule overview wiring', () => {
  it('registers the overview route and repository provider factory', () => {
    const controllers = Reflect.getMetadata('controllers', ProjectsModule) ?? [];
    const providers = Reflect.getMetadata('providers', ProjectsModule) ?? [];

    expect(controllers).toContain(ProjectOverviewController);
    expect(Reflect.getMetadata(PATH_METADATA, ProjectOverviewController)).toBe('projects/:projectId/overview');

    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === ProjectOverviewService;
    }) as { useFactory?: unknown } | undefined;

    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgProjectOverviewRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableProjectOverviewRepository.name);
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ projectsEnabled: enabled, projectsReadOnly: true }),
  } as never;
}

function service() {
  return {
    async getOverview() {
      return response(PROJECT_ID, { temporalMode: 'current' });
    },
  } as never;
}

function response(projectId: string, filter: object) {
  return {
    project: {
      id: projectId,
      code: 'P7',
      name: 'Project P7',
      description: null,
      status: 'active',
      startsAt: null,
      endsAt: null,
      ownerUserId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      archivedAt: null,
    },
    orders: {
      totalCount: 0,
      statusCounts: [],
      relationCounts: [],
      createdMonthCounts: [],
    },
    filter,
    omitted: [
      'finance',
      'payments',
      'clientPhones',
      'audit',
      'deadline',
      'production',
      'members',
      'users',
      'orderDetails',
      'activityTimeline',
    ],
  };
}

function user(): CurrentUser {
  return {
    id: 'user-id',
    username: 'overview-user',
    role: 'viewer',
    roleId: 100,
    permissions: ['projects.view', 'orders.view'],
  };
}

import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { GroupsModule } from '../groups.module';
import { PgGroupOverviewRepository, UnavailableGroupOverviewRepository } from './group-overview.repository';
import { GroupOverviewService } from './group-overview.service';
import { GroupOverviewController } from './group-overview.controller';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';

describe('GroupOverviewController', () => {
  it('fails closed when groups API is disabled', async () => {
    const controller = new GroupOverviewController(service(), flags(false));

    await expect(controller.getOverview({ user: user() }, GROUP_ID, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('returns 401 when request user is missing', async () => {
    const controller = new GroupOverviewController(service(), flags(true));

    await expect(controller.getOverview({}, GROUP_ID, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('normalizes group id and query and delegates with current user and request id', async () => {
    const calls: unknown[] = [];
    const controller = new GroupOverviewController(
      {
        async getOverview(command: unknown) {
          calls.push(command);
          return response((command as { groupId: string; query: { filter: unknown } }).groupId, {
            ...(command as { query: { filter: object } }).query.filter,
          });
        },
      } as never,
      flags(true),
    );

    await expect(
      controller.getOverview(
        { user: user(), requestId: 'req-overview-1' },
        GROUP_ID.toUpperCase(),
        {
          temporalMode: 'overlap',
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:00Z',
          createdFrom: '2026-01-10T00:00:00Z',
          createdTo: '2026-01-20T00:00:00Z',
        },
      ),
    ).resolves.toEqual(
      response(GROUP_ID.toLowerCase(), {
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
        groupId: GROUP_ID.toLowerCase(),
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

  it('rejects invalid group ids as BAD_REQUEST', async () => {
    const controller = new GroupOverviewController(service(), flags(true));

    await expect(controller.getOverview({ user: user() }, 'not-a-uuid', {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });
});

describe('GroupsModule overview wiring', () => {
  it('registers the overview route and repository provider factory', () => {
    const controllers = Reflect.getMetadata('controllers', GroupsModule) ?? [];
    const providers = Reflect.getMetadata('providers', GroupsModule) ?? [];

    expect(controllers).toContain(GroupOverviewController);
    expect(Reflect.getMetadata(PATH_METADATA, GroupOverviewController)).toBe('groups/:groupId/overview');

    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === GroupOverviewService;
    }) as { useFactory?: unknown } | undefined;

    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgGroupOverviewRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableGroupOverviewRepository.name);
  });
});

function flags(enabled: boolean) {
  return {
    getFeatureFlags: () => ({ groupsEnabled: enabled, groupsReadOnly: true }),
  } as never;
}

function service() {
  return {
    async getOverview() {
      return response(GROUP_ID, { temporalMode: 'current' });
    },
  } as never;
}

function response(groupId: string, filter: object) {
  return {
    group: {
      id: groupId,
      code: 'P7',
      name: 'Group P7',
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
    permissions: ['groups.view', 'orders.view'],
  };
}

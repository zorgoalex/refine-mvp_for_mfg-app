import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import type { GroupOverviewQuery, GroupOverviewResponseDto } from './group-overview.dto';
import { GROUP_OVERVIEW_OMITTED } from './group-overview.dto';
import { GroupOverviewService } from './group-overview.service';

describe('GroupOverviewService', () => {
  it('requires groups.view and orders.view before repository calls', async () => {
    const overviews = fakeOverviews();
    const service = new GroupOverviewService({ overviews });
    const query = overviewQuery();

    await expect(
      service.getOverview({ currentUser: user(['groups.view']), groupId: groupId(), query }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['groups.view', 'orders.view'],
        missingPermissions: ['orders.view'],
      },
    });
    await expect(
      service.getOverview({ currentUser: user(['orders.view']), groupId: groupId(), query }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['groups.view', 'orders.view'],
        missingPermissions: ['groups.view'],
      },
    });
    await expect(service.getOverview({ currentUser: user([]), groupId: groupId(), query })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['groups.view', 'orders.view'],
        missingPermissions: ['groups.view', 'orders.view'],
      },
    });

    expect(overviews.calls).toEqual([]);
  });

  it('delegates after both permissions pass', async () => {
    const overviews = fakeOverviews();
    const service = new GroupOverviewService({ overviews });
    const query = overviewQuery();

    await expect(
      service.getOverview({ currentUser: user(['groups.view', 'orders.view']), groupId: groupId(), query }),
    ).resolves.toEqual(overviewResponse(query));
    expect(overviews.calls).toEqual([{
      groupId: groupId(),
      query,
      visibleEntityTypes: ['order'],
      canViewParticipants: false,
    }]);
  });
});

function fakeOverviews() {
  return {
    calls: [] as Array<{
      groupId: string;
      query: GroupOverviewQuery;
      visibleEntityTypes?: string[];
      canViewParticipants?: boolean;
    }>,
    async getOverview(input: {
      groupId: string;
      query: GroupOverviewQuery;
      visibleEntityTypes?: string[];
      canViewParticipants?: boolean;
    }): Promise<GroupOverviewResponseDto> {
      this.calls.push(input);
      return overviewResponse(input.query);
    },
  };
}

function overviewQuery(): GroupOverviewQuery {
  return {
    temporal: { mode: 'current' },
    filter: { temporalMode: 'current' },
    createdRange: {},
  };
}

function overviewResponse(query: GroupOverviewQuery): GroupOverviewResponseDto {
  return {
    group: {
      id: groupId(),
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
    linkedEntityCounts: [],
    participants: { currentSummary: [] },
    filter: { groupId: groupId(), ...query.filter },
    omitted: GROUP_OVERVIEW_OMITTED,
  };
}

function groupId(): string {
  return '11111111-1111-4111-8111-111111111111';
}

function user(permissions: PermissionName[]): CurrentUser {
  return {
    id: 'user-id',
    username: 'overview-user',
    role: 'viewer',
    roleId: 100,
    permissions,
  };
}

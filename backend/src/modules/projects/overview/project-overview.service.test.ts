import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import type { ProjectOverviewQuery, ProjectOverviewResponseDto } from './project-overview.dto';
import { PROJECT_OVERVIEW_OMITTED } from './project-overview.dto';
import { ProjectOverviewService } from './project-overview.service';

describe('ProjectOverviewService', () => {
  it('requires projects.view and orders.view before repository calls', async () => {
    const overviews = fakeOverviews();
    const service = new ProjectOverviewService({ overviews });
    const query = overviewQuery();

    await expect(
      service.getOverview({ currentUser: user(['projects.view']), projectId: projectId(), query }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['projects.view', 'orders.view'],
        missingPermissions: ['orders.view'],
      },
    });

    expect(overviews.calls).toEqual([]);
  });

  it('delegates after both permissions pass', async () => {
    const overviews = fakeOverviews();
    const service = new ProjectOverviewService({ overviews });
    const query = overviewQuery();

    await expect(
      service.getOverview({ currentUser: user(['projects.view', 'orders.view']), projectId: projectId(), query }),
    ).resolves.toEqual(overviewResponse(query));
    expect(overviews.calls).toEqual([{ projectId: projectId(), query }]);
  });
});

function fakeOverviews() {
  return {
    calls: [] as Array<{ projectId: string; query: ProjectOverviewQuery }>,
    async getOverview(input: { projectId: string; query: ProjectOverviewQuery }): Promise<ProjectOverviewResponseDto> {
      this.calls.push(input);
      return overviewResponse(input.query);
    },
  };
}

function overviewQuery(): ProjectOverviewQuery {
  return {
    temporal: { mode: 'current' },
    filter: { temporalMode: 'current' },
    createdRange: {},
  };
}

function overviewResponse(query: ProjectOverviewQuery): ProjectOverviewResponseDto {
  return {
    project: {
      id: projectId(),
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
    filter: { projectId: projectId(), ...query.filter },
    omitted: PROJECT_OVERVIEW_OMITTED,
  };
}

function projectId(): string {
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

import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { GroupDeadlineStatusCountsReportService } from './group-deadline-status-counts-report.service';

describe('GroupDeadlineStatusCountsReportService', () => {
  it('requires groups.view orders.view and deadlines.view', async () => {
    const service = new GroupDeadlineStatusCountsReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['groups.view', 'orders.view', 'deadlines.view'];

    await expect(
      service.listDeadlineStatusCounts({ currentUser: user(['groups.view', 'orders.view']), query }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['deadlines.view'] },
    });
    await expect(service.listDeadlineStatusCounts({ currentUser: user(['deadlines.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['groups.view', 'orders.view'] },
    });
  });

  it('does not treat adjacent report permissions as sufficient', async () => {
    const service = new GroupDeadlineStatusCountsReportService({ reports: fakeReports() });

    await expect(
      service.listDeadlineStatusCounts({
        currentUser: user(['payments.view', 'deadlines.audit.view', 'groups.members.view']),
        query: reportQuery(),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: {
        requiredPermissions: ['groups.view', 'orders.view', 'deadlines.view'],
        missingPermissions: ['groups.view', 'orders.view', 'deadlines.view'],
      },
    });
  });

  it('delegates for users with all report permissions', async () => {
    const reports = fakeReports();
    const service = new GroupDeadlineStatusCountsReportService({ reports });
    const query = reportQuery();

    await expect(
      service.listDeadlineStatusCounts({
        currentUser: user(['groups.view', 'orders.view', 'deadlines.view']),
        query,
      }),
    ).resolves.toEqual({
      data: [{ deadlineStatus: 'active', deadlineCount: 2 }],
      filter: query.responseFilter,
    });
    expect(reports.calls).toBe(1);
  });
});

function fakeReports() {
  return {
    calls: 0,
    async listDeadlineStatusCounts(query: ReturnType<typeof reportQuery>) {
      this.calls += 1;
      return {
        data: [{ deadlineStatus: 'active' as const, deadlineCount: 2 }],
        filter: query.responseFilter,
      };
    },
  };
}

function reportQuery() {
  return {
    predicateFilter: { mode: 'none' as const, temporal: { mode: 'current' as const } },
    responseFilter: { groupMode: 'none' as const, temporalMode: 'current' as const },
  };
}

function user(permissions: PermissionName[]): CurrentUser {
  return {
    id: 'user-id',
    username: 'report-user',
    role: 'viewer',
    roleId: 100,
    permissions,
  };
}

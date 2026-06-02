import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ProjectOrderStatusReportService } from './project-order-status-report.service';

describe('ProjectOrderStatusReportService', () => {
  it('requires both projects.view and orders.view', async () => {
    const service = new ProjectOrderStatusReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['projects.view', 'orders.view'];

    await expect(service.listOrderStatusCounts({ currentUser: user(['projects.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['orders.view'] },
    });
    await expect(service.listOrderStatusCounts({ currentUser: user(['orders.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['projects.view'] },
    });
    await expect(service.listOrderStatusCounts({ currentUser: user([]), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: requiredPermissions },
    });
  });

  it('does not treat adjacent report permissions as sufficient', async () => {
    const service = new ProjectOrderStatusReportService({ reports: fakeReports() });

    await expect(
      service.listOrderStatusCounts({
        currentUser: user([
          'payments.view',
          'orders.view_financials',
          'audit.view',
          'deadlines.audit.view',
          'projects.members.view',
        ]),
        query: reportQuery(),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: {
        requiredPermissions: ['projects.view', 'orders.view'],
        missingPermissions: ['projects.view', 'orders.view'],
      },
    });
  });

  it('delegates for users with projects.view and orders.view only', async () => {
    const reports = fakeReports();
    const service = new ProjectOrderStatusReportService({ reports });
    const query = reportQuery();

    await expect(
      service.listOrderStatusCounts({ currentUser: user(['projects.view', 'orders.view']), query }),
    ).resolves.toEqual({
      data: [{ statusId: 1, statusName: 'Новый', orderCount: 2 }],
      filter: query.responseFilter,
    });
    expect(reports.calls).toBe(1);
  });
});

function fakeReports() {
  return {
    calls: 0,
    async listOrderStatusCounts(query: ReturnType<typeof reportQuery>) {
      this.calls += 1;
      return {
        data: [{ statusId: 1, statusName: 'Новый', orderCount: 2 }],
        filter: query.responseFilter,
      };
    },
  };
}

function reportQuery() {
  return {
    predicateFilter: { mode: 'none' as const, temporal: { mode: 'current' as const } },
    responseFilter: { projectMode: 'none' as const, temporalMode: 'current' as const },
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

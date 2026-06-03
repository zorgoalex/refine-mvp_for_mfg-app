import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ProjectOrderRelationCountsReportService } from './project-order-relation-counts-report.service';

describe('ProjectOrderRelationCountsReportService', () => {
  it('requires both projects.view and orders.view', async () => {
    const service = new ProjectOrderRelationCountsReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['projects.view', 'orders.view'];

    await expect(service.listOrderRelationCounts({ currentUser: user(['projects.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions, missingPermissions: ['orders.view'] },
    });
    await expect(service.listOrderRelationCounts({ currentUser: user(['orders.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions, missingPermissions: ['projects.view'] },
    });
    await expect(service.listOrderRelationCounts({ currentUser: user([]), query })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions, missingPermissions: requiredPermissions },
    });
  });

  it('does not treat adjacent report permissions as sufficient', async () => {
    const service = new ProjectOrderRelationCountsReportService({ reports: fakeReports() });

    await expect(
      service.listOrderRelationCounts({
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
      code: 'PERMISSION_DENIED',
      details: {
        requiredPermissions: ['projects.view', 'orders.view'],
        missingPermissions: ['projects.view', 'orders.view'],
      },
    });
  });

  it('delegates for users with projects.view and orders.view only', async () => {
    const reports = fakeReports();
    const service = new ProjectOrderRelationCountsReportService({ reports });
    const query = reportQuery();

    await expect(
      service.listOrderRelationCounts({ currentUser: user(['projects.view', 'orders.view']), query }),
    ).resolves.toEqual({
      data: [{ relationType: 'main', isPrimary: true, orderCount: 2 }],
      filter: query.responseFilter,
    });
    expect(reports.calls).toBe(1);
  });
});

function fakeReports() {
  return {
    calls: 0,
    async listOrderRelationCounts(query: ReturnType<typeof reportQuery>) {
      this.calls += 1;
      return {
        data: [{ relationType: 'main' as const, isPrimary: true, orderCount: 2 }],
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

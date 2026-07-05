import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { GroupProductionStatusCountsReportService } from './group-production-status-counts-report.service';

describe('GroupProductionStatusCountsReportService', () => {
  it('requires both groups.view and orders.view', async () => {
    const service = new GroupProductionStatusCountsReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['groups.view', 'orders.view'];

    await expect(service.listProductionStatusCounts({ currentUser: user(['groups.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['orders.view'] },
    });
    await expect(service.listProductionStatusCounts({ currentUser: user(['orders.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['groups.view'] },
    });
    await expect(service.listProductionStatusCounts({ currentUser: user([]), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: requiredPermissions },
    });
  });

  it('does not treat adjacent report permissions as sufficient', async () => {
    const service = new GroupProductionStatusCountsReportService({ reports: fakeReports() });

    await expect(
      service.listProductionStatusCounts({
        currentUser: user([
          'payments.view',
          'orders.view_financials',
          'audit.view',
          'deadlines.audit.view',
          'groups.members.view',
        ]),
        query: reportQuery(),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      details: {
        requiredPermissions: ['groups.view', 'orders.view'],
        missingPermissions: ['groups.view', 'orders.view'],
      },
    });
  });

  it('delegates for users with groups.view and orders.view only', async () => {
    const reports = fakeReports();
    const service = new GroupProductionStatusCountsReportService({ reports });
    const query = reportQuery();

    await expect(
      service.listProductionStatusCounts({ currentUser: user(['groups.view', 'orders.view']), query }),
    ).resolves.toEqual({
      data: [{ productionStatusId: 1, productionStatusCode: 'new', productionStatusName: 'Новый', orderCount: 2 }],
      filter: query.responseFilter,
    });
    expect(reports.calls).toBe(1);
  });
});

function fakeReports() {
  return {
    calls: 0,
    async listProductionStatusCounts(query: ReturnType<typeof reportQuery>) {
      this.calls += 1;
      return {
        data: [{ productionStatusId: 1, productionStatusCode: 'new', productionStatusName: 'Новый', orderCount: 2 }],
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

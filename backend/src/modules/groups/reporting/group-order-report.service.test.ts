import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { GroupOrderReportService } from './group-order-report.service';

describe('GroupOrderReportService', () => {
  it('requires both groups.view and orders.view', async () => {
    const service = new GroupOrderReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['groups.view', 'orders.view'];

    await expect(service.listOrderIds({ currentUser: user(['groups.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['orders.view'] },
    });
    await expect(service.listOrderIds({ currentUser: user(['orders.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['groups.view'] },
    });
    await expect(service.listOrderIds({ currentUser: user([]), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: requiredPermissions },
    });
  });

  it('does not treat adjacent report permissions as sufficient', async () => {
    const service = new GroupOrderReportService({ reports: fakeReports() });

    await expect(
      service.listOrderIds({
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
    const service = new GroupOrderReportService({ reports });
    const query = reportQuery();

    await expect(service.listOrderIds({ currentUser: user(['groups.view', 'orders.view']), query })).resolves.toEqual({
      data: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
      filter: query.filter,
    });
    expect(reports.calls).toBe(1);
  });
});

function fakeReports() {
  return {
    calls: 0,
    async listOrderIds(query: ReturnType<typeof reportQuery>) {
      this.calls += 1;
      return {
        data: [],
        pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 1 },
        filter: query.filter,
      };
    },
  };
}

function reportQuery() {
  return {
    page: 1,
    pageSize: 50,
    filter: { mode: 'none' as const, temporal: { mode: 'current' as const } },
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

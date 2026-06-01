import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ProjectOrderReportService } from './project-order-report.service';

describe('ProjectOrderReportService', () => {
  it('requires both projects.view and orders.view', async () => {
    const service = new ProjectOrderReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['projects.view', 'orders.view'];

    await expect(service.listOrderIds({ currentUser: user(['projects.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['orders.view'] },
    });
    await expect(service.listOrderIds({ currentUser: user(['orders.view']), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: ['projects.view'] },
    });
    await expect(service.listOrderIds({ currentUser: user([]), query })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredPermissions, missingPermissions: requiredPermissions },
    });
  });

  it('does not treat adjacent report permissions as sufficient', async () => {
    const service = new ProjectOrderReportService({ reports: fakeReports() });

    await expect(
      service.listOrderIds({
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
    const service = new ProjectOrderReportService({ reports });
    const query = reportQuery();

    await expect(service.listOrderIds({ currentUser: user(['projects.view', 'orders.view']), query })).resolves.toEqual({
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

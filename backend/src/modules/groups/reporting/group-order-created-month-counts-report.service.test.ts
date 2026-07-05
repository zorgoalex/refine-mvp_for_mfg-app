import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { GroupOrderCreatedMonthCountsReportService } from './group-order-created-month-counts-report.service';

describe('GroupOrderCreatedMonthCountsReportService', () => {
  it('requires both groups.view and orders.view', async () => {
    const service = new GroupOrderCreatedMonthCountsReportService({ reports: fakeReports() });
    const query = reportQuery();
    const requiredPermissions = ['groups.view', 'orders.view'];

    await expect(
      service.listOrderCreatedMonthCounts({ currentUser: user(['groups.view']), query }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions, missingPermissions: ['orders.view'] },
    });
    await expect(
      service.listOrderCreatedMonthCounts({ currentUser: user(['orders.view']), query }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions, missingPermissions: ['groups.view'] },
    });
  });

  it('delegates once and passes requestId to permission checks', async () => {
    const reports = fakeReports();
    const permissions = fakePermissions();
    const service = new GroupOrderCreatedMonthCountsReportService({ reports, permissions });
    const query = reportQuery();

    await expect(
      service.listOrderCreatedMonthCounts({
        currentUser: user(['groups.view', 'orders.view']),
        query,
        requestId: 'req-created-months-1',
      }),
    ).resolves.toEqual({
      data: [{ month: '2026-01-01', orderCount: 2 }],
      filter: query.responseFilter,
    });

    expect(reports.calls).toBe(1);
    expect(permissions.calls).toEqual([
      { permission: 'groups.view', requestId: 'req-created-months-1' },
      { permission: 'orders.view', requestId: 'req-created-months-1' },
    ]);
  });
});

function fakeReports() {
  return {
    calls: 0,
    async listOrderCreatedMonthCounts(query: ReturnType<typeof reportQuery>) {
      this.calls += 1;
      return {
        data: [{ month: '2026-01-01', orderCount: 2 }],
        filter: query.responseFilter,
      };
    },
  };
}

function fakePermissions() {
  return {
    calls: [] as Array<{ permission: PermissionName; requestId?: string }>,
    canUser(currentUser: CurrentUser | null | undefined, permission: PermissionName, requestId?: string) {
      this.calls.push({ permission, requestId });
      return Boolean(currentUser?.permissions.includes(permission));
    },
  };
}

function reportQuery() {
  return {
    predicateFilter: { mode: 'none' as const, temporal: { mode: 'current' as const } },
    responseFilter: { groupMode: 'none' as const, temporalMode: 'current' as const },
    createdRange: {},
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

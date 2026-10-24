import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ recordDenied: vi.fn(async () => 'audit-id') }));
vi.mock('../../../common/audit/audit.service', () => ({ auditService: audit }));

import type { CurrentUser } from '../../../permissions/current-user';
import { PaymentsAnalyticsService } from './payments-analytics.service';

const query = { dateFrom: '2026-10-01', dateTo: '2026-10-05' };
const answer = { ...query, count: 0, amount: '0.00', byType: [], byDay: [] };
const ALL = ['finance.analytics.view', 'payments.view', 'orders.view', 'orders.view_financials'];
const dashboardAnswer = { ...query, received: { count: 0, amount: '0.00' } };
const user = (role: string, permissions: string[], orderView?: string[]): CurrentUser =>
  ({
    id: 7,
    username: 'u',
    role,
    permissions,
    ...(orderView ? { policyScopeSets: { orders: { view: orderView } } } : {}),
  } as unknown as CurrentUser);

function service() {
  const read = { summary: vi.fn(async () => answer), dashboard: vi.fn(async () => dashboardAnswer) };
  const auditClient = { query: vi.fn() };
  return { read, auditClient, service: new PaymentsAnalyticsService({ read, auditClient: auditClient as never }) };
}

describe('PaymentsAnalyticsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a top manager who holds the analytics right', async () => {
    const { service: analytics, read } = service();
    await expect(analytics.summary(user('top_manager', ['finance.analytics.view', 'payments.view', 'orders.view', 'orders.view_financials']), query, 'req-1')).resolves.toBe(answer);
    expect(read.summary).toHaveBeenCalledWith(query);
    expect(audit.recordDenied).not.toHaveBeenCalled();
  });

  it.each([
    ['without finance.analytics.view', 'top_manager', ['payments.view', 'orders.view', 'orders.view_financials'], 'missing_permission'],
    ['without payments.view', 'top_manager', ['finance.analytics.view', 'orders.view', 'orders.view_financials'], 'missing_permission'],
    // receivables and the order-amount filter are order money: hidden from a user who may not see it
    ['without orders.view_financials', 'top_manager', ['finance.analytics.view', 'payments.view', 'orders.view'], 'missing_permission'],
    ['without orders.view', 'top_manager', ['finance.analytics.view', 'payments.view', 'orders.view_financials'], 'missing_permission'],
    // a manager sees payments of their own orders only: totals over all payments are not theirs to read
    ['with payment visibility limited to own orders', 'manager', ['finance.analytics.view', 'payments.view', 'orders.view', 'orders.view_financials'], 'scope_not_all'],
  ])('refuses a user %s and audits the refusal', async (_name, role, permissions, reason) => {
    await expectRefused(user(role, permissions), reason);
  });

  // receivables count every issued order, also those without payments: seeing all payments is not enough
  it('refuses a user who sees all payments but only their own orders', async () => {
    await expectRefused(user('top_manager', ALL, ['own']), 'scope_not_all');
  });

  it('answers a user whose order visibility comes from access groups and is unrestricted', async () => {
    const { service: analytics, read } = service();
    await expect(analytics.summary(user('top_manager', ALL, ['all']), query, 'req-5')).resolves.toBe(answer);
    expect(read.summary).toHaveBeenCalledWith(query);
  });

  async function expectRefused(viewer: CurrentUser, reason: string) {
    const role = viewer.role;
    const { service: analytics, read, auditClient } = service();
    await expect(analytics.summary(viewer, query, 'req-2')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(read.summary).not.toHaveBeenCalled();
    expect(audit.recordDenied).toHaveBeenCalledTimes(1);
    expect(audit.recordDenied).toHaveBeenCalledWith(auditClient, expect.objectContaining({
      event: 'payments.analytics_denied',
      entityType: 'payments_analytics',
      actorUserId: 7,
      actorRole: role,
      requestId: 'req-2',
      reason,
      requiredPermissions: ALL,
    }));
  }

  it('the dashboard is open to the same users and refuses the rest with an audited denial', async () => {
    const allowed = service();
    await expect(allowed.service.dashboard(user('top_manager', ['finance.analytics.view', 'payments.view', 'orders.view', 'orders.view_financials']), query, 'req-3')).resolves.toBe(dashboardAnswer);
    expect(allowed.read.dashboard).toHaveBeenCalledWith(query);

    const refused = service();
    await expect(refused.service.dashboard(user('manager', ['finance.analytics.view', 'payments.view', 'orders.view', 'orders.view_financials']), query, 'req-4')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(refused.read.dashboard).not.toHaveBeenCalled();
    expect(audit.recordDenied).toHaveBeenLastCalledWith(refused.auditClient, expect.objectContaining({
      event: 'payments.analytics_denied',
      reason: 'scope_not_all',
      requestId: 'req-4',
      metadata: expect.objectContaining({ action: 'dashboard' }),
    }));
  });
});

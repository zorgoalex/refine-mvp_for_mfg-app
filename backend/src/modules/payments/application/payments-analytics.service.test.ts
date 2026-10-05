import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ recordDenied: vi.fn(async () => 'audit-id') }));
vi.mock('../../../common/audit/audit.service', () => ({ auditService: audit }));

import type { CurrentUser } from '../../../permissions/current-user';
import { PaymentsAnalyticsService } from './payments-analytics.service';

const query = { dateFrom: '2026-10-01', dateTo: '2026-10-05' };
const answer = { ...query, count: 0, amount: '0.00', byType: [], byDay: [] };
const user = (role: string, permissions: string[]): CurrentUser =>
  ({ id: 7, username: 'u', role, permissions } as unknown as CurrentUser);

function service() {
  const read = { summary: vi.fn(async () => answer) };
  const auditClient = { query: vi.fn() };
  return { read, auditClient, service: new PaymentsAnalyticsService({ read, auditClient: auditClient as never }) };
}

describe('PaymentsAnalyticsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a top manager who holds the analytics right', async () => {
    const { service: analytics, read } = service();
    await expect(analytics.summary(user('top_manager', ['finance.analytics.view', 'payments.view']), query, 'req-1')).resolves.toBe(answer);
    expect(read.summary).toHaveBeenCalledWith(query);
    expect(audit.recordDenied).not.toHaveBeenCalled();
  });

  it.each([
    ['without finance.analytics.view', 'top_manager', ['payments.view'], 'missing_permission'],
    ['without payments.view', 'top_manager', ['finance.analytics.view'], 'missing_permission'],
    // a manager sees payments of their own orders only: totals over all payments are not theirs to read
    ['with payment visibility limited to own orders', 'manager', ['finance.analytics.view', 'payments.view'], 'scope_not_all'],
  ])('refuses a user %s and audits the refusal', async (_name, role, permissions, reason) => {
    const { service: analytics, read, auditClient } = service();
    await expect(analytics.summary(user(role, permissions), query, 'req-2')).rejects.toMatchObject({
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
      requiredPermissions: ['finance.analytics.view', 'payments.view'],
    }));
  });
});

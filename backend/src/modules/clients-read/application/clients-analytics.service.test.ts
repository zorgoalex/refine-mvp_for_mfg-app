import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ recordDenied: vi.fn(async () => 'audit-id') }));
vi.mock('../../../common/audit/audit.service', () => ({ auditService: audit }));

import type { CurrentUser } from '../../../permissions/current-user';
import { CLIENTS_ANALYTICS_PERMISSIONS, ClientsAnalyticsService } from './clients-analytics.service';

const all = [...CLIENTS_ANALYTICS_PERMISSIONS];
const query = { dateFrom: '2026-09-07', dateTo: '2026-10-06' };
const user = (role: string, permissions: string[]): CurrentUser =>
  ({ id: '7', username: 'u', role, permissions } as unknown as CurrentUser);

function service(card: unknown = { client: { clientId: 5 } }) {
  const read = { dashboard: vi.fn(async () => ({ ok: true })), card: vi.fn(async () => card) };
  const auditClient = { query: vi.fn() };
  return { read, auditClient, service: new ClientsAnalyticsService({ read: read as never, auditClient: auditClient as never }) };
}

describe('ClientsAnalyticsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a top manager who holds every right', async () => {
    const { service: analytics, read } = service();
    await expect(analytics.dashboard(user('top_manager', all), query, 'req-1')).resolves.toEqual({ ok: true });
    await expect(analytics.card(user('top_manager', all), 5, 'req-1')).resolves.toEqual({ client: { clientId: 5 } });
    expect(read.dashboard).toHaveBeenCalledWith(query);
    expect(read.card).toHaveBeenCalledWith(5);
    expect(audit.recordDenied).not.toHaveBeenCalled();
  });

  it.each(all)('refuses a user without %s', async (permission) => {
    const { service: analytics, read } = service();
    const permissions = all.filter((candidate) => candidate !== permission);
    await expect(analytics.dashboard(user('top_manager', permissions), query, 'req-2')).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(read.dashboard).not.toHaveBeenCalled();
    expect(audit.recordDenied).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'clients.analytics_denied', reason: 'missing_permission' }));
  });

  it('refuses a manager, who sees only their own orders, and audits which client was asked for', async () => {
    const { service: analytics, read, auditClient } = service();
    await expect(analytics.card(user('manager', all), 5, 'req-3')).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(read.card).not.toHaveBeenCalled();
    expect(audit.recordDenied).toHaveBeenCalledWith(auditClient, expect.objectContaining({
      event: 'clients.analytics_denied',
      entityType: 'client',
      entityId: 5,
      relatedClientId: 5,
      actorUserId: '7',
      actorRole: 'manager',
      requestId: 'req-3',
      reason: 'orders_scope_not_all',
      metadata: { action: 'card' },
    }));
  });

  it('refuses a user who sees all orders but not all payments: the card lists payments', async () => {
    const { service: analytics, read } = service();
    const limited = { ...user('top_manager', all), policyScopes: {
      orders: { view: 'all', update: 'all', export: 'all', delete: 'all' },
      payments: { view: 'own', create: 'own', update: 'own', delete: 'own' },
      productionTasks: { view: 'all', update: 'all' },
    } } as never;
    await expect(analytics.card(limited, 5, 'req-6')).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    await expect(analytics.dashboard(limited, query, 'req-6')).rejects.toMatchObject({ statusCode: 403 });
    expect(read.card).not.toHaveBeenCalled();
    expect(read.dashboard).not.toHaveBeenCalled();
    expect(audit.recordDenied).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'payments_scope_not_all' }));
  });

  it('a missing client is 404 after the rights are checked', async () => {
    const { service: analytics } = service(null);
    await expect(analytics.card(user('top_manager', all), 5, 'req-4')).rejects.toMatchObject({ statusCode: 404, code: 'CLIENT_NOT_FOUND' });
    await expect(analytics.card(user('manager', all), 5, 'req-5')).rejects.toMatchObject({ statusCode: 403 });
  });
});

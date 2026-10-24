import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ recordDenied: vi.fn(async () => 'audit-id') }));
vi.mock('../../../common/audit/audit.service', () => ({ auditService: audit }));

import type { CurrentUser } from '../../../permissions/current-user';
import { ClientListFactsService, clientOrdersScope } from './client-list-facts.service';

const user = (role: string, permissions: string[], id = '7'): CurrentUser =>
  ({ id, username: 'u', role, permissions } as unknown as CurrentUser);

function service() {
  const read = { facts: vi.fn(async () => [{ clientId: 1, primaryPhone: null, phonesCount: 0, orders: null }]) };
  const auditClient = { query: vi.fn() };
  return { read, auditClient, service: new ClientListFactsService({ read, auditClient: auditClient as never }) };
}

describe('client list facts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('order facts follow the shared order read visibility of the user (the orders list and the order card)', () => {
    expect(clientOrdersScope(user('top_manager', ['clients.view', 'orders.view']))).toMatchObject({ kind: 'all' });
    // a manager sees their own orders only — only those are counted
    expect(clientOrdersScope(user('manager', ['clients.view', 'orders.view'], '42'))).toMatchObject({ kind: 'own', viewer: { id: '42' } });
    // «assigned» does not restrict the orders list, so it does not restrict the facts either
    expect(clientOrdersScope(user('worker', ['clients.view', 'orders.view']))).toMatchObject({ kind: 'all' });
    expect(clientOrdersScope(user('top_manager', ['clients.view']))).toEqual({ kind: 'none' });
  });

  it('reads the facts with the scope of the user', async () => {
    const { service: facts, read } = service();
    await expect(facts.facts(user('manager', ['clients.view', 'orders.view'], '42'), [1, 2], 'req-1')).resolves.toEqual({
      data: [{ clientId: 1, primaryPhone: null, phonesCount: 0, orders: null }],
    });
    expect(read.facts).toHaveBeenCalledWith([1, 2], expect.objectContaining({ kind: 'own', viewer: expect.objectContaining({ id: '42' }) }));
    expect(audit.recordDenied).not.toHaveBeenCalled();
  });

  it('refuses a user without clients.view and audits the refusal', async () => {
    const { service: facts, read, auditClient } = service();
    await expect(facts.facts(user('worker', ['orders.view']), [1], 'req-2')).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(read.facts).not.toHaveBeenCalled();
    expect(audit.recordDenied).toHaveBeenCalledWith(auditClient, expect.objectContaining({
      event: 'clients.list_facts_denied',
      actorUserId: '7',
      requestId: 'req-2',
      reason: 'missing_permission',
      requiredPermissions: ['clients.view'],
    }));
  });
});

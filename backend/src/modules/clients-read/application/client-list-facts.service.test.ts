import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ recordDenied: vi.fn(async () => 'audit-id') }));
vi.mock('../../../common/audit/audit.service', () => ({ auditService: audit }));

import type { CurrentUser } from '../../../permissions/current-user';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { scopeSetsFromPolicy } from '../../../permissions/policies/scope-sets';
import { ClientListFactsService, clientOrderReadScope } from './client-list-facts.service';

const user = (role: string, permissions: string[], id = '7'): CurrentUser =>
  ({ id, username: 'u', role, permissions } as unknown as CurrentUser);

function service() {
  const read = { facts: vi.fn(async () => [{ clientId: 1, primaryPhone: null, phonesCount: 0, orders: null }]) };
  const auditClient = { query: vi.fn() };
  return { read, auditClient, service: new ClientListFactsService({ read, auditClient: auditClient as never }) };
}

describe('client list facts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('order facts follow the order visibility of the user', () => {
    const top = user('top_manager', ['clients.view', 'orders.view']);
    expect(clientOrderReadScope(top)).toEqual({ kind: 'all', viewer: top });
    // a manager sees their own orders only — only those are counted
    const manager = user('manager', ['clients.view', 'orders.view'], '42');
    expect(clientOrderReadScope(manager)).toEqual({ kind: 'own', viewer: manager });
    // «assigned» does not restrict order reads (the shared rule of the orders list), so nothing is hidden here either
    const worker = user('worker', ['clients.view', 'orders.view']);
    expect(clientOrderReadScope(worker)).toEqual({ kind: 'all', viewer: worker });
    expect(clientOrderReadScope(user('top_manager', ['clients.view']))).toEqual({ kind: 'none' });
    // no grant at all — no order facts
    const noGrant = { ...manager, policyScopeSets: { ...scopeSetsFromPolicy(ROLE_POLICIES.manager), orders: { ...scopeSetsFromPolicy(ROLE_POLICIES.manager).orders, view: [] } } } as CurrentUser;
    expect(clientOrderReadScope(noGrant)).toEqual({ kind: 'none' });
    // the effective scope set of the token wins over the role: «own» ∪ «assigned» is not restricted
    const both = { ...manager, policyScopeSets: { ...scopeSetsFromPolicy(ROLE_POLICIES.manager), orders: { ...scopeSetsFromPolicy(ROLE_POLICIES.manager).orders, view: ['own', 'assigned'] } } } as CurrentUser;
    expect(clientOrderReadScope(both)).toEqual({ kind: 'all', viewer: both });
  });

  it('reads the facts with the scope of the user', async () => {
    const { service: facts, read } = service();
    const manager = user('manager', ['clients.view', 'orders.view'], '42');
    await expect(facts.facts(manager, [1, 2], 'req-1')).resolves.toEqual({
      data: [{ clientId: 1, primaryPhone: null, phonesCount: 0, orders: null }],
    });
    expect(read.facts).toHaveBeenCalledWith([1, 2], { kind: 'own', viewer: manager });
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

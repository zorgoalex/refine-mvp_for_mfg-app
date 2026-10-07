import { describe, expect, it } from 'vitest';
import { accountEscalationViolations } from './account-escalation';
import { ROLE_ID_TO_ROLE } from './permissions';
import { staticAuthorizationSnapshot } from './testing/static-authorization-snapshot';

const snap = (roleId: number) => staticAuthorizationSnapshot({ userId: roleId, roleId });

describe('no escalation through accounts: target ≼ actor (access groups 0A.4)', () => {
  it('admin manages every role below it today: no permission or scope of theirs exceeds admin', () => {
    const admin = snap(1);
    for (const roleId of [10, 11, 15, 20, 30, 32, 100]) {
      expect(accountEscalationViolations(admin, snap(roleId)), ROLE_ID_TO_ROLE[roleId as keyof typeof ROLE_ID_TO_ROLE]).toEqual({ missingPermissions: [], scopeKeys: [] });
    }
  });

  it('system.superadmin may manage anyone', () => {
    expect(accountEscalationViolations(snap(2), snap(1))).toEqual({ missingPermissions: [], scopeKeys: [] });
  });

  it('a permission the actor lacks is an escalation (e.g. via a group)', () => {
    const admin = snap(1);
    const target = { ...snap(100), permissions: [...snap(100).permissions, 'system.superadmin' as const] };
    expect(accountEscalationViolations(admin, target).missingPermissions).toEqual(['system.superadmin']);
  });

  it('own/assigned of another person need all on the actor side', () => {
    const narrowAdmin = { ...snap(1), scopeSets: { ...snap(1).scopeSets, orders: { ...snap(1).scopeSets.orders, view: ['own' as const] } } };
    // A manager has orders.view=own: the admin with own cannot create or manage such an account.
    expect(accountEscalationViolations(narrowAdmin, snap(10)).scopeKeys).toContain('orders.view');
    // An account with orders.view=all is an escalation too.
    expect(accountEscalationViolations(narrowAdmin, snap(15)).scopeKeys).toContain('orders.view');
    // A target without any grant on the key is fine.
    const noOrders = { ...snap(30), scopeSets: { ...snap(30).scopeSets, orders: { view: [], update: [], export: [], delete: [] } } };
    expect(accountEscalationViolations(narrowAdmin, noOrders).scopeKeys).not.toContain('orders.view');
  });
});

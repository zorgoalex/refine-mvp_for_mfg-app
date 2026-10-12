import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../current-user';
import { ROLE_POLICIES } from './role-policies';
import { allowsScopeSet, policyScopeSetsForUser } from './scope';
import {
  normalizeScopeSet,
  scalarPolicyFromSets,
  scalarScope,
  scopeSetsFromPolicy,
  scopeSetsFromRecord,
} from './scope-sets';

describe('scope sets (access groups §3.2)', () => {
  it('all absorbs the rest; duplicates and junk drop; empty means none', () => {
    expect(normalizeScopeSet(['own', 'all', 'assigned'])).toEqual(['all']);
    expect(normalizeScopeSet(['assigned', 'own', 'own', 'none', 'x', 3])).toEqual(['own', 'assigned']);
    expect(normalizeScopeSet([])).toEqual([]);
  });

  it('the scalar is never wider than the set', () => {
    expect(scalarScope(['all'])).toBe('all');
    expect(scalarScope(['own', 'assigned'])).toBe('own');
    expect(scalarScope(['assigned'])).toBe('assigned');
    expect(scalarScope([])).toBe('none');
  });

  it('round-trips every static role policy: sets from policy → scalar gives the same policy', () => {
    for (const policy of Object.values(ROLE_POLICIES)) {
      expect(scalarPolicyFromSets(scopeSetsFromPolicy(policy))).toEqual(policy);
    }
  });

  it('reads the snapshot record: missing keys are empty, unknown keys ignored', () => {
    const sets = scopeSetsFromRecord({ 'orders.view': ['own'], 'payments.view': ['all', 'own'], 'bogus.key': ['all'] });
    expect(sets.orders.view).toEqual(['own']);
    expect(sets.payments.view).toEqual(['all']);
    expect(sets.orders.delete).toEqual([]);
    expect(sets.productionTasks.update).toEqual([]);
  });

  it('a token without sets falls back to its scalar scopes, then to the role defaults', () => {
    const manager = { id: '5', username: 'm', role: 'manager', roleId: 10, permissions: [] } as CurrentUser;
    expect(policyScopeSetsForUser(manager)).toEqual(scopeSetsFromPolicy(ROLE_POLICIES.manager));
    const scalarOnly = { ...manager, policyScopes: ROLE_POLICIES.admin } as CurrentUser;
    expect(policyScopeSetsForUser(scalarOnly)).toEqual(scopeSetsFromPolicy(ROLE_POLICIES.admin));
    const withSets = { ...scalarOnly, policyScopeSets: scopeSetsFromPolicy(ROLE_POLICIES.worker) } as CurrentUser;
    expect(policyScopeSetsForUser(withSets)).toEqual(scopeSetsFromPolicy(ROLE_POLICIES.worker));
  });

  it('own ∪ assigned allows both own and assigned entities', () => {
    const user = { id: '5', username: 'u', role: 'manager', roleId: 10, permissions: [] } as CurrentUser;
    expect(allowsScopeSet(user, ['own', 'assigned'], { createdByUserId: '5' })).toBe(true);
    expect(allowsScopeSet(user, ['own', 'assigned'], { assignedUserIds: ['5'] })).toBe(true);
    expect(allowsScopeSet(user, ['own', 'assigned'], { createdByUserId: '6' })).toBe(false);
    expect(allowsScopeSet(user, [], { createdByUserId: '5' })).toBe(false);
    expect(allowsScopeSet(user, ['all'], {})).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../current-user';
import { appendOrderReadScopeSql, buildOrderReadScopePredicate } from './order-read-scope-sql';

function user(role: CurrentUser['role']): CurrentUser {
  return { id: '42', username: role, role, permissions: ['orders.view'] } as CurrentUser;
}

describe('canonical order read scope SQL', () => {
  it('maps all, own, and assigned scopes to policy-equivalent predicates', () => {
    const allParams: unknown[] = [];
    expect(appendOrderReadScopeSql(allParams, user('operator')).predicate).toBe('TRUE');
    expect(allParams).toEqual([]);

    const ownParams: unknown[] = [];
    expect(appendOrderReadScopeSql(ownParams, user('manager')).predicate).toBe(
      '(o.created_by = $1 OR o.manager_id = $1)',
    );
    expect(ownParams).toEqual([42]);

    const assignedParams: unknown[] = [];
    const assigned = appendOrderReadScopeSql(assignedParams, user('worker'));
    expect(assigned.predicate).toContain('FROM order_workshops assigned_ow');
    expect(assigned.predicate).toContain('assigned_user.user_id = $1');
    expect(assignedParams).toEqual([42]);
  });

  it('fails closed for none', () => {
    expect(buildOrderReadScopePredicate('none', null, 'FALSE')).toBe('FALSE');
  });

  it('scope sets: own ∪ assigned is an OR of both; all absorbs; empty fails closed; one value = same SQL as before', () => {
    const both = buildOrderReadScopePredicate(['own', 'assigned'], 1, 'ASSIGNED_SQL');
    expect(both).toBe('((o.created_by = $1 OR o.manager_id = $1) OR ASSIGNED_SQL)');
    expect(buildOrderReadScopePredicate(['own', 'all'], null, 'X')).toBe('TRUE');
    expect(buildOrderReadScopePredicate([], null, 'X')).toBe('FALSE');
    for (const scope of ['all', 'own', 'assigned', 'none'] as const) {
      const set = scope === 'none' ? [] : [scope];
      expect(buildOrderReadScopePredicate(set, 3, 'A')).toBe(buildOrderReadScopePredicate(scope, 3, 'A'));
    }
  });

  it('uses the scope set of the token, not the static role matrix', () => {
    const manager = { ...user('manager'), policyScopeSets: {
      orders: { view: ['own', 'assigned'], update: [], export: [], delete: [] },
      payments: { view: [], create: [], update: [], delete: [] },
      productionTasks: { view: [], update: [] },
    } } as CurrentUser;
    const params: unknown[] = [];
    const scope = appendOrderReadScopeSql(params, manager);
    expect(params).toEqual([42]);
    expect(scope.predicate).toContain('(o.created_by = $1 OR o.manager_id = $1) OR EXISTS');
    const viewerAll = { ...user('worker'), policyScopeSets: { ...manager.policyScopeSets!, orders: { view: ['all'], update: [], export: [], delete: [] } } } as CurrentUser;
    const none: unknown[] = [];
    expect(appendOrderReadScopeSql(none, viewerAll).predicate).toBe('TRUE');
    expect(none).toEqual([]);
  });
});


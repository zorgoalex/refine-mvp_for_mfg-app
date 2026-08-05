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
});

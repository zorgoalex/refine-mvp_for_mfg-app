import { describe, expect, it } from 'vitest';

import type { UserIdentity } from '../../types/auth';
import { canDeleteOrderForUser } from './orderDeleteVisibility';

function user(
  role: string,
  id: string,
  scope: 'all' | 'own' | 'none',
  permissions: string[] = ['orders.delete'],
): UserIdentity {
  return {
    id,
    username: role,
    role,
    permissions,
    policyScopes: {
      orders: { view: 'all', update: 'all', export: 'all', delete: scope },
      payments: { view: 'none', create: 'none', update: 'none', delete: 'none' },
      productionTasks: { view: 'none', update: 'none' },
    },
  };
}

describe('order delete visibility', () => {
  it('allows an all-scoped top manager to delete any order', () => {
    expect(canDeleteOrderForUser(user('top_manager', '15', 'all'), {
      created_by: 10,
      manager_id: 10,
    })).toBe(true);
  });

  it('allows an own-scoped manager only for created or assigned orders', () => {
    const manager = user('manager', '10', 'own');
    expect(canDeleteOrderForUser(manager, { created_by: 10 })).toBe(true);
    expect(canDeleteOrderForUser(manager, { manager_id: '10' })).toBe(true);
    expect(canDeleteOrderForUser(manager, { created_by: 11, manager_id: 12 })).toBe(false);
  });

  it('denies users without permission or an approved scope', () => {
    expect(canDeleteOrderForUser(user('manager', '10', 'own', []), { created_by: 10 })).toBe(false);
    expect(canDeleteOrderForUser(user('manager', '10', 'none'), { created_by: 10 })).toBe(false);
    expect(canDeleteOrderForUser(null, { created_by: 10 })).toBe(false);
    expect(canDeleteOrderForUser(user('manager', '10', 'own'), 'invalid order')).toBe(false);
  });
});

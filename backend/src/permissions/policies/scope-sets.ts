import type { RolePolicy, Scope } from './role-policies';

/** A granted scope value; 'none' is the empty set. */
export type ScopeGrant = Exclude<Scope, 'none'>;

/**
 * Scopes as sets (access groups plan §3.2): a user may get `own` from one source and `assigned` from
 * another; `all` absorbs the rest; an empty array means no scope ('none').
 */
export interface RolePolicyScopeSets {
  orders: { view: ScopeGrant[]; update: ScopeGrant[]; export: ScopeGrant[]; delete: ScopeGrant[] };
  payments: { view: ScopeGrant[]; create: ScopeGrant[]; update: ScopeGrant[]; delete: ScopeGrant[] };
  productionTasks: { view: ScopeGrant[]; update: ScopeGrant[] };
}

const GRANTS: readonly ScopeGrant[] = ['all', 'own', 'assigned'];

export function isScopeGrant(value: unknown): value is ScopeGrant {
  return typeof value === 'string' && (GRANTS as readonly string[]).includes(value);
}

/** Canonical form: `all` absorbs the rest; otherwise sorted, without duplicates. */
export function normalizeScopeSet(values: readonly unknown[]): ScopeGrant[] {
  const grants = new Set(values.filter(isScopeGrant));
  if (grants.has('all')) return ['all'];
  return GRANTS.filter((grant) => grants.has(grant));
}

/**
 * The scalar a client that knows only one value per key may see. Never wider than the set:
 * `all` → all; `own` (with or without `assigned`) → own; `assigned` → assigned; empty → none.
 */
export function scalarScope(set: readonly ScopeGrant[]): Scope {
  if (set.includes('all')) return 'all';
  if (set.includes('own')) return 'own';
  if (set.includes('assigned')) return 'assigned';
  return 'none';
}

export function scopeSetsFromPolicy(policy: RolePolicy): RolePolicyScopeSets {
  const one = (scope: Scope) => normalizeScopeSet([scope]);
  return {
    orders: {
      view: one(policy.orders.view),
      update: one(policy.orders.update),
      export: one(policy.orders.export),
      delete: one(policy.orders.delete),
    },
    payments: {
      view: one(policy.payments.view),
      create: one(policy.payments.create),
      update: one(policy.payments.update),
      delete: one(policy.payments.delete),
    },
    productionTasks: {
      view: one(policy.productionTasks.view),
      update: one(policy.productionTasks.update),
    },
  };
}

export function scalarPolicyFromSets(sets: RolePolicyScopeSets): RolePolicy {
  return {
    orders: {
      view: scalarScope(sets.orders.view),
      update: scalarScope(sets.orders.update),
      export: scalarScope(sets.orders.export),
      delete: scalarScope(sets.orders.delete),
    },
    payments: {
      view: scalarScope(sets.payments.view),
      create: scalarScope(sets.payments.create),
      update: scalarScope(sets.payments.update),
      delete: scalarScope(sets.payments.delete),
    },
    productionTasks: {
      view: scalarScope(sets.productionTasks.view),
      update: scalarScope(sets.productionTasks.update),
    },
  };
}

/** From the snapshot JSON: `{ 'orders.view': ['own'], ... }`; unknown keys ignored, missing keys empty. */
export function scopeSetsFromRecord(record: Record<string, unknown> | null | undefined): RolePolicyScopeSets {
  const get = (key: string) => {
    const value = record?.[key];
    return normalizeScopeSet(Array.isArray(value) ? value : []);
  };
  return {
    orders: { view: get('orders.view'), update: get('orders.update'), export: get('orders.export'), delete: get('orders.delete') },
    payments: { view: get('payments.view'), create: get('payments.create'), update: get('payments.update'), delete: get('payments.delete') },
    productionTasks: { view: get('productionTasks.view'), update: get('productionTasks.update') },
  };
}

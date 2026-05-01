import type { UserRole } from '../permissions';

export type Scope = 'all' | 'own' | 'assigned' | 'none';

export interface RolePolicy {
  orders: {
    view: Scope;
    update: Scope;
    export: Scope;
    delete: Scope;
  };
  payments: {
    view: Scope;
    update: Scope;
    delete: Scope;
  };
  productionTasks: {
    view: Scope;
    update: Scope;
  };
}

export const ROLE_POLICIES = {
  superadmin: {
    orders: { view: 'all', update: 'all', export: 'all', delete: 'all' },
    payments: { view: 'all', update: 'all', delete: 'all' },
    productionTasks: { view: 'all', update: 'all' },
  },
  admin: {
    orders: { view: 'all', update: 'all', export: 'all', delete: 'all' },
    payments: { view: 'all', update: 'all', delete: 'all' },
    productionTasks: { view: 'all', update: 'all' },
  },
  top_manager: {
    orders: { view: 'all', update: 'all', export: 'all', delete: 'none' },
    payments: { view: 'all', update: 'all', delete: 'none' },
    productionTasks: { view: 'all', update: 'all' },
  },
  manager: {
    orders: { view: 'own', update: 'own', export: 'own', delete: 'none' },
    payments: { view: 'own', update: 'own', delete: 'none' },
    productionTasks: { view: 'all', update: 'all' },
  },
  operator: {
    orders: { view: 'all', update: 'own', export: 'own', delete: 'none' },
    payments: { view: 'none', update: 'none', delete: 'none' },
    productionTasks: { view: 'all', update: 'all' },
  },
  worker: {
    orders: { view: 'assigned', update: 'none', export: 'none', delete: 'none' },
    payments: { view: 'none', update: 'none', delete: 'none' },
    productionTasks: { view: 'assigned', update: 'assigned' },
  },
  viewer: {
    orders: { view: 'all', update: 'none', export: 'none', delete: 'none' },
    payments: { view: 'none', update: 'none', delete: 'none' },
    productionTasks: { view: 'all', update: 'none' },
  },
} as const satisfies Record<UserRole, RolePolicy>;

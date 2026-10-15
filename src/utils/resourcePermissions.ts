import { featureFlags } from '../config/featureFlags';
import { getCurrentUserRoleKey } from './resourceVisibility';
import { can, type PermissionCarrier } from './permissions';
import type { PermissionName } from '../api/types/authApi.types';

type RoleAwarePermissionCarrier =
  (PermissionCarrier & { role?: string; role_id?: number; roleId?: number }) | null | undefined;

const PACKER_HASURA_SELECT_RESOURCES = new Set<string>([
  'order_statuses',
  'production_statuses',
  'production_status_events',
]);
const APP_SETTINGS_READ_ROLES = new Set([
  'superadmin',
  'admin',
  'top_manager',
  'manager',
  'operator',
  'worker',
  'packer',
  'viewer',
]);

export function canQueryUsersResource(user: PermissionCarrier | null | undefined): boolean {
  if (!featureFlags.useBackendPermissions) return true;

  return can('users.view', user);
}

export function canQueryAppSettingsResource(
  user: RoleAwarePermissionCarrier,
): boolean {
  if (featureFlags.useBackendAuth && !user) return false;
  if (!featureFlags.useBackendPermissions) return true;

  const roleKey = getCurrentUserRoleKey(user);
  return roleKey !== undefined && APP_SETTINGS_READ_ROLES.has(roleKey);
}

export function canQueryHasuraResource(
  resource: string,
  user: RoleAwarePermissionCarrier,
): boolean {
  if (!featureFlags.useBackendAuth && !featureFlags.useBackendPermissions) return true;
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (resource === 'app_settings') {
    return canQueryAppSettingsResource(user);
  }

  if (roleKey === 'packer') {
    return PACKER_HASURA_SELECT_RESOURCES.has(resource);
  }

  if (resource === 'users') {
    return canQueryUsersResource(user);
  }

  return true;
}

/**
 * Quick add of an edge type, milling type or film from the order form: Hasura allows the insert only with
 * references.manage or references.quick_create (access groups 0Б).
 */
export function canQuickCreateReference(user?: PermissionCarrier | null): boolean {
  if (!featureFlags.useBackendPermissions) return true;
  return can('references.manage', user) || can('references.quick_create', user);
}

export type HasuraWriteOperation = 'insert' | 'update' | 'delete';

const REFERENCE_WRITE = { insert: ['references.manage'], update: ['references.manage'], delete: ['references.manage'] } as const;
const QUICK_CREATE_REFERENCE_WRITE = {
  insert: ['references.manage', 'references.quick_create'],
  update: ['references.manage'],
  delete: ['references.manage'],
} as const;
const manageWrite = (permission: PermissionName) => ({ insert: [permission], update: [permission], delete: [permission] });

/**
 * Permissions that Hasura requires for a direct write (any one of the list), mirroring the predicates of
 * ops/hasura/access-predicates.json (access groups 0Б). Checked here so the user gets a clear refusal instead of a
 * GraphQL permission error; Hasura enforces the same rule.
 */
export const HASURA_WRITE_PERMISSIONS: Readonly<Record<string, Partial<Record<HasuraWriteOperation, readonly PermissionName[]>>>> = {
  edge_types: QUICK_CREATE_REFERENCE_WRITE,
  milling_types: QUICK_CREATE_REFERENCE_WRITE,
  films: QUICK_CREATE_REFERENCE_WRITE,
  film_types: REFERENCE_WRITE,
  material_types: REFERENCE_WRITE,
  payment_types: REFERENCE_WRITE,
  payment_statuses: REFERENCE_WRITE,
  order_statuses: REFERENCE_WRITE,
  production_statuses: REFERENCE_WRITE,
  units: REFERENCE_WRITE,
  requisition_statuses: REFERENCE_WRITE,
  movements_statuses: REFERENCE_WRITE,
  resource_requirements_statuses: REFERENCE_WRITE,
  material_transaction_types: REFERENCE_WRITE,
  transaction_direction: REFERENCE_WRITE,
  employees: manageWrite('employees.manage'),
  materials: manageWrite('materials.manage'),
  suppliers: manageWrite('suppliers.manage'),
  vendors: manageWrite('vendors.manage'),
  workshops: manageWrite('workshops.manage'),
  work_centers: manageWrite('work_centers.manage'),
  vlm_providers: manageWrite('vlm.configure'),
  vlm_provider_models: manageWrite('vlm.configure'),
  vlm_prompts: manageWrite('vlm.configure'),
  app_settings: manageWrite('settings.manage'),
  clients: { insert: ['clients.create'], update: ['clients.update'], delete: ['clients.delete'] },
};

/**
 * Resources whose writes are backend commands only (their Hasura write permissions are revoked): the doweling card and
 * the quick-create use `/api/v1/doweling-orders`, links of an order go with the order save.
 */
export const BACKEND_OWNED_HASURA_WRITES: ReadonlySet<string> = new Set(['doweling_orders', 'order_doweling_links']);

export function canMutateHasuraResource(
  resource: string,
  user: RoleAwarePermissionCarrier,
  operation?: HasuraWriteOperation,
): boolean {
  if (!featureFlags.useBackendAuth && !featureFlags.useBackendPermissions) return true;
  if (featureFlags.useBackendAuth && !user) return false;

  const roleKey = getCurrentUserRoleKey(user);
  if (roleKey === 'packer') return false;
  if (BACKEND_OWNED_HASURA_WRITES.has(resource)) return false;

  if (featureFlags.useBackendPermissions && operation) {
    const required = HASURA_WRITE_PERMISSIONS[resource]?.[operation];
    if (required && !required.some((permission) => can(permission, user))) return false;
  }

  return canQueryHasuraResource(resource, user);
}

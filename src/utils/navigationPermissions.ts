import type { PermissionName } from '../api/types/authApi.types';
import { canAny, type PermissionCarrier } from './permissions';

export const SETTINGS_CATEGORY_PERMISSIONS: PermissionName[] = [
  'settings.view',
  'settings.manage',
  'users.view',
];

export const RESOURCE_PERMISSION_MAP: Record<string, PermissionName[]> = {
  orders_view: ['orders.view'],
  calendar: ['orders.view'],
  doweling_orders_view: ['orders.view'],
  order_workshops: ['orders.view'],
  order_resource_requirements: ['orders.view'],
  clients: ['references.view'],
  materials: ['references.view'],
  milling_types: ['references.view'],
  films: ['references.view'],
  edge_types: ['references.view'],
  vendors: ['references.view'],
  suppliers: ['references.view'],
  film_types: ['references.view'],
  material_types: ['references.view'],
  units: ['references.view'],
  order_statuses: ['references.view'],
  payment_statuses: ['references.view'],
  payment_types: ['references.view'],
  requisition_statuses: ['references.view'],
  movements_statuses: ['references.view'],
  material_transaction_types: ['references.view'],
  transaction_direction: ['references.view'],
  production_statuses: ['references.view'],
  resource_requirements_statuses: ['references.view'],
  workshops: ['references.view'],
  work_centers: ['references.view'],
  payments: ['payments.view'],
  payments_view: ['payments.view', 'analytics.view'],
  clients_analytics_view: ['analytics.view'],
  users: ['users.view'],
  employees: ['users.view'],
  configuration: ['settings.view', 'settings.manage'],
};

export interface LegacyPermissionCarrier extends PermissionCarrier {
  role?: string;
  role_id?: number;
}

export function isLegacyAdminUser(
  user: LegacyPermissionCarrier | null | undefined,
  backendPermissionsEnabled: boolean,
): boolean {
  if (backendPermissionsEnabled || !user) return false;

  return (
    user.role_id === 1 ||
    user.role_id === 2 ||
    user.role === 'admin' ||
    user.role === 'superadmin'
  );
}

export function canViewSettingsCategory(
  user: PermissionCarrier | null | undefined,
  backendPermissionsEnabled: boolean,
  legacyIsAdmin: boolean,
): boolean {
  if (!backendPermissionsEnabled) return legacyIsAdmin;
  return canAny(SETTINGS_CATEGORY_PERMISSIONS, user);
}

export function canViewNavigationResource(
  resourceName: string,
  user: PermissionCarrier | null | undefined,
  backendPermissionsEnabled: boolean,
): boolean {
  if (!backendPermissionsEnabled) return true;

  const permissions = RESOURCE_PERMISSION_MAP[resourceName];
  if (!permissions) return false;

  return canAny(permissions, user);
}

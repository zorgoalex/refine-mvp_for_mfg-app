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
  payments: ['payments.view'],
  payments_view: ['payments.view', 'analytics.view'],
  clients_analytics_view: ['analytics.view'],
  users: ['users.view'],
  employees: ['users.view'],
  configuration: ['settings.view', 'settings.manage'],
};

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

  const permissions = RESOURCE_PERMISSION_MAP[resourceName] ?? ['references.view'];
  return canAny(permissions, user);
}

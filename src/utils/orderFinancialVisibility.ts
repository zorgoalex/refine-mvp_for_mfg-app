import type { PermissionName } from '../api/types/authApi.types';
import { featureFlags } from '../config/featureFlags';
import { can, type PermissionCarrier } from './permissions';
import { getCurrentUserRoleKey } from './resourceVisibility';

export type OrderFinancialVisibilityOverride = 'inherit' | 'allow' | 'deny';

export interface OrderFinancialVisibilityMatrix {
  version: 1;
  roles: Record<string, boolean>;
  users: Record<string, boolean>;
}

export interface OrderFinancialVisibilityUser extends PermissionCarrier {
  id?: string | number;
  role?: string;
  roleId?: number;
  role_id?: number;
}

export const EMPTY_ORDER_FINANCIAL_VISIBILITY_MATRIX: OrderFinancialVisibilityMatrix = {
  version: 1,
  roles: {},
  users: {},
};

const DEFAULT_FINANCIAL_ROLES = new Set([
  'superadmin',
  'admin',
  'top_manager',
  'manager',
]);

export const ORDER_FINANCIAL_FIELD_KEYS = new Set([
  'payment_status_name',
  'payment_status_id',
  'final_amount',
  'paid_amount',
  'total_amount',
  'discount',
  'surcharge',
  'payment_date',
  'milling_cost_per_sqm',
  'detail_cost',
  'finalAmount',
  'paidAmount',
  'totalFinalAmountLabel',
  'totalPaidAmountLabel',
]);

export function canViewOrderFinancials(
  user?: PermissionCarrier | null,
): boolean {
  return !featureFlags.useBackendPermissions || can('orders.view_financials', user);
}

export function canManageOrderContent(
  permission: PermissionName,
  user?: PermissionCarrier | null,
  financialLayerVisible = canViewOrderFinancials(user),
): boolean {
  const permissionAllowed = !featureFlags.useBackendPermissions || can(permission, user);
  return permissionAllowed && financialLayerVisible;
}

export function roleHasBaseOrderFinancialAccess(roleKey: string | undefined): boolean {
  return roleKey !== undefined && DEFAULT_FINANCIAL_ROLES.has(roleKey);
}

export function normalizeOrderFinancialVisibilityMatrix(
  value: unknown,
): OrderFinancialVisibilityMatrix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_ORDER_FINANCIAL_VISIBILITY_MATRIX, roles: {}, users: {} };
  }

  const source = value as Record<string, unknown>;
  return {
    version: 1,
    roles: normalizeBooleanOverrides(source.roles),
    users: normalizeBooleanOverrides(source.users),
  };
}

export function resolveOrderFinancialVisibility(input: {
  baseAllowed: boolean;
  user: OrderFinancialVisibilityUser | null | undefined;
  matrix: OrderFinancialVisibilityMatrix | null | undefined;
}): boolean {
  if (!input.baseAllowed) return false;

  const matrix = input.matrix;
  if (!matrix) return true;

  const userKey = input.user?.id === undefined ? undefined : String(input.user.id);
  if (userKey !== undefined && matrix.users[userKey] !== undefined) {
    return matrix.users[userKey];
  }

  const roleKey = getCurrentUserRoleKey(input.user);
  if (roleKey !== undefined && matrix.roles[roleKey] !== undefined) {
    return matrix.roles[roleKey];
  }

  return true;
}

export function getOrderFinancialVisibilityOverride(
  matrix: OrderFinancialVisibilityMatrix,
  scope: 'roles' | 'users',
  key: string | number,
): OrderFinancialVisibilityOverride {
  const value = matrix[scope][String(key)];
  return value === undefined ? 'inherit' : value ? 'allow' : 'deny';
}

export function setOrderFinancialVisibilityOverride(
  matrix: OrderFinancialVisibilityMatrix,
  scope: 'roles' | 'users',
  key: string | number,
  override: OrderFinancialVisibilityOverride,
): OrderFinancialVisibilityMatrix {
  const normalizedKey = String(key);
  const nextOverrides = { ...matrix[scope] };
  if (override === 'inherit') delete nextOverrides[normalizedKey];
  else nextOverrides[normalizedKey] = override === 'allow';

  return {
    ...matrix,
    version: 1,
    [scope]: nextOverrides,
  };
}

export function filterOrderFinancialItems<T>(
  items: readonly T[],
  showFinancials: boolean,
  getKey: (item: T) => string = (item) => String((item as { key?: unknown }).key ?? ''),
): T[] {
  if (showFinancials) return [...items];
  return items.filter((item) => !ORDER_FINANCIAL_FIELD_KEYS.has(getKey(item)));
}

function normalizeBooleanOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, boolean>>(
    (result, [key, override]) => {
      if (typeof override === 'boolean') result[String(key)] = override;
      return result;
    },
    {},
  );
}

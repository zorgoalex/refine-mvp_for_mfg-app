export const PACKER_ROLE = 'packer';
export const PACKER_ROLE_ID = 30;

const PACKER_ALLOWED_ORDER_STATUS_NAMES = new Set(['готов к выдаче', 'выдан']);

export interface PackerRoleCarrier {
  role?: string | null;
  roleId?: number | string | null;
  role_id?: number | string | null;
}

export interface NamedOrderStatus {
  name?: string | null;
}

export function isPackerUser(user: PackerRoleCarrier | null | undefined): boolean {
  if (!user) return false;
  if (user.role === PACKER_ROLE) return true;

  const roleId = user.roleId ?? user.role_id;
  return Number(roleId) === PACKER_ROLE_ID;
}

export function isPackerAllowedOrderStatusName(name: string | null | undefined): boolean {
  if (!name) return false;
  return PACKER_ALLOWED_ORDER_STATUS_NAMES.has(normalizeStatusName(name));
}

export function filterOrderStatusesForPacker<T extends NamedOrderStatus>(
  statuses: T[],
  user: PackerRoleCarrier | null | undefined,
): T[] {
  if (!isPackerUser(user)) return statuses;
  return statuses.filter((status) => isPackerAllowedOrderStatusName(status.name));
}

function normalizeStatusName(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}

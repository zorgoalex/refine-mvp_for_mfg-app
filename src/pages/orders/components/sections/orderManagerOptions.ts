import type { ReferenceOption } from '../../../../query/orderFormDataReferences';

/** Permission to choose another manager of an order (default: superadmin and admin; set in «Роли и права»). */
export const ORDER_MANAGER_CHANGE_PERMISSION = 'orders.manager.change';

/**
 * Options of the «Менеджер» select: the candidates (active ERP users) plus the order's current manager when not among
 * them (an inactive user keeps the name read with the order).
 */
export function orderManagerOptions(
  candidates: ReferenceOption[],
  currentManagerId: number | null | undefined,
  currentManagerName: string | null | undefined,
): ReferenceOption[] {
  if (currentManagerId == null || candidates.some((option) => option.value === currentManagerId)) return candidates;
  return [...candidates, { value: currentManagerId, label: currentManagerName || `Пользователь ${currentManagerId}`, sortOrder: -1 }];
}

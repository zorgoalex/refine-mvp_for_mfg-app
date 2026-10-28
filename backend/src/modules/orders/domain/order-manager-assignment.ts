import { ApiError } from '../../../common/errors/api-error';

/**
 * Who manages an order (orders.manager_id → users). The manager owns the order's «own» visibility and its Bitrix24
 * responsible user, so a user command may choose another manager only with `orders.manager.change` (user decision
 * 2026-10-28; plan spec_erp/plans/orders/2026-10-28-order-manager-field-plan.md).
 *
 * Protocol: the form sends the ERP user in `managerUserId`. The former `managerId` came from a form that listed
 * employees (employee ids written as user ids), so it is accepted only as «no change»: equal to the stored manager on
 * update, or the current user on create. Anything else is an outdated form (409) — never a write of a wrong user.
 * Absent / null on update keeps the stored manager (it used to reassign the order to whoever saved it).
 */
export interface OrderManagerAssignmentInput {
  mode: 'create' | 'update';
  currentUserId: string;
  /** Stored manager of the order (update only; null for legacy rows without one). */
  storedManagerId: string | null;
  /** `header.managerUserId` of the new protocol. */
  managerUserId: number | null | undefined;
  /** `header.managerId` of the former protocol. */
  legacyManagerId: number | null | undefined;
  canChangeManager: boolean;
}

export interface OrderManagerAssignment {
  /** Manager to write (create: never null; update: the stored one when unchanged). */
  managerId: string | null;
  changed: boolean;
  previousManagerId: string | null;
}

export function resolveOrderManagerAssignment(input: OrderManagerAssignmentInput): OrderManagerAssignment {
  const baseline = input.mode === 'create' ? input.currentUserId : input.storedManagerId;
  const requested = input.managerUserId ?? null;
  const legacy = input.legacyManagerId ?? null;

  if (requested === null && legacy !== null && String(legacy) !== baseline) {
    throw new ApiError(
      409,
      'ORDER_FORM_OUTDATED',
      'Форма заказа устарела — обновите страницу и выберите менеджера заново',
      { field: 'header.managerId' },
    );
  }

  const target = requested === null ? baseline : String(requested);
  const changed = target !== baseline;
  if (changed && !input.canChangeManager) {
    throw new ApiError(403, 'ORDER_MANAGER_CHANGE_FORBIDDEN', 'Недостаточно прав для смены менеджера заказа', {
      requiredPermission: 'orders.manager.change',
    });
  }
  return {
    managerId: target,
    changed,
    previousManagerId: input.mode === 'create' ? null : input.storedManagerId,
  };
}

/** A manager must be an active ERP user who is not a service account. */
export function invalidOrderManagerError(managerId: string): ApiError {
  return new ApiError(422, 'ORDER_MANAGER_INVALID', 'Менеджером заказа может быть только активный пользователь ERP', {
    managerId,
  });
}

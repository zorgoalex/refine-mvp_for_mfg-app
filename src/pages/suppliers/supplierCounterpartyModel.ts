import { ApiError } from '../../api/apiError';
import type { SupplierCounterparty } from '../../api/partyContactsApi';

export interface CounterpartyOption { value: string; label: string; disabled: boolean }

/** Options of the «Контрагент 1С» select: a counterparty of another supplier is shown but cannot be chosen. */
export function counterpartyOptions(items: readonly SupplierCounterparty[], supplierId: number): CounterpartyOption[] {
  return items.map((item) => {
    const other = item.supplierId !== null && item.supplierId !== supplierId;
    return {
      value: item.refKey1c,
      label: `${item.name}${item.isSupplier ? ' · поставщик в 1С' : ''}${other ? ` — уже привязан к «${item.supplierName ?? `#${item.supplierId}`}»` : ''}`,
      disabled: other,
    };
  });
}

const LINK_ERRORS: Record<string, string> = {
  SUPPLIER_COUNTERPARTY_TAKEN: 'Этот контрагент 1С уже привязан к другому поставщику.',
  SUPPLIER_COUNTERPARTY_UNKNOWN: 'Такого контрагента нет в загруженных данных 1С.',
  SUPPLIER_NOT_FOUND: 'Поставщик не найден — обновите страницу.',
  PERMISSION_DENIED: 'Недостаточно прав для изменения привязки.',
};

export const SUPPLIER_COUNTERPARTY_CONFLICT = 'SUPPLIER_COUNTERPARTY_CONFLICT';

export function supplierLinkErrorMessage(error: unknown): string {
  if (error instanceof ApiError && LINK_ERRORS[error.code]) return LINK_ERRORS[error.code];
  return 'Не удалось изменить привязку к контрагенту 1С.';
}

/** A backend without the link API (older release): the block is hidden. */
export function isCounterpartyApiMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code !== 'SUPPLIER_NOT_FOUND';
}

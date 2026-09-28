import type { OnecAllocationState, OnecDocumentsTab, OnecUnitCode } from '../../api/types/onecDocumentsApi.types';

export const ONEC_DOCUMENTS_TABS: readonly OnecDocumentsTab[] = ['receipts', 'payments'];

export const ONEC_DOCUMENTS_TAB_OPTIONS: Array<{ value: OnecDocumentsTab; label: string }> = [
  { value: 'receipts', label: 'Приходы' },
  { value: 'payments', label: 'Оплаты' },
];

export const ALLOCATION_STATE_LABELS: Record<OnecAllocationState, string> = {
  none: 'не привязан',
  partial: 'частично привязан',
  full: 'полностью привязан',
};

export const ALLOCATION_STATE_TAG_COLORS: Record<OnecAllocationState, string | undefined> = {
  none: undefined,
  partial: 'warning',
  full: 'success',
};

export function allocationStateLabel(state: OnecAllocationState): string {
  return ALLOCATION_STATE_LABELS[state];
}

export function allocationStateTagColor(state: OnecAllocationState): string | undefined {
  return ALLOCATION_STATE_TAG_COLORS[state];
}

export interface OnecAllocationEligibilityInput {
  tab: OnecDocumentsTab;
  posted: boolean;
  deletedInOnec: boolean;
  /** Строка сопоставлена с материалом ERP (только приход). */
  lineMapped: boolean;
  /** null — прогресс не считается (единица строки не сопоставима с потребностью), позволяет распределение. */
  remaining: number | null;
  canManage: boolean;
  /** Право finance.view — обязательно для распределения оплат. */
  canSeeAmounts: boolean;
}

/**
 * Можно ли открыть «+ Заказ» для строки документа. Приход требует
 * сопоставленной номенклатуры; оплата требует finance.view; в обоих случаях —
 * документ проведён и не удалён в 1С, остаток строки не исчерпан (если считается),
 * и право procurement.manage.
 */
export function canAddOnecAllocation(input: OnecAllocationEligibilityInput): boolean {
  if (!input.canManage) return false;
  if (!input.posted || input.deletedInOnec) return false;
  if (input.tab === 'payments' && !input.canSeeAmounts) return false;
  if (input.tab === 'receipts' && !input.lineMapped) return false;
  if (input.remaining != null && input.remaining <= 0) return false;
  return true;
}

/**
 * Количество по умолчанию для прихода: меньшее из остатка строки документа и
 * потребности заказа в материале. Пользователь может изменить перед отправкой.
 */
export function defaultReceiptAllocationQuantity(
  lineRemaining: number | null,
  orderDemandQuantity: number | null,
): number | undefined {
  const candidates = [lineRemaining, orderDemandQuantity].filter(
    (value): value is number => value != null && value > 0,
  );
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

/** Сумма по умолчанию для оплаты — весь остаток строки, если он посчитан. */
export function defaultPaymentAllocationAmount(lineRemaining: number | null): number | undefined {
  return lineRemaining != null && lineRemaining > 0 ? lineRemaining : undefined;
}

export const ONEC_UNIT_LABELS: Record<OnecUnitCode, string> = {
  sheet: 'лист',
  m2: 'м²',
  lm: 'пог. м',
  pcs: 'шт',
  set: 'компл.',
};

/** Подпись единицы: нормализованная (unitCode), иначе — как в 1С (unitName). */
export function onecUnitLabel(unitCode: OnecUnitCode | null, unitName: string | null): string {
  if (unitCode) return ONEC_UNIT_LABELS[unitCode];
  return unitName?.trim() || '';
}

const quantityFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const amountFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatOnecQuantity(quantity: number, unitCode: OnecUnitCode | null, unitName: string | null): string {
  const unit = onecUnitLabel(unitCode, unitName);
  const value = quantityFormatter.format(quantity);
  return unit ? `${value} ${unit}` : value;
}

const CURRENCY_SYMBOLS: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€' };

/** Символ валюты документа; неизвестный код показывается как есть. */
export function currencySymbol(currency: string | null | undefined): string {
  const code = (currency ?? 'KZT').trim().toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? code;
}

/** «—» когда сумма скрыта (нет finance.view) или не задана. Валюта — из документа. */
export function formatOnecAmount(amount: number | null, currency: string | null | undefined): string {
  if (amount == null) return '—';
  return `${amountFormatter.format(amount)} ${currencySymbol(currency)}`;
}

const ONEC_ALLOCATION_ERROR_MESSAGES: Record<string, string> = {
  ONEC_DOCUMENT_NOT_ALLOCATABLE: 'Документ не проведён или удалён в 1С',
  ONEC_LINE_NOT_MAPPED: 'Строка документа не сопоставлена с материалом ERP',
  ONEC_LINE_RESOURCE_MISMATCH: 'Материал строки документа не совпадает с выбранным',
  ONEC_ALLOCATION_MEASURE_INVALID: 'Неверное количество или сумма для этого вида документа',
  ONEC_ALLOCATION_EXCEEDS_LINE: 'Распределено больше, чем есть в строке документа',
  ONEC_ALLOCATION_EXISTS: 'Эта строка уже распределена на этот материал заказа',
  PROCUREMENT_VERSION_CONFLICT: 'Отметку закупа уже изменил другой пользователь',
  PROCUREMENT_DEMAND_CHANGED: 'Потребность в материале изменилась',
  PROCUREMENT_RESOURCE_NOT_IN_ORDER: 'Этого материала нет в потребности заказа',
  PROCUREMENT_LOCKED_BY_ONEC: 'Материал уже оприходован документом 1С',
  PERMISSION_DENIED: 'Недостаточно прав для этой операции',
};

/** Сообщение об ошибке команды распределения — код важнее общего message сервера, если он известен. */
export function onecAllocationErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return 'Не удалось выполнить операцию';
  const known = error.code ? ONEC_ALLOCATION_ERROR_MESSAGES[error.code] : undefined;
  return known ?? error.message ?? 'Не удалось выполнить операцию';
}

/** Коды, после которых распределение/остаток строки могли поменяться — карточку документа стоит перечитать. */
const STATE_CHANGING_ONEC_ERROR_CODES = new Set([
  'PROCUREMENT_VERSION_CONFLICT',
  'PROCUREMENT_DEMAND_CHANGED',
  'ONEC_ALLOCATION_EXCEEDS_LINE',
  'ONEC_ALLOCATION_EXISTS',
  'ONEC_DOCUMENT_NOT_ALLOCATABLE',
  'PROCUREMENT_LOCKED_BY_ONEC',
]);

export function onecAllocationErrorRequiresReload(code: string | undefined): boolean {
  return code != null && STATE_CHANGING_ONEC_ERROR_CODES.has(code);
}

/** Карточка потребностей в модалке распределения относится к выбранному заказу и уже загружена. */
export function isOrderCardCurrent(
  cardOrderId: number | null,
  loading: boolean,
  selectedOrderId: number | null | undefined,
): boolean {
  return !loading && cardOrderId !== null && selectedOrderId != null && cardOrderId === selectedOrderId;
}

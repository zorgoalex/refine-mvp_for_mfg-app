import type { OrderDetail } from '../types/orders';

export const MIN_ORDER_DETAIL_GRID_ROWS = 20;
export const MAX_ORDER_DETAIL_RECENT_VALUES = 20;

export type OrderDetailReferenceField =
  | 'milling_type_id'
  | 'edge_type_id'
  | 'sheet_material_type_id'
  | 'film_id'
  | 'production_status_id';

export interface OrderDetailReferenceOption {
  value: number;
  label?: unknown;
}

export function isOrderDetailPlaceholder(
  detail: Pick<OrderDetail, 'is_placeholder'> | null | undefined,
): boolean {
  return detail?.is_placeholder === true;
}

export function businessOrderDetails(details: readonly OrderDetail[]): OrderDetail[] {
  return details.filter((detail) => !isOrderDetailPlaceholder(detail));
}

/** Reuse only pristine UI scaffolding, never saved, edited or populated rows.
 * Unknown nonempty fields fail closed, including links, references and provenance.
 */
export function getOrderImportPlaceholderIds(details: readonly OrderDetail[]): number[] {
  return details.filter(isPristineOrderDetailPlaceholder)
    .sort((left, right) => (left.detail_number ?? 0) - (right.detail_number ?? 0))
    .map(detail => detail.temp_id!);
}

/** A prepared empty grid row nobody has touched (the same rule an import uses to reuse rows). */
export function isPristineOrderDetailPlaceholder(detail: OrderDetail): boolean {
  return detail.is_placeholder === true
    && detail.detail_id == null && detail.delete_flag !== true
    && Number.isSafeInteger(detail.temp_id) && Number(detail.temp_id) > 0
    && Object.entries(detail).every(([key, value]) => {
      if (['temp_id', 'detail_number', 'is_placeholder', 'order_id'].includes(key)) return true;
      if (key === 'priority' && value === 100) return true;
      if (key === 'milling_type_id' && value === 1) return true;
      if (key === 'edge_type_id' && value === 1) return true;
      return value == null || value === '' || value === 0 || value === false;
    });
}

export function recentOrderDetailReferenceIds(
  details: readonly OrderDetail[],
  currentDetail: OrderDetail,
  field: OrderDetailReferenceField,
  limit = MAX_ORDER_DETAIL_RECENT_VALUES,
): number[] {
  const currentKey = currentDetail.temp_id ?? currentDetail.detail_id;
  const currentIndex = details.findIndex(
    (detail) => (detail.temp_id ?? detail.detail_id) === currentKey,
  );
  if (currentIndex <= 0 || limit <= 0) return [];

  const recentIds: number[] = [];
  const seen = new Set<number>();
  for (let index = currentIndex - 1; index >= 0 && recentIds.length < limit; index -= 1) {
    const detail = details[index];
    if (isOrderDetailPlaceholder(detail)) continue;
    const value = Number(detail[field]);
    if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    recentIds.push(value);
  }
  return recentIds;
}

/** Promote order-local recent values while preserving catalog order for the remainder. */
export function promoteOrderDetailOptions<T extends OrderDetailReferenceOption>(
  options: readonly T[],
  recentIds: readonly number[],
): T[] {
  if (recentIds.length === 0) return [...options];
  const byId = new Map(options.map((option) => [Number(option.value), option]));
  const promoted: T[] = [];
  const promotedIds = new Set<number>();

  recentIds.forEach((id) => {
    const option = byId.get(id);
    if (!option || promotedIds.has(id)) return;
    promoted.push(option);
    promotedIds.add(id);
  });

  options.forEach((option) => {
    if (!promotedIds.has(Number(option.value))) promoted.push(option);
  });
  return promoted;
}

const DETAIL_FIELDS_CLEARED_FOR_EMPTY_TAIL: Partial<Record<keyof OrderDetail, null | false>> = {
  height: null,
  width: null,
  quantity: null,
  area: null,
  material_id: null,
  sheet_material_type_id: null,
  milling_type_id: null,
  hdf_parameter_override_mm: null,
  edge_type_id: null,
  film_id: null,
  milling_cost_per_sqm: null,
  // the default-price marker goes with the price: a cleared row is a pristine grid row again
  prefilled_milling_cost_per_sqm: null,
  detail_cost: null,
  note: null,
  basis_project: null,
  bazis_project_id: null,
  basis_product: null,
  basis_data: null,
  basis_designation: null,
  doweling: false,
  detail_name: null,
  production_status_id: null,
  joint_order_id: null,
  link_cutting_file: null,
  link_cutting_image_file: null,
  link_cad_file: null,
  link_pdf_file: null,
  ref_key_1c: null,
};

export interface OrderDetailsSavePreparation {
  detailsForSave: OrderDetail[];
  detailsForDisplay: OrderDetail[];
  emptyTailKeys: Set<string>;
  emptyTailCount: number;
}

export function orderDetailIdentityKey(
  detail: Pick<OrderDetail, 'detail_id' | 'temp_id' | 'detail_number'>,
  index = 0,
): string {
  if (isPositiveInteger(detail.detail_id)) return `id:${detail.detail_id}`;
  if (detail.temp_id !== null && detail.temp_id !== undefined) {
    return `temp:${String(detail.temp_id)}`;
  }
  return `index:${index}:${detail.detail_number ?? 0}`;
}

export function hasOrderDetailRequiredEntryValues(
  detail: Pick<OrderDetail, 'height' | 'width' | 'quantity' | 'milling_cost_per_sqm' | 'detail_cost'>,
): boolean {
  return (
    isPositiveNumber(detail.height) &&
    isPositiveNumber(detail.width) &&
    isPositiveNumber(detail.quantity) &&
    isPositiveNumber(detail.milling_cost_per_sqm) &&
    isPositiveNumber(detail.detail_cost)
  );
}

export function isNewOrderDetailTailClearCandidate(detail: OrderDetail): boolean {
  return !isPositiveInteger(detail.detail_id) && !hasOrderDetailTailEntryValues(detail);
}

export function collectNewEmptyTailDetailKeys(details: readonly OrderDetail[]): Set<string> {
  const sorted = details
    .map((detail, index) => ({
      detail,
      index,
      key: orderDetailIdentityKey(detail, index),
    }))
    .sort((left, right) => {
      const byNumber = normalizeNumber(left.detail.detail_number) - normalizeNumber(right.detail.detail_number);
      return byNumber === 0 ? left.index - right.index : byNumber;
    });

  const keys = new Set<string>();
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const entry = sorted[index];
    if (!isNewOrderDetailTailClearCandidate(entry.detail)) break;
    keys.add(entry.key);
  }
  return keys;
}

export function clearOrderDetailTailRowValues(detail: OrderDetail): OrderDetail {
  return {
    ...detail,
    ...DETAIL_FIELDS_CLEARED_FOR_EMPTY_TAIL,
  } as OrderDetail;
}

export function collectOrderDetailEmptyTailRowsForDisplay(
  details: readonly OrderDetail[],
): OrderDetail[] {
  const emptyTailKeys = collectNewEmptyTailDetailKeys(details);
  return details
    .map((detail, index) => ({ detail, index }))
    .filter(({ detail, index }) => emptyTailKeys.has(orderDetailIdentityKey(detail, index)))
    .map(({ detail }) => clearOrderDetailTailRowValues(detail));
}

export function appendOrderDetailEmptyTailRowsForDisplay(
  savedDetails: readonly OrderDetail[],
  emptyTailRows: readonly OrderDetail[],
  orderId?: number | null,
): OrderDetail[] {
  if (emptyTailRows.length === 0) return [...savedDetails];

  const maxDetailNumber = savedDetails.reduce(
    (max, detail) => Math.max(max, normalizeNumber(detail.detail_number)),
    0,
  );

  const restoredTailRows = emptyTailRows.map((detail, index) => ({
    ...clearOrderDetailTailRowValues(detail),
    detail_id: undefined,
    order_id: orderId ?? detail.order_id ?? undefined,
    delete_flag: false,
    detail_number: maxDetailNumber + index + 1,
  }));

  return [...savedDetails, ...restoredTailRows];
}

export function prepareOrderDetailsForSave(
  details: readonly OrderDetail[],
): OrderDetailsSavePreparation {
  const emptyTailKeys = collectNewEmptyTailDetailKeys(details);
  const detailsForSave: OrderDetail[] = [];
  const detailsForDisplay: OrderDetail[] = [];

  details.forEach((detail, index) => {
    const key = orderDetailIdentityKey(detail, index);
    if (emptyTailKeys.has(key)) {
      detailsForDisplay.push(clearOrderDetailTailRowValues(detail));
      return;
    }
    detailsForSave.push(detail);
    detailsForDisplay.push(detail);
  });

  return {
    detailsForSave,
    detailsForDisplay,
    emptyTailKeys,
    emptyTailCount: emptyTailKeys.size,
  };
}

export function countOrderDetailsWithRequiredEntryValues(details: readonly OrderDetail[]): number {
  return details.filter(hasOrderDetailRequiredEntryValues).length;
}

function hasOrderDetailTailEntryValues(
  detail: Pick<OrderDetail, 'height' | 'width' | 'quantity' | 'milling_cost_per_sqm' | 'detail_cost' | 'prefilled_milling_cost_per_sqm'>,
): boolean {
  // a price the form put in by default («Параметры деталей по умолчанию») is not an entry while unchanged
  const prefilledPrice = detail.prefilled_milling_cost_per_sqm != null
    && Number(detail.milling_cost_per_sqm) === Number(detail.prefilled_milling_cost_per_sqm);
  return (
    isPositiveNumber(detail.height) ||
    isPositiveNumber(detail.width) ||
    (!prefilledPrice && isPositiveNumber(detail.milling_cost_per_sqm)) ||
    isPositiveNumber(detail.detail_cost) ||
    isUserEnteredQuantity(detail.quantity)
  );
}

function isUserEnteredQuantity(value: unknown): boolean {
  const numberValue = Number(value);
  // Historical quick-add drafts may carry quantity=1 before the user types anything.
  return Number.isFinite(numberValue) && numberValue > 1;
}

function isPositiveNumber(value: unknown): boolean {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0;
}

function isPositiveInteger(value: unknown): boolean {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0;
}

function normalizeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

const sameFormValue = (left: unknown, right: unknown): boolean => {
  const empty = (value: unknown) => value === null || value === undefined || value === '';
  if (empty(left) || empty(right)) return empty(left) && empty(right);
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  return left === right;
};

/**
 * May the open grid row be left without its checks? Only a grid row never saved by the user (still a placeholder:
 * saving a row in the table turns the flag off; quick-add rows start as placeholders with the form's defaults)
 * whose form is exactly as it opened. Anything typed or chosen — a size, a note, a material — keeps the checks.
 * (The import keeps its own stricter «pristine» rule.)
 */
export function canLeaveOpenRowUnchecked(
  storeRow: Pick<OrderDetail, 'is_placeholder' | 'detail_id'> | null | undefined,
  openedWith: Record<string, unknown> | null | undefined,
  current: Record<string, unknown>,
): boolean {
  if (!storeRow || storeRow.is_placeholder !== true || storeRow.detail_id != null || !openedWith) return false;
  return isOpenRowUntouched(openedWith, current);
}

/**
 * Nothing changed in an open grid row since it opened: every value it opened with is still there (empty values
 * equal each other), and no other field got a value. Such a row may be left without its checks.
 */
export function isOpenRowUntouched(openedWith: Record<string, unknown>, current: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(openedWith), ...Object.keys(current)]);
  for (const key of keys) {
    if (!sameFormValue(openedWith[key], current[key])) return false;
  }
  return true;
}

/** The snapshot of an untouched open row from the tab checkpoint; only for the row being restored. */
export function readOpenedRowValues(raw: unknown, editingKey: string | number): { key: string | number; values: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { key, values } = raw as { key?: unknown; values?: unknown };
  if ((typeof key !== 'string' && typeof key !== 'number') || String(key) !== String(editingKey)) return null;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  return { key, values: { ...(values as Record<string, unknown>) } };
}

import type { OrderDetail } from '../types/orders';

const DETAIL_FIELDS_CLEARED_FOR_EMPTY_TAIL: Partial<Record<keyof OrderDetail, null | false>> = {
  height: null,
  width: null,
  quantity: null,
  area: null,
  material_id: null,
  sheet_material_type_id: null,
  milling_type_id: null,
  edge_type_id: null,
  film_id: null,
  milling_cost_per_sqm: null,
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
  detail: Pick<OrderDetail, 'height' | 'width' | 'quantity' | 'milling_cost_per_sqm' | 'detail_cost'>,
): boolean {
  return (
    isPositiveNumber(detail.height) ||
    isPositiveNumber(detail.width) ||
    isPositiveNumber(detail.milling_cost_per_sqm) ||
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

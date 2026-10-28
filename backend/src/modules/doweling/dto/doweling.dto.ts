/**
 * Money of a doweling order (access groups «финансы»): changed only with orders.view_financials. A save without
 * these fields keeps them as they are; a partial set is a validation error (all or none).
 */
export const DOWELING_MONEY_FIELDS = [
  'paymentStatusId', 'paymentDate', 'totalAmount', 'finalAmount', 'discount', 'surcharge', 'paidAmount',
] as const;

export type DowelingMoneyField = (typeof DOWELING_MONEY_FIELDS)[number];

export function hasDowelingMoney(dto: Partial<Record<DowelingMoneyField, unknown>>): boolean {
  return DOWELING_MONEY_FIELDS.some((field) => dto[field] !== undefined);
}

export interface CreateDowelingOrderRequestDto {
  dowelingOrderName: string;
  designEngineerId: number;
  /** Needs orders.view_financials; absent = the status with code `unpaid`. */
  paymentStatusId?: number;
  dowelingOrderDate?: string | null;
  productionStatusId?: number | null;
  operatorId?: number | null;
  partsCount?: number | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  /** Link the new doweling order to this production order in the same transaction (quick-create from an order). */
  orderId?: number | null;
  /**
   * Client of the Bazis project. With `orderId` it must be the order's client (or absent: taken from the order).
   * Absent without `orderId` (previous frontend, legacy route only) — the DB default «нд», client_source 'default'.
   */
  clientId?: number | null;
  idempotencyKey: string;
}

export interface DowelingOrderLinkDto {
  orderDowelingLinkId: number;
  orderId: number;
}

export interface CreateDowelingOrderResponseDto {
  dowelingOrder: { dowelingOrderId: number; dowelingOrderName: string; version: number; clientId?: number | null };
  link?: DowelingOrderLinkDto | null;
  auditId?: string;
  requestId: string;
}

/**
 * Full replacement of the fields of the doweling card («Редактирование присадки»). The money group
 * (DOWELING_MONEY_FIELDS) is all-or-none: without it the money stays as it is; with it orders.view_financials is required.
 */
export interface UpdateDowelingOrderRequestDto {
  expectedVersion: number;
  dowelingOrderName: string;
  dowelingOrderDate: string;
  paymentStatusId?: number;
  designEngineerId: number;
  productionStatusId: number | null;
  operatorId: number | null;
  issueDate: string | null;
  paymentDate?: string | null;
  partsCount: number;
  totalAmount?: number | null;
  finalAmount?: number | null;
  discount?: number;
  surcharge?: number;
  paidAmount?: number;
  linkCadFile: string | null;
  linkPdfFile: string | null;
  refKey1c: string | null;
  isActive: boolean;
  /** Orders the doweling order is linked to after the save (empty when inactive). */
  orderIds: number[];
  /** Orders the card showed (active links ∪ legacy order_id); must equal the current ones (409 otherwise). */
  baseOrderIds: number[];
  /** Client of the Bazis project; absent = unchanged (a card of an unknown client takes the client of its orders). */
  clientId?: number;
}

export interface UpdateDowelingOrderResponseDto {
  dowelingOrder: { dowelingOrderId: number; dowelingOrderName: string; version: number; isActive: boolean };
  links: DowelingOrderLinkDto[];
  changed: boolean;
  auditId?: string;
  requestId: string;
}

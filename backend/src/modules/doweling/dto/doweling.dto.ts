export interface CreateDowelingOrderRequestDto {
  dowelingOrderName: string;
  designEngineerId: number;
  paymentStatusId: number;
  dowelingOrderDate?: string | null;
  productionStatusId?: number | null;
  operatorId?: number | null;
  partsCount?: number | null;
  linkCadFile?: string | null;
  linkPdfFile?: string | null;
  /** Link the new doweling order to this production order in the same transaction (quick-create from an order). */
  orderId?: number | null;
  idempotencyKey: string;
}

export interface DowelingOrderLinkDto {
  orderDowelingLinkId: number;
  orderId: number;
}

export interface CreateDowelingOrderResponseDto {
  dowelingOrder: { dowelingOrderId: number; dowelingOrderName: string; version: number };
  link?: DowelingOrderLinkDto | null;
  auditId?: string;
  requestId: string;
}

/** Full replacement of the fields of the doweling card («Редактирование присадки»). */
export interface UpdateDowelingOrderRequestDto {
  expectedVersion: number;
  dowelingOrderName: string;
  dowelingOrderDate: string;
  paymentStatusId: number;
  designEngineerId: number;
  productionStatusId: number | null;
  operatorId: number | null;
  issueDate: string | null;
  paymentDate: string | null;
  partsCount: number;
  totalAmount: number | null;
  finalAmount: number | null;
  discount: number;
  surcharge: number;
  paidAmount: number;
  linkCadFile: string | null;
  linkPdfFile: string | null;
  refKey1c: string | null;
  isActive: boolean;
  /** Orders the doweling order is linked to after the save (empty when inactive). */
  orderIds: number[];
  /** Orders the card showed (active links ∪ legacy order_id); must equal the current ones (409 otherwise). */
  baseOrderIds: number[];
}

export interface UpdateDowelingOrderResponseDto {
  dowelingOrder: { dowelingOrderId: number; dowelingOrderName: string; version: number; isActive: boolean };
  links: DowelingOrderLinkDto[];
  changed: boolean;
  auditId?: string;
  requestId: string;
}

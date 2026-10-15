/**
 * Backend doweling command DTOs (backend module src/modules/doweling):
 * - `POST /api/v1/doweling-orders` — create; with `orderId` the new doweling order is linked to that order in the same
 *   transaction (quick-create from an order);
 * - `PATCH /api/v1/doweling-orders/:id` — change the doweling card and the orders it is linked to.
 */
export interface CreateDowelingOrderRequest {
  dowelingOrderName: string;
  designEngineerId: number;
  paymentStatusId: number;
  dowelingOrderDate?: string | null;
  productionStatusId?: number | null;
  operatorId?: number | null;
  orderId?: number | null;
  idempotencyKey: string;
}

export interface DowelingOrderLink {
  orderDowelingLinkId: number;
  orderId: number;
}

export interface CreateDowelingOrderResponse {
  dowelingOrder: {
    dowelingOrderId: number;
    dowelingOrderName: string;
    version: number;
  };
  link?: DowelingOrderLink | null;
  auditId?: string;
  requestId: string;
}

export interface UpdateDowelingOrderRequest {
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
  orderIds: number[];
  /** Orders the card showed (active links ∪ legacy order_id); a mismatch is 409 DOWELING_LINKS_CONFLICT. */
  baseOrderIds: number[];
}

export interface UpdateDowelingOrderResponse {
  dowelingOrder: { dowelingOrderId: number; dowelingOrderName: string; version: number; isActive: boolean };
  links: DowelingOrderLink[];
  changed: boolean;
  auditId?: string;
  requestId: string;
}

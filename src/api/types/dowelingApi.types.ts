/**
 * Backend doweling quick-create command DTOs. Mirrors the create-only endpoint
 * `POST /api/v1/doweling-orders` (backend module src/modules/doweling). Standalone create —
 * no order link (order_doweling_links stays in order-save).
 */
export interface CreateDowelingOrderRequest {
  dowelingOrderName: string;
  designEngineerId: number;
  paymentStatusId: number;
  idempotencyKey: string;
}

export interface CreateDowelingOrderResponse {
  dowelingOrder: {
    dowelingOrderId: number;
    dowelingOrderName: string;
    version: number;
  };
  auditId?: string;
  requestId: string;
}

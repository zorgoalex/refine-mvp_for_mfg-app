export type DateOnlyString = string;

export interface MoveCalendarDateRequest {
  plannedCompletionDate: DateOnlyString | null;
  version: number;
  idempotencyKey: string;
}

export interface ChangeOrderStatusRequest {
  orderStatusId: number;
  version: number;
  idempotencyKey: string;
}

export interface ChangePaymentStatusRequest {
  paymentStatusId: number;
  version: number;
  idempotencyKey: string;
}

export interface ChangeProductionStatusRequest {
  productionStatusId: number;
  version: number;
  idempotencyKey: string;
}

export interface ProductionStageEventRequest {
  version: number;
  idempotencyKey: string;
}

export interface DetailProductionStageEventRequest {
  idempotencyKey: string;
  note?: string | null;
}

export interface ProductionActionOrderResponse {
  orderId: number;
  plannedCompletionDate?: DateOnlyString | null;
  orderStatusId?: number;
  paymentStatusId?: number;
  productionStatusId?: number;
  version: number;
}

export interface ProductionActionEventResponse {
  productionEventId?: number;
  productionStatusId: number;
  active: boolean;
}

export interface ProductionActionResponse {
  order: ProductionActionOrderResponse;
  event?: ProductionActionEventResponse;
  auditId?: string;
  requestId: string;
}

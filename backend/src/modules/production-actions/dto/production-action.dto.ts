export type DateOnlyString = string;

export interface MoveCalendarDateRequestDto {
  plannedCompletionDate: DateOnlyString | null;
  version: number;
  idempotencyKey: string;
}

export interface ChangeOrderStatusRequestDto {
  orderStatusId: number;
  version: number;
  idempotencyKey: string;
}

export interface ProductionStageEventRequestDto {
  version: number;
  idempotencyKey: string;
}

export interface ProductionActionOrderResponseDto {
  orderId: number;
  plannedCompletionDate?: DateOnlyString | null;
  orderStatusId?: number;
  version: number;
}

export interface ProductionActionEventResponseDto {
  productionEventId?: number;
  productionStatusId: number;
  active: boolean;
}

export interface ProductionActionResponseDto {
  order: ProductionActionOrderResponseDto;
  event?: ProductionActionEventResponseDto;
  auditId?: string;
  requestId: string;
}

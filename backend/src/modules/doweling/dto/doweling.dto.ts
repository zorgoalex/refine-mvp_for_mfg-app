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
  idempotencyKey: string;
}

export interface CreateDowelingOrderResponseDto {
  dowelingOrder: { dowelingOrderId: number; dowelingOrderName: string; version: number };
  auditId?: string;
  requestId: string;
}

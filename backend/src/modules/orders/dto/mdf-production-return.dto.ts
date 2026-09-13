import type {
  MdfReturnColumn,
  MdfReturnKind,
  MdfReturnStage,
} from "../domain/mdf-production-return";

export interface MdfReturnRequest {
  targetColumn: MdfReturnColumn;
  productionStatusId?: number;
  /** Readiness projection window only; never restricts correction membership. */
  boardWindow?: { dateFrom: string; dateTo: string };
}
export interface MdfReturnConfirmRequest extends MdfReturnRequest {
  expectedDigest: string;
  idempotencyKey: string;
}
export interface MdfReturnPreview {
  source: { kind: MdfReturnKind; id: string; label: string };
  targetColumn: MdfReturnColumn;
  targetStage: MdfReturnStage;
  stages: MdfReturnStage[];
  digest: string;
  details: {
    detailId: number;
    orderId: number;
    orderName: string;
    detailNumber: number | null;
    quantity: number;
    cardQuantity: number;
    before: string | null;
    after: string;
  }[];
  orders: {
    orderId: number;
    orderName: string;
    before: string | null;
    after: string | null;
  }[];
  cards: {
    kind: MdfReturnKind;
    id: string;
    label: string;
    before: string;
    after: string;
  }[];
  resetsCompletion: boolean;
  warnings: string[];
}
export interface MdfReturnResult {
  preview: MdfReturnPreview;
  auditId: string;
  requestId: string;
}

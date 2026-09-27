/**
 * Frontend mirror of the active MDF correction (§5.5) HTTP contract. Standalone on purpose: the backend type modules
 * import server-only code (NestJS/pg) that the frontend CI job does not install. Keep in sync with
 * backend/src/modules/mdf-board/application/mdf-correction.types.ts and backend/contracts/04-api-contract.openapi.yaml.
 */
import type {
  MdfReturnColumn,
  MdfReturnKind,
  MdfReturnStage,
} from "../../../backend/src/modules/orders/domain/mdf-production-return";

export interface MdfCorrectionSourceRef {
  kind: MdfReturnKind;
  id: string;
}

export interface MdfCorrectionPreviewBody {
  sourceToken: string;
  targetColumn: MdfReturnColumn;
  productionStatusId?: number;
}

export interface MdfCorrectionConfirmBody extends MdfCorrectionPreviewBody {
  expectedDigest: string;
  idempotencyKey: string;
}

export interface MdfCorrectionBlocker {
  code: string;
  sourceId?: string;
  allocationId?: string;
  position?: string;
}

export interface MdfCorrectionPositionResult {
  orderId: number;
  detailId: number;
  quantity: number;
  rawCut: number;
  rawRolled: number;
  cut: number;
  rolled: number;
  creditedCut: number;
  creditedRolled: number;
  remaining: number;
}

export interface MdfCorrectionDetailEffect {
  orderId: number;
  detailId: number;
  cutCoverage: number;
  laminatedCoverage: number;
  independentFloorRank: number | null;
  afterRank: number | null;
  after: MdfCorrectionPositionResult;
  orderName: string;
  detailNumber: number | null;
  beforeStatus: string | null;
  afterStatus: string | null;
  cardQuantity: number;
  statusKept: boolean;
}

export interface MdfCorrectionBathEffect {
  source: MdfCorrectionSourceRef;
  previousRevision: string;
  cancelledLaminationQuantity: number;
  beforeColumn: string | null;
  manualPlacementColumnBefore: string | null;
  manualPlacementColumnAfter: string | null;
  clearsManualPlacementOverride: boolean;
  afterColumn: string | null;
  afterIssues: string[];
}

export interface MdfCorrectionOrderEffect {
  orderId: number;
  orderName: string;
  before: string | null;
  after: string | null;
  beforeStatusId: number | null;
  afterStatusId: number | null;
}

export type MdfCorrectionLineRef =
  | { kind: "existing"; evidenceLineId: string }
  | { kind: "replacement"; sourceKind: string; sourceId: string; lineKey: string };

export interface MdfCorrectionAllocationReplacement {
  oldAllocationId: string;
  evidenceLine: MdfCorrectionLineRef;
  bathRevision: { kind: "existing"; revision: string } | { kind: "replacement"; sourceId: string };
  orderId: number;
  detailId: number;
  quantity: number;
  state: "reserved" | "consumed";
}

export interface MdfCorrectionDeferredJobEffect {
  jobId: string;
  source: { kind: string; id: string };
  status: "pending" | "needs_attention";
  affectedOrderIds: number[];
}

export interface MdfCorrectionPreviewResponse {
  protocol: "mdf-correction-v1";
  status: "ready" | "blocked";
  source: MdfCorrectionSourceRef & { label: string };
  targetColumn: MdfReturnColumn;
  targetStage: MdfReturnStage;
  stages: MdfReturnStage[];
  sourceToken: string;
  headFence: { version: string; correctionEpoch: string };
  digest: string | null;
  affectedOrderIds: number[];
  details: MdfCorrectionDetailEffect[];
  sourceAfter: { afterColumn: string | null; afterIssues: string[] };
  affectedBaths: MdfCorrectionBathEffect[];
  orders: MdfCorrectionOrderEffect[];
  allocationReleases: string[];
  allocationReplacements: MdfCorrectionAllocationReplacement[];
  deferredPriorAutomation: MdfCorrectionDeferredJobEffect[];
  cncFreshnessBaseline: {
    packetId: string;
    sourceVersion: string;
    correctionEpoch: string;
    state: "waiting_pending";
  } | null;
  blockers: MdfCorrectionBlocker[];
  warnings: string[];
}

export interface MdfCorrectionConfirmResponse {
  preview: MdfCorrectionPreviewResponse;
  auditId: string;
  outboxId: string;
  requestId: string;
  jobIds: string[];
}

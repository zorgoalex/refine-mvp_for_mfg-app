import type { CurrentUser } from '../../../permissions/current-user';
import type { MdfReturnColumn, MdfReturnKind, MdfReturnStage } from '../../orders/domain/mdf-production-return';
import type { MdfCorrectionAllocationReplacement, MdfCorrectionBlocker, MdfCorrectionDetail } from '../domain/mdf-correction-plan';
import type { MdfSourceKind } from './mdf-job-runner';

export interface MdfCorrectionSourceRef {
  kind: MdfReturnKind;
  id: string;
}

/** HTTP body shape. Actor identity and permissions are supplied separately by
 * authenticated server context, never copied from the request body. */
export interface MdfCorrectionPreviewBody {
  sourceToken: string;
  targetColumn: MdfReturnColumn;
  productionStatusId?: number;
}

export interface MdfCorrectionConfirmBody extends MdfCorrectionPreviewBody {
  expectedDigest: string;
  idempotencyKey: string;
}

/** Internal adapter commands carry the trusted user object from authentication. */
export interface MdfCorrectionPreviewCommand {
  currentUser: CurrentUser;
  source: MdfCorrectionSourceRef;
  request: MdfCorrectionPreviewBody;
  requestId: string;
}

export interface MdfCorrectionConfirmCommand {
  currentUser: CurrentUser;
  source: MdfCorrectionSourceRef;
  request: MdfCorrectionConfirmBody;
  requestId: string;
}

export interface MdfCorrectionHeadFence {
  version: string;
  correctionEpoch: string;
}

export interface MdfCorrectionBathEffect {
  source: MdfCorrectionSourceRef;
  previousRevision: string;
  cancelledLaminationQuantity: number;
  beforeColumn: string | null;
  manualPlacementColumnBefore: string | null;
  manualPlacementColumnAfter: string | null;
  clearsManualPlacementOverride: boolean;
}

export interface MdfCorrectionDeferredJobEffect {
  jobId: string;
  source: { kind: MdfSourceKind; id: string };
  status: 'pending' | 'needs_attention';
  affectedOrderIds: number[];
}

export interface MdfCncFreshnessBaseline {
  packetId: string;
  /** Decimal-string BIGINT from cnc_telegram_packets.source_version. */
  sourceVersion: string;
  /** The new correction epoch created by this confirmation. */
  correctionEpoch: string;
  state: 'waiting_pending';
}

export interface MdfCorrectionPreviewResponse {
  protocol: 'mdf-correction-v1';
  status: 'ready' | 'blocked';
  source: MdfCorrectionSourceRef & { label: string };
  targetColumn: MdfReturnColumn;
  targetStage: MdfReturnStage;
  stages: MdfReturnStage[];
  sourceToken: string;
  headFence: MdfCorrectionHeadFence;
  digest: string | null;
  affectedOrderIds: number[];
  details: Array<MdfCorrectionDetail & {
    orderName: string;
    detailNumber: number | null;
    beforeStatus: string | null;
    afterStatus: string | null;
  }>;
  affectedBaths: MdfCorrectionBathEffect[];
  allocationReleases: string[];
  allocationReplacements: MdfCorrectionAllocationReplacement[];
  deferredPriorAutomation: MdfCorrectionDeferredJobEffect[];
  cncFreshnessBaseline: MdfCncFreshnessBaseline | null;
  blockers: MdfCorrectionBlocker[];
  warnings: string[];
}

/** This exact response is persisted for actor/key replay; replay adds no fields. */
export interface MdfCorrectionConfirmResponse {
  preview: MdfCorrectionPreviewResponse;
  auditId: string;
  outboxId: string;
  requestId: string;
  jobIds: string[];
}

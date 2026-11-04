import type { CurrentUser } from '../../../permissions/current-user';
import type { CncTelegramWorkerSessionLeaseContext } from './cnc-telegram-worker-session.types';

export type MdfCncObservationMessageRole = 'svg' | 'gcode' | 'image';

/** Server-issued work identity. The worker fetches only these persisted messages. */
export interface MdfCncObservationClaimDto {
  claimId: string;
  claimToken: string;
  claimGeneration: number;
  expiresAt: string;
  packetId: string;
  sourceChatId: string;
  messages: readonly {
    messageId: number;
    role: MdfCncObservationMessageRole;
    sha256: string;
  }[];
  acceptedRevisionKey: string;
  headVersion: string;
  correctionEpoch: string;
  rawSourceVersion: string;
  /** Server observation sequence, independent of raw packet/source version. */
  observationVersion: string;
}

/**
 * The worker reports observations for the exact claim, not desired MDF state.
 * Packet/order/rank/source-version values are intentionally absent; the server
 * validates this exact bounded group and derives the pending/completed result.
 */
export interface MdfCncObservationReport {
  claimId: string;
  claimToken: string;
  claimGeneration: number;
  messages: readonly {
    messageId: number;
    chatId: string;
    role: MdfCncObservationMessageRole;
    sha256: string;
    present: boolean;
    thumbsUp: boolean;
  }[];
}

export type MdfCncObservationFailureReason =
  | 'FETCH_FAILED'
  | 'MESSAGE_MISSING'
  | 'MESSAGE_MEDIA_MISMATCH'
  | 'MESSAGE_GROUP_INCOMPLETE';

export interface MdfCncObservationResult {
  /** Exact terminal replay returns the original stored result unchanged. */
  status: 'recorded' | 'needs_reconciliation';
  observationVersion: string | null;
  fenceState: 'none' | 'waiting_pending' | 'waiting_completion' | 'satisfied';
  jobId: string | null;
}

export interface CncTelegramMdfObservationRepositoryPort {
  claim(input: {
    currentUser: CurrentUser;
    lease: CncTelegramWorkerSessionLeaseContext;
  }): Promise<MdfCncObservationClaimDto | null>;

  complete(input: {
    currentUser: CurrentUser;
    lease: CncTelegramWorkerSessionLeaseContext;
    report: MdfCncObservationReport;
    requestId: string;
  }): Promise<MdfCncObservationResult>;

  fail(input: {
    currentUser: CurrentUser;
    lease: CncTelegramWorkerSessionLeaseContext;
    claimId: string;
    claimToken: string;
    claimGeneration: number;
    reason: MdfCncObservationFailureReason;
    requestId: string;
  }): Promise<void>;
}

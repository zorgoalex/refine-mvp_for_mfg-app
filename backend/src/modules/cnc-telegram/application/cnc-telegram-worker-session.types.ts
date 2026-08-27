import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';

export interface CncTelegramWorkerSessionLeaseDto {
  sourceChatId: string;
  workerInstanceId: string;
  workerImageRevision: string;
  runtimeEvidence?: CncTelegramWorkerRuntimeEvidence;
}

export interface CncTelegramWorkerRuntimeEvidence {
  stackEnv: string;
  workerRole: 'disabled' | 'reader' | 'writer';
  canSendManualSvgUploads: boolean;
  manualSvgSendPollIntervalSeconds: number;
  parserVersion: string;
}

export interface CncTelegramWorkerSessionHeartbeatDto {
  workerInstanceId: string;
}

export interface CncTelegramWorkerSessionLeaseContext {
  sourceChatId: string;
  leaseToken: string;
  leaseGeneration: number;
  workerInstanceId: string;
}

export interface CncTelegramWorkerSessionLeaseResponse {
  sourceChatId: string;
  leaseToken: string;
  leaseGeneration: number;
  workerInstanceId: string;
  workerImageRevision: string;
  runtimeEvidence: CncTelegramWorkerRuntimeEvidence | null;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface CncTelegramWorkerSessionLeaseRepositoryPort {
  claim(input: CncTelegramWorkerSessionLeaseDto): Promise<CncTelegramWorkerSessionLeaseResponse>;
  heartbeat(input: CncTelegramWorkerSessionHeartbeatDto & CncTelegramWorkerSessionLeaseContext): Promise<CncTelegramWorkerSessionLeaseResponse>;
  release(input: CncTelegramWorkerSessionHeartbeatDto & CncTelegramWorkerSessionLeaseContext): Promise<void>;
  assertCurrent(input: CncTelegramWorkerSessionLeaseContext): Promise<void>;
  assertCurrentInTransaction(tx: TransactionClient, input: CncTelegramWorkerSessionLeaseContext): Promise<void>;
}

export interface CncTelegramWorkerSessionLeaseActor {
  currentUser: CurrentUser;
  dto: CncTelegramWorkerSessionLeaseDto;
  context?: CncTelegramWorkerSessionLeaseContext;
}

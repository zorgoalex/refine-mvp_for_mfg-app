import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import type {
  CncTelegramImportCandidateBatchDto,
  CncTelegramImportCandidateDto,
  CncTelegramImportCompleteDto,
  CncTelegramImportFailDto,
  CncTelegramImportItemDto,
  CncTelegramImportMessageDto,
  CncTelegramImportRequestDto,
  CncTelegramImportScanDto,
  CncTelegramImportScanFailureDto,
  CncTelegramImportScanCompleteDto,
} from '../dto/cnc-telegram-import.dto';
import type { CncTelegramWorkerSessionLeaseContext } from './cnc-telegram-worker-session.types';

export interface CncTelegramImportRepositoryPort {
  createScan(input: { currentUser: CurrentUser; sourceChatId: string; dateFrom: string; dateTo: string; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportScanDto>;
  getScan(input: { currentUser: CurrentUser; scanId: string }): Promise<CncTelegramImportScanDto>;
  listCandidates(input: { currentUser: CurrentUser; scanId: string; page: number; pageSize: number }): Promise<{ items: CncTelegramImportCandidateDto[]; total: number }>;
  listMessages(input: { currentUser: CurrentUser; scanId: string; page: number; pageSize: number }): Promise<{ items: CncTelegramImportMessageDto[]; total: number }>;
  prepare(input: { currentUser: CurrentUser; scanId: string; candidateIds: string[]; requestedCutJobIds?: Record<string, number>; replaceDraft?: { importRequestId: string; confirmationId: string }; repeatOfImportRequestId?: string | null; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportRequestDto>;
  confirm(input: { currentUser: CurrentUser; importRequestId: string; confirmationId: string; duplicateAcknowledgements: Array<{ candidateId: string; duplicateAcknowledged: boolean }>; requestId: string }): Promise<CncTelegramImportRequestDto>;
  repeatPrepare(input: { currentUser: CurrentUser; importRequestId: string; candidateIds: string[]; requestedCutJobIds?: Record<string, number>; replaceDraft?: { importRequestId: string; confirmationId: string }; requestId: string; idempotencyKey: string }): Promise<CncTelegramImportRequestDto>;
  getImport(input: { currentUser: CurrentUser; importRequestId: string }): Promise<CncTelegramImportRequestDto>;
  claimScans(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; limit: number }): Promise<CncTelegramImportScanDto[]>;
  writeCandidateBatch(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; batch: CncTelegramImportCandidateBatchDto; requestId: string }): Promise<{ accepted: number }>;
  completeScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; scanTaskLease: CncTelegramImportScanCompleteDto; requestId: string }): Promise<CncTelegramImportScanDto>;
  failScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; failure: CncTelegramImportScanFailureDto; requestId: string }): Promise<CncTelegramImportScanDto>;
  claimImports(input: { currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; limit: number }): Promise<CncTelegramImportItemDto[]>;
  completeImport(input: { currentUser: CurrentUser; importItemId: string; lease: CncTelegramWorkerSessionLeaseContext; completion: CncTelegramImportCompleteDto; requestId: string }): Promise<CncTelegramImportItemDto>;
  failImport(input: { currentUser: CurrentUser; importItemId: string; lease: CncTelegramWorkerSessionLeaseContext; failure: CncTelegramImportFailDto; requestId: string }): Promise<CncTelegramImportItemDto>;
}

export interface CncTelegramImportWorkerFencePort {
  assertCurrentInTransaction(tx: TransactionClient, currentUser: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext): Promise<void>;
}

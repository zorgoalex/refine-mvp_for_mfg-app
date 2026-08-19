import { ApiError } from '../../../common/errors/api-error';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { CncTelegramWorkerSessionLeaseContext } from './cnc-telegram-worker-session.types';
import type { CncTelegramWorkerSessionService } from './cnc-telegram-worker-session.service';
import type { CncTelegramImportRepositoryPort } from './cnc-telegram-import.types';
import type {
  CncTelegramImportCandidateBatchDto,
  CncTelegramImportCompleteDto,
  CncTelegramImportFailDto,
  CncTelegramImportScanFailureDto,
  CncTelegramImportScanCompleteDto,
} from '../dto/cnc-telegram-import.dto';

export class CncTelegramImportService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: CncTelegramImportRepositoryPort,
    private readonly config: ConfigService<BackendEnv, true>,
    private readonly session: CncTelegramWorkerSessionService,
  ) {}

  async createScan(input: { currentUser: CurrentUser; dateFrom: string; dateTo: string; requestId?: string; idempotencyKey: string }) {
    this.requireEnabled(); this.requireUserManage(input.currentUser);
    return this.repository.createScan({ ...input, sourceChatId: this.configuredChat(), requestId: input.requestId ?? 'cnc-telegram-import-scan' });
  }
  async getScan(currentUser: CurrentUser, scanId: string) { this.requireEnabled(); this.requireUserRead(currentUser); return this.repository.getScan({ currentUser, scanId }); }
  async listCandidates(input: { currentUser: CurrentUser; scanId: string; page: number; pageSize: number }) { this.requireEnabled(); this.requireUserRead(input.currentUser); return this.repository.listCandidates(input); }
  async listMessages(input: { currentUser: CurrentUser; scanId: string; page: number; pageSize: number }) { this.requireEnabled(); this.requireUserRead(input.currentUser); return this.repository.listMessages(input); }
  async prepare(input: { currentUser: CurrentUser; scanId: string; candidateIds: string[]; repeatOfImportRequestId?: string | null; requestId?: string; idempotencyKey: string }) {
    this.requireEnabled(); this.requireUserManage(input.currentUser);
    return this.repository.prepare({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-prepare' });
  }
  async confirm(input: { currentUser: CurrentUser; importRequestId: string; confirmationId: string; duplicateAcknowledgements: Array<{ candidateId: string; duplicateAcknowledged: boolean }>; requestId?: string }) {
    this.requireEnabled(); this.requireUserManage(input.currentUser);
    return this.repository.confirm({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-confirm' });
  }
  async repeatPrepare(input: { currentUser: CurrentUser; importRequestId: string; candidateIds: string[]; requestId?: string; idempotencyKey: string }) {
    this.requireEnabled(); this.requireUserManage(input.currentUser);
    return this.repository.repeatPrepare({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-repeat' });
  }
  async getImport(currentUser: CurrentUser, importRequestId: string) { this.requireEnabled(); this.requireUserRead(currentUser); return this.repository.getImport({ currentUser, importRequestId }); }

  async claimScans(currentUser: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext) { this.requireEnabled(); await this.requireWorker(currentUser, lease); return this.repository.claimScans({ currentUser, lease, limit: 1 }); }
  async writeCandidateBatch(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; batch: CncTelegramImportCandidateBatchDto; requestId?: string }) {
    this.requireEnabled(); await this.requireWorker(input.currentUser, input.lease);
    return this.repository.writeCandidateBatch({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-candidates' });
  }
  async completeScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; scanTaskLease: CncTelegramImportScanCompleteDto; requestId?: string }) {
    this.requireEnabled(); await this.requireWorker(input.currentUser, input.lease);
    return this.repository.completeScan({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-scan-complete' });
  }
  async failScan(input: { currentUser: CurrentUser; scanId: string; lease: CncTelegramWorkerSessionLeaseContext; failure: CncTelegramImportScanFailureDto; requestId?: string }) {
    this.requireEnabled(); await this.requireWorker(input.currentUser, input.lease);
    return this.repository.failScan({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-scan-fail' });
  }
  async claimImports(currentUser: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext) { this.requireEnabled(); await this.requireWorker(currentUser, lease); return this.repository.claimImports({ currentUser, lease, limit: 1 }); }
  async completeImport(input: { currentUser: CurrentUser; importItemId: string; lease: CncTelegramWorkerSessionLeaseContext; completion: CncTelegramImportCompleteDto; requestId?: string }) {
    this.requireEnabled(); await this.requireWorker(input.currentUser, input.lease);
    return this.repository.completeImport({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-complete' });
  }
  async failImport(input: { currentUser: CurrentUser; importItemId: string; lease: CncTelegramWorkerSessionLeaseContext; failure: CncTelegramImportFailDto; requestId?: string }) {
    this.requireEnabled(); await this.requireWorker(input.currentUser, input.lease);
    return this.repository.failImport({ ...input, requestId: input.requestId ?? 'cnc-telegram-import-fail' });
  }

  private requireEnabled(): void {
    if (!this.config.get('CNC_TELEGRAM_MANUAL_IMPORT_ENABLED', { infer: true })) throw new ApiError(503, 'CNC_TELEGRAM_MANUAL_IMPORT_DISABLED', 'Explicit Telegram import is disabled');
  }
  private configuredChat(): string {
    const chats = [...new Set((this.config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
    if (chats.length !== 1) throw new ApiError(503, 'CNC_TELEGRAM_CHAT_UNCONFIGURED', 'Explicit Telegram import requires exactly one configured chat');
    return chats[0];
  }
  private requireUserManage(user: CurrentUser): void { if (!this.permissions.canUser(user, 'cut.manage')) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для импорта Telegram', { requiredPermissions: ['cut.manage'] }); }
  private requireUserRead(user: CurrentUser): void { if (!this.permissions.canUser(user, 'cut.view') && !this.permissions.canUser(user, 'cut.manage') && !this.permissions.canUser(user, 'cnc.telegram_import.manage_all')) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра импорта Telegram', { requiredPermissions: ['cut.view'] }); }
  private async requireWorker(user: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext): Promise<void> {
    const username = this.config.get('CNC_TELEGRAM_WORKER_USERNAME', { infer: true });
    const chats = new Set((this.config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? '').split(',').map((v) => v.trim()).filter(Boolean));
    if (!username || chats.size === 0) throw new ApiError(503, 'CNC_TELEGRAM_WORKER_POLICY_UNCONFIGURED', 'Политика Telegram worker не настроена');
    if (!chats.has(lease.sourceChatId)) throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Telegram-чат не разрешён политикой worker');
    if (user.username !== username || !this.permissions.canUser(user, 'cut.manage')) throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для Telegram worker', { requiredPermissions: ['cut.manage'] });
    await this.session.assertCurrent(user, lease);
  }
}

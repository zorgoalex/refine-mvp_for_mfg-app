import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  CncTelegramWorkerSessionLeaseContext,
  CncTelegramWorkerSessionLeaseDto,
  CncTelegramWorkerSessionHeartbeatDto,
  CncTelegramWorkerSessionLeaseRepositoryPort,
  CncTelegramWorkerSessionLeaseResponse,
} from './cnc-telegram-worker-session.types';

export class CncTelegramWorkerSessionService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: CncTelegramWorkerSessionLeaseRepositoryPort,
    private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  async claim(currentUser: CurrentUser, dto: CncTelegramWorkerSessionLeaseDto): Promise<CncTelegramWorkerSessionLeaseResponse> {
    this.assertWorker(currentUser, dto.sourceChatId);
    return this.repository.claim(dto);
  }

  async heartbeat(
    currentUser: CurrentUser,
    dto: CncTelegramWorkerSessionHeartbeatDto,
    context: CncTelegramWorkerSessionLeaseContext,
  ): Promise<CncTelegramWorkerSessionLeaseResponse> {
    const sourceChatId = this.resolveChatId(context.sourceChatId);
    this.assertWorker(currentUser, sourceChatId);
    if (context.workerInstanceId !== dto.workerInstanceId) throw staleLeaseError();
    return this.repository.heartbeat({ ...dto, ...context, sourceChatId });
  }

  async release(
    currentUser: CurrentUser,
    dto: CncTelegramWorkerSessionHeartbeatDto,
    context: CncTelegramWorkerSessionLeaseContext,
  ): Promise<void> {
    const sourceChatId = this.resolveChatId(context.sourceChatId);
    this.assertWorker(currentUser, sourceChatId);
    if (context.workerInstanceId !== dto.workerInstanceId) throw staleLeaseError();
    await this.repository.release({ ...dto, ...context, sourceChatId });
  }

  async assertCurrent(currentUser: CurrentUser, context: CncTelegramWorkerSessionLeaseContext): Promise<void> {
    const sourceChatId = this.resolveChatId(context.sourceChatId);
    this.assertWorker(currentUser, sourceChatId);
    await this.repository.assertCurrent({ ...context, sourceChatId });
  }

  async assertCurrentInTransaction(
    currentUser: CurrentUser,
    context: CncTelegramWorkerSessionLeaseContext,
    tx: TransactionClient,
  ): Promise<void> {
    const sourceChatId = this.resolveChatId(context.sourceChatId);
    this.assertWorker(currentUser, sourceChatId);
    await this.repository.assertCurrentInTransaction(tx, { ...context, sourceChatId });
  }

  resolveChatId(sourceChatId: string): string {
    if (sourceChatId.trim()) return sourceChatId.trim();
    const allowed = this.allowedChats();
    if (allowed.size !== 1) {
      throw new ApiError(422, 'CNC_TELEGRAM_CHAT_REQUIRED', 'Telegram chat id is required when multiple chats are configured');
    }
    return [...allowed][0];
  }

  private assertWorker(currentUser: CurrentUser, sourceChatId: string): void {
    const configuredUsername = this.config.get('CNC_TELEGRAM_WORKER_USERNAME', { infer: true });
    const allowedChats = this.allowedChats();
    if (!configuredUsername || allowedChats.size === 0) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_POLICY_UNCONFIGURED', 'Политика Telegram-воркера не настроена');
    }
    if (!allowedChats.has(sourceChatId)) {
      throw new ApiError(403, 'CNC_TELEGRAM_CHAT_DENIED', 'Telegram-чат не разрешён политикой worker-аудита');
    }
    if (!this.permissions.canUser(currentUser, 'cut.manage') || currentUser.username !== configuredUsername) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для управления Telegram worker session', {
        requiredPermissions: ['cut.manage'],
      });
    }
  }

  private allowedChats(): Set<string> {
    const configured = this.config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? '';
    return new Set(configured.split(',').map((value) => value.trim()).filter(Boolean));
  }
}

function staleLeaseError(): ApiError {
  return new ApiError(409, 'CNC_TELEGRAM_SESSION_LEASE_STALE', 'Telegram worker session lease is stale or expired');
}

import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { PgCncTelegramMediaRepository } from '../adapters/pg-cnc-telegram-media-repository';
import type {
  CncTelegramManualSvgTelegramSendClaimResponseDto,
  CncTelegramManualSvgTelegramSendCompleteDto,
  CncTelegramManualSvgTelegramSendResponseDto,
  CncTelegramMediaRestoreClaimResponseDto,
  CncTelegramMediaRestoreCompleteDto,
  CncTelegramMediaRestoreResponseDto,
  CncTelegramOrderScreenshotsResponseDto,
} from '../dto/cnc-telegram-media.dto';
import { openTelegramMedia, type OpenTelegramMedia } from './telegram-media-reader';
import { openOrCreateTelegramPreview } from './telegram-thumbnail-store';
import type { CncTelegramWorkerSessionLeaseContext } from './cnc-telegram-worker-session.types';
import type { CncTelegramWorkerSessionService } from './cnc-telegram-worker-session.service';

export class CncTelegramMediaService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: PgCncTelegramMediaRepository,
    private readonly config: ConfigService<BackendEnv, true>,
    private readonly session?: CncTelegramWorkerSessionService,
  ) {}

  async listOrderScreenshots(
    currentUser: CurrentUser,
    orderId: number,
  ): Promise<CncTelegramOrderScreenshotsResponseDto> {
    this.assertOrderViewer(currentUser);
    const screenshots = await this.repository.listOrderScreenshots(orderId);
    const manualFiles = await this.repository.listOrderManualSvgFiles(orderId);
    return {
      orderId,
      generatedAt: new Date().toISOString(),
      originalRetentionDays: 30,
      screenshots,
      manualFiles,
    };
  }

  async openPreview(currentUser: CurrentUser, orderId: number, packetId: string): Promise<OpenTelegramMedia> {
    this.assertOrderViewer(currentUser);
    const descriptor = await this.repository.resolveOrderScreenshot(orderId, packetId);
    return openOrCreateTelegramPreview(this.mediaDirectory(), {
      storageKey: descriptor.storageKey,
      contentType: descriptor.contentType,
      sizeBytes: descriptor.sizeBytes,
    });
  }

  async openOriginal(currentUser: CurrentUser, orderId: number, packetId: string): Promise<OpenTelegramMedia> {
    this.assertOrderViewer(currentUser);
    const descriptor = await this.repository.resolveOrderScreenshot(orderId, packetId);
    if (!descriptor.originalAvailable) {
      throw new ApiError(410, 'CNC_TELEGRAM_MEDIA_EXPIRED', 'Срок хранения оригинала истёк', {
        packetId,
        availableUntil: descriptor.availableUntil,
        restoreAvailable: true,
      });
    }
    return openTelegramMedia(this.mediaDirectory(), {
      storageKey: descriptor.storageKey,
      contentType: descriptor.contentType,
      sizeBytes: descriptor.sizeBytes,
    });
  }

  async openManualSvgFile(currentUser: CurrentUser, orderId: number, fileId: string) {
    this.assertOrderViewer(currentUser);
    return this.repository.resolveOrderManualSvgFile(orderId, fileId);
  }

  async requestRestore(input: {
    currentUser: CurrentUser;
    orderId: number;
    packetId: string;
    requestId?: string;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertOrderViewer(input.currentUser);
    return this.repository.requestRestore({
      ...input,
      requestId: input.requestId || 'cnc-telegram-media-restore',
    });
  }

  async claimRestores(currentUser: CurrentUser, lease?: CncTelegramWorkerSessionLeaseContext): Promise<CncTelegramMediaRestoreClaimResponseDto> {
    this.assertWorker(currentUser);
    await this.assertSession(currentUser, lease);
    const sessionLease = this.requireLease(lease);
    return {
      capability: 'cnc_telegram_media_restore_v1',
      tasks: await this.repository.claimRestores([sessionLease.sourceChatId], 5, sessionLease),
    };
  }

  async claimManualSvgTelegramSends(
    currentUser: CurrentUser,
    requestTraceId?: string,
    lease?: CncTelegramWorkerSessionLeaseContext,
  ): Promise<CncTelegramManualSvgTelegramSendClaimResponseDto> {
    this.assertWorker(currentUser);
    await this.assertSession(currentUser, lease);
    const sessionLease = this.requireLease(lease);
    return {
      capability: 'cnc_manual_svg_telegram_send_v1',
      tasks: await this.repository.claimManualSvgTelegramSends({
        currentUser,
        limit: 5,
        requestTraceId: requestTraceId || 'cnc-manual-svg-telegram-send-claim',
        sessionLease,
      }),
    };
  }

  async completeManualSvgTelegramSend(input: {
    currentUser: CurrentUser;
    requestId: string;
    completion: CncTelegramManualSvgTelegramSendCompleteDto;
    requestTraceId?: string;
    lease?: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramManualSvgTelegramSendResponseDto> {
    this.assertWorker(input.currentUser);
    await this.assertSession(input.currentUser, input.lease);
    const sessionLease = this.requireLease(input.lease);
    if (input.completion.sentChatId !== sessionLease.sourceChatId) {
      throw new ApiError(
        409,
        'CNC_TELEGRAM_SEND_DESTINATION_MISMATCH',
        'Telegram worker подтвердил отправку в другой чат',
        { expectedChatId: sessionLease.sourceChatId, actualChatId: input.completion.sentChatId },
      );
    }
    return this.repository.completeManualSvgTelegramSend({
      currentUser: input.currentUser,
      requestId: input.requestId,
      completion: input.completion,
      sessionLease,
      requestTraceId: input.requestTraceId || 'cnc-manual-svg-telegram-send-complete',
    });
  }

  async failManualSvgTelegramSend(input: {
    currentUser: CurrentUser;
    requestId: string;
    error: string;
    itemLeaseToken: string;
    itemLeaseGeneration: number;
    itemLeaseOwner: string;
    requestTraceId?: string;
    lease?: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramManualSvgTelegramSendResponseDto> {
    this.assertWorker(input.currentUser);
    await this.assertSession(input.currentUser, input.lease);
    const sessionLease = this.requireLease(input.lease);
    return this.repository.failManualSvgTelegramSend({
      currentUser: input.currentUser,
      requestId: input.requestId,
      error: input.error,
      leaseToken: input.itemLeaseToken,
      leaseGeneration: input.itemLeaseGeneration,
      leaseOwner: input.itemLeaseOwner,
      sessionLease,
      requestTraceId: input.requestTraceId || 'cnc-manual-svg-telegram-send-fail',
    });
  }

  async completeRestore(input: {
    currentUser: CurrentUser;
    requestId: string;
    media: CncTelegramMediaRestoreCompleteDto;
    requestTraceId?: string;
    lease?: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertWorker(input.currentUser);
    await this.assertSession(input.currentUser, input.lease);
    const sessionLease = this.requireLease(input.lease);
    return this.repository.completeRestore({
      currentUser: input.currentUser,
      requestId: input.requestId,
      media: input.media,
      sessionLease,
      requestTraceId: input.requestTraceId || 'cnc-telegram-media-restore-complete',
    });
  }

  async failRestore(input: {
    currentUser: CurrentUser;
    requestId: string;
    error: string;
    itemLeaseToken: string;
    itemLeaseGeneration: number;
    itemLeaseOwner: string;
    requestTraceId?: string;
    lease?: CncTelegramWorkerSessionLeaseContext;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertWorker(input.currentUser);
    await this.assertSession(input.currentUser, input.lease);
    const sessionLease = this.requireLease(input.lease);
    return this.repository.failRestore({
      currentUser: input.currentUser,
      requestId: input.requestId,
      error: input.error,
      leaseToken: input.itemLeaseToken,
      leaseGeneration: input.itemLeaseGeneration,
      leaseOwner: input.itemLeaseOwner,
      sessionLease,
      requestTraceId: input.requestTraceId || 'cnc-telegram-media-restore-fail',
    });
  }

  private assertOrderViewer(currentUser: CurrentUser): void {
    if (!this.permissions.canUser(currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра скринов заказа', {
        requiredPermissions: ['orders.view'],
      });
    }
  }

  private assertWorker(currentUser: CurrentUser): string[] {
    const configuredUsername = this.config.get('CNC_TELEGRAM_WORKER_USERNAME', { infer: true });
    const allowedChats = (this.config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!configuredUsername || allowedChats.length === 0) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_POLICY_UNCONFIGURED', 'Политика Telegram-воркера не настроена');
    }
    if (!this.permissions.canUser(currentUser, 'cut.manage') || currentUser.username !== configuredUsername) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для восстановления Telegram-медиа', {
        requiredPermissions: ['cut.manage'],
      });
    }
    return [...new Set(allowedChats)];
  }

  private async assertSession(
    currentUser: CurrentUser,
    lease: CncTelegramWorkerSessionLeaseContext | undefined,
  ): Promise<void> {
    if (!this.session) return;
    if (!lease) throw new ApiError(401, 'CNC_TELEGRAM_SESSION_LEASE_REQUIRED', 'Требуется текущая сессия Telegram worker');
    await this.session.assertCurrent(currentUser, lease);
  }

  private requireLease(lease: CncTelegramWorkerSessionLeaseContext | undefined): CncTelegramWorkerSessionLeaseContext {
    if (!lease) {
      throw new ApiError(401, 'CNC_TELEGRAM_SESSION_LEASE_REQUIRED', 'Требуется текущая сессия Telegram worker');
    }
    if (this.session) return { ...lease, sourceChatId: this.session.resolveChatId(lease.sourceChatId) };
    return lease;
  }

  private mediaDirectory(): string {
    return this.config.get('CNC_TELEGRAM_MEDIA_DIR', { infer: true });
  }
}

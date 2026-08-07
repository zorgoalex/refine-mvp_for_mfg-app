import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { PgCncTelegramMediaRepository } from '../adapters/pg-cnc-telegram-media-repository';
import type {
  CncTelegramMediaRestoreClaimResponseDto,
  CncTelegramMediaRestoreCompleteDto,
  CncTelegramMediaRestoreResponseDto,
  CncTelegramOrderScreenshotsResponseDto,
} from '../dto/cnc-telegram-media.dto';
import { openTelegramMedia, type OpenTelegramMedia } from './telegram-media-reader';
import { openOrCreateTelegramPreview } from './telegram-thumbnail-store';

export class CncTelegramMediaService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: PgCncTelegramMediaRepository,
    private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  async listOrderScreenshots(
    currentUser: CurrentUser,
    orderId: number,
  ): Promise<CncTelegramOrderScreenshotsResponseDto> {
    this.assertOrderViewer(currentUser);
    const screenshots = await this.repository.listOrderScreenshots(orderId);
    return {
      orderId,
      generatedAt: new Date().toISOString(),
      originalRetentionDays: 30,
      screenshots,
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

  async claimRestores(currentUser: CurrentUser): Promise<CncTelegramMediaRestoreClaimResponseDto> {
    const allowedChats = this.assertWorker(currentUser);
    return {
      capability: 'cnc_telegram_media_restore_v1',
      tasks: await this.repository.claimRestores(allowedChats, 5),
    };
  }

  async completeRestore(input: {
    currentUser: CurrentUser;
    requestId: string;
    media: CncTelegramMediaRestoreCompleteDto;
    requestTraceId?: string;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertWorker(input.currentUser);
    return this.repository.completeRestore({
      ...input,
      requestTraceId: input.requestTraceId || 'cnc-telegram-media-restore-complete',
    });
  }

  async failRestore(input: {
    currentUser: CurrentUser;
    requestId: string;
    error: string;
    requestTraceId?: string;
  }): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertWorker(input.currentUser);
    return this.repository.failRestore({
      ...input,
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

  private mediaDirectory(): string {
    return this.config.get('CNC_TELEGRAM_MEDIA_DIR', { infer: true });
  }
}

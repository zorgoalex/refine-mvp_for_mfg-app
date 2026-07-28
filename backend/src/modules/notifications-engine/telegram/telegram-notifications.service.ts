import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgTelegramNotificationsRepository } from './pg-telegram-notifications.repository';
import { TelegramBotApiClient } from './telegram-bot-api.client';
import type { TelegramNotificationsRuntimeConfigService } from './telegram-notifications-runtime-config.service';

export interface TelegramChannelStatus {
  available: boolean;
  connected: boolean;
  botUsername?: string;
  displayName?: string;
  linkedAt?: string;
}

interface TelegramUpdate {
  update_id?: number | string;
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: {
      id?: number | string;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
  };
}

export class TelegramNotificationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PgTelegramNotificationsRepository,
    private readonly runtimeConfig: TelegramNotificationsRuntimeConfigService,
    private readonly botApi: TelegramBotApiClient,
  ) {}

  async getStatus(currentUser: CurrentUser): Promise<TelegramChannelStatus> {
    const config = this.runtimeConfig.getConfig();
    if (!config.enabled) return { available: false, connected: false };

    const binding = await this.repository.findBindingByUserId(currentUser.id);
    return {
      available: true,
      connected: Boolean(binding),
      ...(config.botUsername ? { botUsername: config.botUsername } : {}),
      ...(binding?.displayName ? { displayName: binding.displayName } : {}),
      ...(binding?.linkedAt ? { linkedAt: binding.linkedAt } : {}),
    };
  }

  async startLink(
    currentUser: CurrentUser,
    requestId: string,
  ): Promise<{ linkUrl: string; expiresAt: string }> {
    const config = this.requireEnabled();
    const token = randomBytes(24).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + config.linkTtlSeconds * 1000);

    await this.database.transaction(async (tx) => {
      await new PgTelegramNotificationsRepository(tx).createLinkToken({
        userId: currentUser.id,
        tokenHash,
        expiresAt,
      });
      await auditService.record(tx, {
        event: 'notification.telegram_link_started',
        entityType: 'user',
        entityId: currentUser.id,
        actorUserId: currentUser.id,
        actorUsername: currentUser.username,
        actorRole: currentUser.role,
        requestId,
        source: 'api',
        relatedUserId: Number(currentUser.id),
        after: { channel: 'telegram', expiresAt: expiresAt.toISOString() },
      });
    });

    return {
      linkUrl: `https://t.me/${config.botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async unlink(currentUser: CurrentUser, requestId: string): Promise<{ disconnected: boolean }> {
    this.requireEnabled();
    const disconnected = await this.database.transaction(async (tx) => {
      const deleted = await new PgTelegramNotificationsRepository(tx).unlink(currentUser.id);
      if (deleted) {
        await auditService.record(tx, {
          event: 'notification.telegram_unlinked',
          entityType: 'user',
          entityId: currentUser.id,
          actorUserId: currentUser.id,
          actorUsername: currentUser.username,
          actorRole: currentUser.role,
          requestId,
          source: 'api',
          relatedUserId: Number(currentUser.id),
          before: { channel: 'telegram', connected: true },
          after: { channel: 'telegram', connected: false },
        });
      }
      return deleted;
    });
    return { disconnected };
  }

  async handleWebhook(
    suppliedSecret: string | undefined,
    body: unknown,
  ): Promise<{ ok: true }> {
    const config = this.requireEnabled();
    if (!suppliedSecret || !config.webhookSecret || !secureEquals(suppliedSecret, config.webhookSecret)) {
      throw new ApiError(401, 'TELEGRAM_WEBHOOK_UNAUTHORIZED', 'Invalid Telegram webhook secret');
    }

    const update = parseUpdate(body);
    if (!update) return { ok: true };

    const updateId = String(update.update_id);
    const message = update.message;
    const token = parseStartToken(message?.text);
    const chatId = message?.chat?.id;
    const fromId = message?.from?.id;
    if (
      !token ||
      message?.chat?.type !== 'private' ||
      chatId === undefined ||
      fromId === undefined ||
      String(chatId) !== String(fromId)
    ) {
      await this.repository.markWebhookUpdateProcessed(updateId);
      return { ok: true };
    }

    const displayName = telegramDisplayName(message.from);
    const result = await this.database.transaction(async (tx) => {
      const consumed = await new PgTelegramNotificationsRepository(tx).consumeTelegramStart(tx, {
        updateId,
        tokenHash: hashToken(token),
        externalUserId: String(fromId),
        destination: String(chatId),
        displayName,
        metadata: {
          ...(message.from?.username ? { username: message.from.username } : {}),
          ...(message.from?.language_code ? { languageCode: message.from.language_code } : {}),
        },
      });
      if (consumed.kind === 'linked') {
        await auditService.record(tx, {
          event: 'notification.telegram_linked',
          entityType: 'user',
          entityId: consumed.userId,
          actorUserId: consumed.userId,
          requestId: `telegram-update-${updateId}`,
          source: 'telegram_webhook',
          relatedUserId: Number(consumed.userId),
          after: { channel: 'telegram', connected: true },
        });
      }
      return consumed;
    });

    if (result.kind === 'linked') {
      await this.botApi.sendMessage(
        String(chatId),
        'Telegram подключён. Уведомления из приложения будут приходить в этот чат.',
      );
    } else if (result.kind === 'invalid') {
      await this.botApi.sendMessage(
        String(chatId),
        'Ссылка недействительна или истекла. Создайте новую ссылку в личном кабинете.',
      );
    } else if (result.kind === 'conflict') {
      await this.botApi.sendMessage(
        String(chatId),
        'Этот Telegram уже подключён к другому пользователю приложения.',
      );
    }

    return { ok: true };
  }

  private requireEnabled() {
    const config = this.runtimeConfig.getConfig();
    if (
      !config.enabled ||
      !config.botToken ||
      !config.botUsername ||
      !config.webhookSecret
    ) {
      throw new ApiError(
        503,
        'TELEGRAM_NOTIFICATIONS_UNAVAILABLE',
        'Telegram notifications are not configured',
      );
    }
    return {
      ...config,
      botToken: config.botToken,
      botUsername: config.botUsername,
      webhookSecret: config.webhookSecret,
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseUpdate(value: unknown): TelegramUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const update = value as TelegramUpdate;
  if (
    (typeof update.update_id !== 'number' && typeof update.update_id !== 'string') ||
    String(update.update_id).trim() === ''
  ) {
    return null;
  }
  return update;
}

function parseStartToken(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return text.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{20,64})\s*$/)?.[1] ?? null;
}

function telegramDisplayName(
  from: NonNullable<TelegramUpdate['message']>['from'],
): string | null {
  if (!from) return null;
  if (from.username?.trim()) return `@${from.username.trim()}`.slice(0, 255);
  const name = [from.first_name, from.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  return name ? name.slice(0, 255) : null;
}

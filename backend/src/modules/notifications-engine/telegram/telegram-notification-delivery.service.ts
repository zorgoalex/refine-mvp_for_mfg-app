import { Logger, type LoggerService } from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { PgTelegramNotificationsRepository } from './pg-telegram-notifications.repository';
import { formatTelegramNotification, TelegramBotApiClient } from './telegram-bot-api.client';
import type { TelegramNotificationsRuntimeConfigService } from './telegram-notifications-runtime-config.service';

export interface TelegramDeliverySummary {
  claimed: number;
  delivered: number;
  skipped: number;
  failed: number;
  unknown: number;
  rescheduled: number;
  staleMarkedUnknown: number;
  staleRescheduled: number;
  staleFailed: number;
}

export class TelegramNotificationDeliveryService {
  constructor(
    private readonly repository: PgTelegramNotificationsRepository,
    private readonly runtimeConfig: TelegramNotificationsRuntimeConfigService,
    private readonly botApi: TelegramBotApiClient,
    private readonly logger: Pick<LoggerService, 'error'> = new Logger(
      TelegramNotificationDeliveryService.name,
    ),
  ) {}

  async processBatchOnce(): Promise<TelegramDeliverySummary> {
    const config = this.runtimeConfig.getConfig();
    const summary: TelegramDeliverySummary = {
      claimed: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
      unknown: 0,
      rescheduled: 0,
      staleMarkedUnknown: 0,
      staleRescheduled: 0,
      staleFailed: 0,
    };
    if (!config.enabled || !config.botToken) return summary;

    const stale = await this.repository.recoverStaleProcessing(
      new Date(Date.now() - config.relayStaleLockMs),
      config.relayMaxAttempts,
    );
    summary.staleMarkedUnknown = stale.unknown;
    summary.staleRescheduled = stale.rescheduled;
    summary.staleFailed = stale.failed;
    const deliveries = await this.repository.claimPending({
      workerId: config.relayWorkerId,
      batchSize: config.relayBatchSize,
      maxAttempts: config.relayMaxAttempts,
    });
    summary.claimed = deliveries.length;

    for (const delivery of deliveries) {
      let sendStarted = false;
      try {
        const destination = await this.repository.findDestination(delivery.userId);
        if (!destination) {
          await this.repository.markSkipped(
            delivery.deliveryId,
            'TELEGRAM_NOT_CONNECTED',
            'Recipient has not connected Telegram',
          );
          summary.skipped += 1;
          continue;
        }

        sendStarted = await this.repository.markSendStarted(delivery.deliveryId);
        if (!sendStarted) {
          throw new Error('Delivery claim was lost before Telegram send');
        }
        const result = await this.botApi.sendMessage(
          destination,
          formatTelegramNotification(delivery.title, delivery.message),
        );
        if (result.kind === 'delivered') {
          await this.repository.markDelivered(delivery.deliveryId, result.messageId);
          summary.delivered += 1;
        } else if (
          result.kind === 'rate_limited' &&
          delivery.attempts < config.relayMaxAttempts
        ) {
          await this.repository.rescheduleRateLimited(
            delivery.deliveryId,
            new Date(Date.now() + result.retryAfterSeconds * 1000),
            result.code,
            result.message,
          );
          summary.rescheduled += 1;
        } else if (result.kind === 'permanent_failure' || result.kind === 'rate_limited') {
          await this.repository.markFailed(
            delivery.deliveryId,
            result.kind === 'rate_limited' ? 'TELEGRAM_RATE_LIMIT_EXHAUSTED' : result.code,
            result.message,
          );
          summary.failed += 1;
        } else {
          await this.repository.markUnknown(
            delivery.deliveryId,
            result.code,
            result.message,
          );
          summary.unknown += 1;
        }
      } catch (error) {
        if (!sendStarted && delivery.attempts < config.relayMaxAttempts) {
          await this.repository.reschedulePreSendFailure(
            delivery.deliveryId,
            new Date(Date.now() + preSendRetryDelayMs(delivery.attempts)),
            'TELEGRAM_PRE_SEND_INTERNAL_FAILURE',
            'Internal failure before Telegram send; delivery scheduled for retry',
          );
          summary.rescheduled += 1;
        } else if (!sendStarted) {
          await this.repository.markFailed(
            delivery.deliveryId,
            'TELEGRAM_PRE_SEND_RETRY_EXHAUSTED',
            'Internal failure before Telegram send; retry limit exhausted',
          );
          summary.failed += 1;
        } else {
          await this.repository.markUnknown(
            delivery.deliveryId,
            'TELEGRAM_DELIVERY_INTERNAL_UNCERTAIN',
            'Delivery outcome is unknown after an internal failure',
          );
          summary.unknown += 1;
        }
        this.logger.error(
          redactLogFields({
            event: 'telegram_notification_delivery_failed',
            deliveryId: delivery.deliveryId,
            errorMessage: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return summary;
  }
}

function preSendRetryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

import { Logger, type LoggerService, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { TelegramNotificationDeliveryService } from './telegram-notification-delivery.service';
import type { TelegramNotificationsRuntimeConfigService } from './telegram-notifications-runtime-config.service';

export class TelegramNotificationDeliverySchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(
    private readonly delivery: TelegramNotificationDeliveryService,
    private readonly runtimeConfig: TelegramNotificationsRuntimeConfigService,
    private readonly logger: Pick<LoggerService, 'log' | 'error'> = new Logger(
      TelegramNotificationDeliverySchedulerService.name,
    ),
  ) {}

  onModuleInit(): void {
    const config = this.runtimeConfig.getConfig();
    if (
      this.intervalHandle ||
      !config.enabled ||
      config.relayOwner !== 'in_process'
    ) {
      return;
    }
    this.intervalHandle = setInterval(() => void this.runTick(), config.relayPollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  async runTick(): Promise<void> {
    const config = this.runtimeConfig.getConfig();
    if (!config.enabled || config.relayOwner !== 'in_process') return;
    const startedAt = Date.now();
    try {
      const summary = await this.delivery.processBatchOnce();
      this.logger.log(
        redactLogFields({
          event: 'telegram_notification_delivery_batch_finished',
          workerId: config.relayWorkerId,
          ...summary,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      this.logger.error(
        redactLogFields({
          event: 'telegram_notification_delivery_batch_failed',
          workerId: config.relayWorkerId,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

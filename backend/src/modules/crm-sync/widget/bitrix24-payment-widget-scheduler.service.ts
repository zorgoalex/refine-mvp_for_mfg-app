import {
  Logger,
  type LoggerService,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24ManualPaymentCommandService } from './bitrix24-manual-payment-command.service';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

export class Bitrix24PaymentWidgetSchedulerService
implements OnModuleInit, OnModuleDestroy {
  private interval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly commands: Bitrix24ManualPaymentCommandService,
    private readonly repository: Bitrix24PaymentWidgetRepository,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly logger: Pick<LoggerService, 'log' | 'error'> =
      new Logger(Bitrix24PaymentWidgetSchedulerService.name),
  ) {}

  onModuleInit(): void {
    if (this.interval || !this.config.getPaymentWidget().enabled) return;
    this.interval = setInterval(() => void this.tick(), 15_000);
    this.interval.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.commands.recover();
      const sessionsDeleted = await this.repository.cleanupExpiredSessions();
      const escrowDeleted = await this.repository.cleanupExpiredCommandEscrow(
        this.config.getPaymentWidget().commandTokenRetentionDays,
      );
      if (
        summary.recovered || summary.ambiguous || summary.failed ||
        sessionsDeleted || escrowDeleted
      ) {
        this.logger.log(redactLogFields({
          event: 'bitrix24_payment_widget_recovery_finished',
          ...summary,
          sessionsDeleted,
          escrowDeleted,
        }));
      }
    } catch (error) {
      this.logger.error(redactLogFields({
        event: 'bitrix24_payment_widget_recovery_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.running = false;
    }
  }
}

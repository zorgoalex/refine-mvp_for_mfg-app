import {
  Logger,
  type LoggerService,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24OAuthTokenService } from './bitrix24-oauth-token.service';

export class Bitrix24OAuthTokenSchedulerService
implements OnModuleInit, OnModuleDestroy {
  private interval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly tokens: Bitrix24OAuthTokenService,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly logger: Pick<LoggerService, 'log' | 'error'> =
      new Logger(Bitrix24OAuthTokenSchedulerService.name),
  ) {}

  onModuleInit(): void {
    const flags = this.config.getReverseSync();
    if (
      this.interval ||
      !flags.enabled ||
      flags.relayOwner !== 'in_process' ||
      flags.dryRun
    ) {
      return;
    }
    this.interval = setInterval(() => void this.tick(), 60_000);
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
      const summary = await this.tokens.runTick();
      if (summary.refreshed || summary.failed) {
        this.logger.log(redactLogFields({
          event: 'bitrix24_oauth_refresh_finished',
          ...summary,
        }));
      }
    } catch (error) {
      this.logger.error(redactLogFields({
        event: 'bitrix24_oauth_refresh_tick_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.running = false;
    }
  }
}

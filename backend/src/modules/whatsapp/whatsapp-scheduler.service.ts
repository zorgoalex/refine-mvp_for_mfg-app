import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";
import { WhatsAppService } from "./whatsapp.service";

@Injectable()
export class WhatsAppSchedulerService implements OnModuleInit, OnModuleDestroy {
  private relay?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(WhatsAppSchedulerService.name);
  constructor(
    @Inject(WhatsAppRuntimeConfigService)
    private readonly runtime: WhatsAppRuntimeConfigService,
    @Inject(WhatsAppService) private readonly service: WhatsAppService
  ) {}
  onModuleInit() {
    const config = this.runtime.getConfig();
    if (!config.enabled) return;
    if (config.relayOwner === "in_process") {
      this.relay = setInterval(
        () =>
          void this.service
            .processBatch()
            .catch((error) =>
              this.logger.error(
                "WhatsApp relay tick failed",
                error instanceof Error ? error.stack : undefined
              )
            ),
        config.relayPollIntervalMs
      );
      this.relay.unref?.();
    }
    if (config.cleanupOwner === "in_process") {
      void this.service
        .cleanup()
        .catch((error) =>
          this.logger.error(
            "WhatsApp cleanup startup failed",
            error instanceof Error ? error.stack : undefined
          )
        );
      this.cleanupTimer = setInterval(
        () =>
          void this.service
            .cleanup()
            .catch((error) =>
              this.logger.error(
                "WhatsApp cleanup tick failed",
                error instanceof Error ? error.stack : undefined
              )
            ),
        24 * 60 * 60 * 1000
      );
      this.cleanupTimer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.relay) clearInterval(this.relay);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

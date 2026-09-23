import { Module } from "@nestjs/common";
import { InboundSignalsModule } from '../inbound-signals/inbound-signals.module';
import { DatabaseModule } from "../../database/database.module";
import { PermissionsModule } from "../../permissions/permissions.module";
import { WahaClient } from "./waha.client";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppPermissionsGuard } from "./whatsapp-permissions.guard";
import { WhatsAppRepository } from "./whatsapp.repository";
import { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";
import { WhatsAppSchedulerService } from "./whatsapp-scheduler.service";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppTechnicalLogService } from "./whatsapp-technical-log.service";
import { DailyDigestController } from './daily-digest.controller';
import { DailyDigestFileStore } from './daily-digest-file-store';
import { DailyDigestRepository } from './daily-digest.repository';
import { DailyDigestScheduler } from './daily-digest.scheduler';
import { DailyDigestService } from './daily-digest.service';
import { DailyDigestOrderReader } from './daily-digest-order-reader';
import { DailyDigestRenderer } from './daily-digest-renderer';
import { DAILY_DIGEST_ORDER_READER, DAILY_DIGEST_RENDERER } from './daily-digest.types';

@Module({
  imports: [DatabaseModule, PermissionsModule, InboundSignalsModule],
  controllers: [WhatsAppController, DailyDigestController],
  providers: [
    WhatsAppRuntimeConfigService,
    WahaClient,
    WhatsAppRepository,
    WhatsAppService,
    WhatsAppSchedulerService,
    WhatsAppTechnicalLogService,
    WhatsAppPermissionsGuard,
    DailyDigestRepository,
    DailyDigestFileStore,
    DailyDigestService,
    DailyDigestScheduler,
    DailyDigestOrderReader,
    DailyDigestRenderer,
    { provide: DAILY_DIGEST_ORDER_READER, useExisting: DailyDigestOrderReader },
    { provide: DAILY_DIGEST_RENDERER, useExisting: DailyDigestRenderer },
  ],
})
export class WhatsAppModule {}

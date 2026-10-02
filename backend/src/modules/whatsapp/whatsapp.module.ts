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
import { DailyDigestFileStore } from './daily-digest-file-store';
import { DailyDigestRepository } from './daily-digest.repository';
import { DailyDigestOrderReader } from './daily-digest-order-reader';
import { DailyDigestRenderer } from './daily-digest-renderer';
import { DAILY_DIGEST_ORDER_READER, DAILY_DIGEST_RENDERER } from './daily-digest.types';
import { BroadcastController } from './broadcasts/broadcast.controller';
import { BroadcastFileStore } from './broadcasts/broadcast-file-store';
import { BroadcastRepository } from './broadcasts/broadcast.repository';
import { BroadcastScheduler } from './broadcasts/broadcast.scheduler';
import { BroadcastService } from './broadcasts/broadcast.service';
import { BroadcastWorker } from './broadcasts/broadcast-worker.service';
import { MySendsController } from './my-sends/my-sends.controller';
import { MySendsRepository } from './my-sends/my-sends.repository';
import { OrderSendActors } from './order-send/order-send-actors';
import { OrderSendController } from './order-send/order-send.controller';
import { OrderSendFileStore } from './order-send/order-send-file-store';
import { OrderSendRepository } from './order-send/order-send.repository';
import { OrderSendService } from './order-send/order-send.service';
import { OrderSendWorker } from './order-send/order-send-worker.service';

@Module({
  imports: [DatabaseModule, PermissionsModule, InboundSignalsModule],
  controllers: [WhatsAppController, BroadcastController, OrderSendController, MySendsController],
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
    BroadcastRepository,
    BroadcastFileStore,
    BroadcastWorker,
    BroadcastService,
    BroadcastScheduler,
    OrderSendRepository,
    OrderSendFileStore,
    OrderSendActors,
    OrderSendWorker,
    OrderSendService,
    MySendsRepository,
    DailyDigestOrderReader,
    DailyDigestRenderer,
    { provide: DAILY_DIGEST_ORDER_READER, useExisting: DailyDigestOrderReader },
    { provide: DAILY_DIGEST_RENDERER, useExisting: DailyDigestRenderer },
  ],
})
export class WhatsAppModule {}

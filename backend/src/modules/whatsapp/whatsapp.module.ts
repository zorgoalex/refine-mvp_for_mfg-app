import { Module } from "@nestjs/common";
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

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppRuntimeConfigService,
    WahaClient,
    WhatsAppRepository,
    WhatsAppService,
    WhatsAppSchedulerService,
    WhatsAppTechnicalLogService,
    WhatsAppPermissionsGuard,
  ],
})
export class WhatsAppModule {}

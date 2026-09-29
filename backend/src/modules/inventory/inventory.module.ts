import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { InventoryOnecAutosyncService } from './application/inventory-onec-autosync.service';
import { InventoryService } from './application/inventory.service';
import { InventoryController } from './http/inventory.controller';

@Module({
  imports: [DatabaseModule, OnecAgentModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryOnecAutosyncService],
  exports: [InventoryService],
})
export class InventoryModule {}

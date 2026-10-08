import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { OnecDocumentsEvents } from '../onec-sync/application/onec-documents-events';
import { OnecDocumentsReader } from '../onec-sync/application/onec-documents-reader';
import { OnecSyncModule } from '../onec-sync/onec-sync.module';
import { InventoryOnecAutosyncService } from './application/inventory-onec-autosync.service';
import { InventoryOnecProjectionService } from './application/inventory-onec-projection.service';
import { InventoryOnecSnapshotsService } from './application/inventory-onec-snapshots.service';
import { ONEC_STOCK_SNAPSHOTS, UnavailableOnecStockSnapshots, type OnecStockSnapshotsPort } from './application/onec-snapshots.port';
import {
  ONEC_CONSUMPTION_READER, ONEC_DOCUMENTS_SIGNAL, type OnecConsumptionReader, type OnecDocumentsSignal,
} from './application/onec-consumption.port';
import { InventoryService } from './application/inventory.service';
import { InventoryController } from './http/inventory.controller';

@Module({
  imports: [DatabaseModule, OnecAgentModule, OnecSyncModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryOnecAutosyncService,
    InventoryOnecProjectionService,
    InventoryOnecSnapshotsService,
    // Срезы остатков 1С на дату: реализации порта у onec-agent пока нет — «недоступно» (вкладка скрыта, команды 409).
    // Когда OnecAgentModule экспортирует реализацию — заменить фабрику на неё (тип проверяется при сборке).
    { provide: ONEC_STOCK_SNAPSHOTS, useFactory: (): OnecStockSnapshotsPort => new UnavailableOnecStockSnapshots() },
    // Документы расхода 1С — read-порт и сигнал модуля onec-sync (фабрика проверяет совместимость типов при сборке).
    { provide: ONEC_CONSUMPTION_READER, inject: [OnecDocumentsReader], useFactory: (reader: OnecDocumentsReader): OnecConsumptionReader => reader },
    { provide: ONEC_DOCUMENTS_SIGNAL, inject: [OnecDocumentsEvents], useFactory: (events: OnecDocumentsEvents): OnecDocumentsSignal => events },
  ],
  exports: [InventoryService],
})
export class InventoryModule {}

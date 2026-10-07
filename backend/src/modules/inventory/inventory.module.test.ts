import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../database/database.module';
import { OnecAlertsPort } from '../onec-agent/application/onec-alerts-port';
import { OnecEtlEvents } from '../onec-agent/application/onec-etl-events';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { OnecCatalogReader } from '../onec-agent/onec-catalog-reader';
import { InventoryOnecAutosyncService } from './application/inventory-onec-autosync.service';
import { InventoryModule } from './inventory.module';

// InventoryService получает DatabaseService через DI: без импорта DatabaseModule
// backend не стартует (UnknownDependenciesException при запуске на stage).
describe('InventoryModule wiring', () => {
  it('imports DatabaseModule and the 1C port module for InventoryService', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, InventoryModule);
    expect(imports).toContain(DatabaseModule);
    expect(imports).toContain(OnecAgentModule);
  });

  it('provides the 1C warehouse autosync; the 1C module exports only the ports it needs', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InventoryModule)).toContain(InventoryOnecAutosyncService);
    const exported = Reflect.getMetadata(MODULE_METADATA.EXPORTS, OnecAgentModule);
    expect(exported).toEqual(expect.arrayContaining([OnecCatalogReader, OnecEtlEvents, OnecAlertsPort]));
  });
});

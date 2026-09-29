import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../database/database.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { InventoryModule } from './inventory.module';

// InventoryService получает DatabaseService через DI: без импорта DatabaseModule
// backend не стартует (UnknownDependenciesException при запуске на stage).
describe('InventoryModule wiring', () => {
  it('imports DatabaseModule and the 1C port module for InventoryService', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, InventoryModule);
    expect(imports).toContain(DatabaseModule);
    expect(imports).toContain(OnecAgentModule);
  });
});

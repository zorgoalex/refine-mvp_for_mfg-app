import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../database/database.module';
import { InventoryModule } from './inventory.module';

// InventoryService получает DatabaseService через DI: без импорта DatabaseModule
// backend не стартует (UnknownDependenciesException при запуске на stage).
describe('InventoryModule wiring', () => {
  it('imports DatabaseModule for InventoryService', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, InventoryModule)).toContain(DatabaseModule);
  });
});

import { describe, expect, it } from 'vitest';
import type { WarehouseDto } from '../../api/types/inventoryApi.types';
import { warehouseDeactivationBlock, warehousePatch } from './warehouses';

const warehouse: WarehouseDto = {
  warehouseId: 2, name: 'Склад плёнки', isActive: true, workshopId: 3, workshopName: 'Цех 1',
  responsibleEmployeeId: null, responsibleEmployeeName: null, refKey1c: null,
  filmsWithStock: 0, totalQuantity: 0, draftDocuments: 0, version: '2026-09-29 10:00:00.123456',
};

describe('warehouse reference helpers', () => {
  it('explains why a warehouse cannot be deactivated', () => {
    expect(warehouseDeactivationBlock(warehouse)).toBeNull();
    expect(warehouseDeactivationBlock({ ...warehouse, filmsWithStock: 4 })).toContain('остатки (4 плёнок)');
    expect(warehouseDeactivationBlock({ ...warehouse, draftDocuments: 2 })).toContain('черновики (2)');
  });

  it('sends only changed fields with the version, or nothing', () => {
    expect(warehousePatch(warehouse, { name: ' Склад плёнки ', workshopId: 3, responsibleEmployeeId: undefined })).toBeNull();
    expect(warehousePatch(warehouse, { name: 'Склад плёнки 2', workshopId: null, responsibleEmployeeId: 9 })).toEqual({
      version: warehouse.version, name: 'Склад плёнки 2', workshopId: null, responsibleEmployeeId: 9,
    });
  });
});

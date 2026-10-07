import { describe, expect, it } from 'vitest';
import type { WarehouseDto } from '../../api/types/inventoryApi.types';
import { isOnecKey, onecStatusText, onecWarehouseOptions, syncSummary, warehouseDeactivationBlock, warehousePatch } from './warehouses';

const warehouse: WarehouseDto = {
  warehouseId: 2, name: 'Склад плёнки', isActive: true, workshopId: 3, workshopName: 'Цех 1',
  responsibleEmployeeId: null, responsibleEmployeeName: null, refKey1c: null,
  filmsWithStock: 0, totalQuantity: 0, draftDocuments: 0, version: '2026-09-29 10:00:00.123456',
  onecStatus: 'unlinked', onecName: null, onecCode: null,
};
const KEY = '6325798a-6fde-11ee-84da-94de808e1036';

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

describe('warehouse 1C consumption start', () => {
  const supported = { ...warehouse, onecConsumptionSince: null };
  it('sends the start moment only when it changes and only to a backend that knows the field', () => {
    const since = '2026-09-26T05:14:55.000Z';
    expect(warehousePatch(supported, { name: 'Склад плёнки', workshopId: 3, onecConsumptionSince: since })).toEqual({ version: warehouse.version, onecConsumptionSince: since });
    expect(warehousePatch({ ...supported, onecConsumptionSince: '2026-09-26T10:14:55+05:00' }, { name: 'Склад плёнки', workshopId: 3, onecConsumptionSince: since })).toBeNull();
    expect(warehousePatch({ ...supported, onecConsumptionSince: since }, { name: 'Склад плёнки', workshopId: 3, onecConsumptionSince: null })).toEqual({ version: warehouse.version, onecConsumptionSince: null });
    expect(warehousePatch(warehouse, { name: 'Склад плёнки', workshopId: 3, onecConsumptionSince: since })).toBeNull();
  });
});

describe('warehouse 1C link', () => {
  it('requires a GUID key and sends it lower-cased only when it changes', () => {
    expect(isOnecKey(KEY)).toBe(true);
    expect(isOnecKey('НФ-000004')).toBe(false);
    expect(warehousePatch(warehouse, { name: warehouse.name, refKey1c: KEY.toUpperCase(), workshopId: 3 })).toEqual({ version: warehouse.version, refKey1c: KEY });
    expect(warehousePatch({ ...warehouse, refKey1c: KEY }, { name: warehouse.name, refKey1c: KEY, workshopId: 3 })).toBeNull();
  });

  it('offers 1C warehouses, disabling those linked to another ERP warehouse', () => {
    const options = onecWarehouseOptions([
      { refKey: KEY, code: 'НФ-000004', name: 'Цех Фрезеровка', linkedWarehouseId: 2, linkedWarehouseName: 'Склад плёнки' },
      { refKey: 'b', code: null, name: 'Офис', linkedWarehouseId: 7, linkedWarehouseName: 'Офис' },
      { refKey: 'c', code: 'НФ-000006', name: 'Цех Распил', linkedWarehouseId: null, linkedWarehouseName: null },
    ], 2);
    expect(options.map((o) => [o.label, o.disabled])).toEqual([
      ['Цех Фрезеровка (НФ-000004)', false], ['Офис — уже: Офис', true], ['Цех Распил (НФ-000006)', false],
    ]);
  });

  it('describes the link state and the sync result', () => {
    expect(onecStatusText(warehouse)).toEqual({ text: 'Не привязан к 1С', tone: 'error' });
    expect(onecStatusText({ ...warehouse, refKey1c: KEY, onecStatus: 'linked', onecName: 'Цех Фрезеровка', onecCode: 'НФ-000004' }))
      .toEqual({ text: 'Цех Фрезеровка (НФ-000004)', tone: 'ok' });
    expect(onecStatusText({ ...warehouse, refKey1c: KEY, onecStatus: 'missing' }).tone).toBe('warning');
    expect(syncSummary({ created: [warehouse], linked: [], skipped: [{ refKey: 'x', name: 'Офис', reason: 'name_taken' }] }))
      .toBe('Синхронизация с 1С: добавлено 1, привязано 0, пропущено 1 (название занято: Офис)');
  });
});

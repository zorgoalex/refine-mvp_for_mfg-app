import { describe, expect, it } from 'vitest';
import { aggregateSheetReadings, buildOrderSheetStock, sheetUnitKind } from './order-sheet-stock';

const KEY = 'ba1649b1-e9fd-11f0-98ec-18c04dfda411';
const sheet = { sheetMaterialTypeId: 8, name: 'МДФ 16мм', refKey1c: KEY, widthMm: 2800, heightMm: 2070, demandM2: 10 };
const balance = (quantity: number, unitName = 'л.') => new Map([[KEY, { name: 'МДФ 16 мм', unitName, byWarehouse: [
  { warehouseId: 4, name: 'Склад фрезировки', quantity }, { warehouseId: 2, name: 'Склад распила основного', quantity: 0 }] }]]);

describe('order sheet stock from 1C', () => {
  it('classifies 1C units: sheets/pieces, square metres, others', () => {
    expect(sheetUnitKind('л.')).toBe('sheets');
    expect(sheetUnitKind('шт')).toBe('sheets');
    expect(sheetUnitKind('м2')).toBe('m2');
    expect(sheetUnitKind('пог. м')).toBeNull();
    expect(sheetUnitKind(null)).toBeNull();
  });

  it('converts sheets to m² by the ERP sheet size and compares with the order demand', () => {
    const [item] = buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, balances: balance(2) });
    expect(item).toMatchObject({ quantity: 2, quantityM2: 11.59, status: 'enough', onecName: 'МДФ 16 мм', unitName: 'л.' });
    expect(item.warehouses).toEqual([{ warehouseId: 4, name: 'Склад фрезировки', quantity: 2 }]);
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, balances: balance(1) })[0]).toMatchObject({ quantityM2: 5.8, status: 'short' });
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, balances: balance(12, 'м2') })[0]).toMatchObject({ quantityM2: 12, status: 'enough' });
  });

  it('negative or zero 1C balance is «none»; unknown demand, unit, link and unavailable 1C have their own status', () => {
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, balances: balance(-231.8) })[0]).toMatchObject({ quantity: -231.8, status: 'none' });
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, balances: new Map() })[0]).toMatchObject({ quantity: 0, status: 'none' });
    expect(buildOrderSheetStock({ sheets: [{ ...sheet, demandM2: null }], onecAvailable: true, balances: balance(2) })[0].status).toBe('unknown_demand');
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, balances: balance(2, 'пог. м') })[0]).toMatchObject({ quantityM2: null, status: 'unknown_unit' });
    expect(buildOrderSheetStock({ sheets: [{ ...sheet, refKey1c: null }], onecAvailable: true, balances: balance(2) })[0].status).toBe('unlinked');
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: false, balances: balance(2) })[0].status).toBe('unavailable');
  });

  it('an unread warehouse makes the total unknown: partial quantity, coverage «incomplete», the warehouse is reported', () => {
    const row = { itemRefKey: KEY, name: 'МДФ 16 мм', unitName: 'л.', quantity: 0 };
    const readings = [
      { warehouseId: 2, name: 'Склад распила основного', reason: null, snapshotVersion: '2026-10-03T06:00:00.000Z', rows: [] },
      { warehouseId: 4, name: 'Склад фрезировки', reason: 'not_loaded' as const, snapshotVersion: null, rows: [] },
      { warehouseId: 9, name: 'Нет в 1С', reason: 'warehouse_not_in_onec' as const, snapshotVersion: null, rows: [] },
    ];
    const partial = aggregateSheetReadings(readings, new Set([KEY]));
    // Склад, которого нет в зеркале 1С, — тоже неполнота: отсутствие записи не доказывает нулевой остаток.
    expect(partial).toMatchObject({ available: true, snapshotVersion: '2026-10-03T06:00:00.000Z', incomplete: [
      { warehouseId: 4, name: 'Склад фрезировки', reason: 'not_loaded' }, { warehouseId: 9, name: 'Нет в 1С', reason: 'warehouse_not_in_onec' },
    ] });
    const [item] = buildOrderSheetStock({ sheets: [sheet], onecAvailable: partial.available, incomplete: partial.incomplete.length > 0, balances: partial.balances });
    expect(item).toMatchObject({ quantity: 0, status: 'incomplete' });
    // Все склады прочитаны: тот же ноль — уже окончательное «нет на складе».
    const full = aggregateSheetReadings([{ ...readings[0] }, { ...readings[1], reason: null, rows: [{ ...row, quantity: 3 }] }], new Set([KEY]));
    expect(aggregateSheetReadings([readings[0], readings[2]], new Set([KEY])).incomplete).toHaveLength(1);
    expect(full.incomplete).toEqual([]);
    expect(buildOrderSheetStock({ sheets: [sheet], onecAvailable: true, incomplete: false, balances: full.balances })[0]).toMatchObject({ quantity: 3, status: 'enough' });
    // Ни один склад не прочитан — «нет данных 1С».
    expect(aggregateSheetReadings([readings[1]], new Set([KEY])).available).toBe(false);
  });
});

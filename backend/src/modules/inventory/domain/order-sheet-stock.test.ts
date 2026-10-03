import { describe, expect, it } from 'vitest';
import { buildOrderSheetStock, sheetUnitKind } from './order-sheet-stock';

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
});

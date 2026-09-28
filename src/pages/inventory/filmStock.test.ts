import { describe, expect, it } from 'vitest';
import { filmStockAvailability, filmStockBadge, inventoryQueryString, parseStockCsv, parseStockRows, selectDefaultStockSheet } from './filmStock';

describe('film stock frontend helpers', () => {
  it('parses rows by headers, skips totals and preserves missing quantity', () => {
    const parsed = parseStockRows([
      ['Примечание', ''],
      ['Пленка', 'Поставщик'],
      ['Название X,Y', 'Поставщик 1'],
      ['Итого', ''],
      ['', ''],
    ], 'Исходные данные');
    expect(parsed.rows).toEqual([{ rowNo: 3, name: 'Название X,Y', supplier: 'Поставщик 1', quantity: null }]);
  });

  it('recognizes quantity aliases embedded in header labels', () => {
    const parsed = parseStockRows([
      ['Плёнка', 'Поставщик', 'Количество, пог. м'],
      ['Декор X', 'Vendor', '12,5'],
    ]);
    expect(parsed.rows[0]).toMatchObject({ name: 'Декор X', supplier: 'Vendor', quantity: '12,5' });
  });

  it('selects sheet with required columns before first summary sheet', () => {
    const sheets = [
      { name: 'Свод', hasName: false, hasSupplier: false, rows: [] },
      { name: 'Исходные данные', hasName: true, hasSupplier: true, rows: [] },
    ];
    expect(selectDefaultStockSheet(sheets)?.name).toBe('Исходные данные');
  });

  it.each([';', ',', '\t'])('parses CSV with %s separator', (delimiter) => {
    const quantity = delimiter === ',' ? '"12,5"' : '12,5';
    const csv = new TextEncoder().encode(`Плёнка${delimiter}Поставщик${delimiter}Количество\nДекор X${delimiter}Vendor${delimiter}${quantity}`);
    expect(parseStockCsv(csv).rows[0]).toMatchObject({ name: 'Декор X', supplier: 'Vendor', quantity: '12,5' });
  });

  it('decodes Windows-1251 CSV when UTF-8 is invalid', () => {
    const cp1251 = Buffer.from([
      0xcf, 0xeb, 0xe5, 0xed, 0xea, 0xe0, 0x3b, 0xcf, 0xee, 0xf1, 0xf2, 0xe0, 0xe2, 0xf9, 0xe8, 0xea, 0x3b, 0xca, 0xee, 0xeb, 0xe8, 0xf7, 0xe5, 0xf1, 0xf2, 0xe2, 0xee, 0x0a,
      0xc4, 0xe5, 0xea, 0xee, 0xf0, 0x3b, 0xc2, 0xe5, 0xed, 0xe4, 0xee, 0xf0, 0x3b, 0x31, 0x32,
    ]);
    expect(parseStockCsv(cp1251).rows[0]).toMatchObject({ name: 'Декор', supplier: 'Вендор', quantity: '12' });
  });

  it('formats stock and order availability states', () => {
    expect(filmStockBadge(9.4)).toMatchObject({ kind: 'stock', label: 'склад 9,4 м' });
    expect(filmStockBadge(0).label).toBe('нет на складе');
    expect(filmStockBadge(undefined).kind).toBe('none');
    expect(filmStockAvailability('enough')).toBe('Хватает');
    expect(filmStockAvailability('short')).toBe('Не хватает');
    expect(filmStockAvailability('none')).toBe('Нет на складе');
    expect(filmStockAvailability('unknown_demand')).toBe('Потребность не рассчитана');
  });

  it('builds encoded API query strings', () => {
    expect(inventoryQueryString({ search: 'плёнка X', negative: true, offset: 0, status: undefined })).toBe('search=%D0%BF%D0%BB%D1%91%D0%BD%D0%BA%D0%B0%20X&negative=true&offset=0');
  });
});

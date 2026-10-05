import { describe, expect, it } from 'vitest';
import { filmStockAvailability, filmStockBadge, filmStockBadgeFor, inventoryQueryString, parseStockCsv, parseStockRows, selectDefaultStockSheet, lineFilmOptions, lineFilmValue, operationWarehouse, resolveActiveWarehouse } from './filmStock';

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

describe('draft line film picker', () => {
  const line = {
    lineId: 1, lineNo: 3, rawName: 'Айвори нубук', rawSupplier: 'Алер', rawQuantity: '5', filmId: null, filmName: null,
    quantity: 5, matchStatus: 'suggested' as const, quantityStatus: 'ok' as const, issue: null, balanceBefore: null, balanceAfter: null,
    suggestions: [{ filmId: 2593, filmName: 'айвори алер', score: 0.667 }, { filmId: 4897, filmName: 'Айвори софт AL17-Алер', score: 0.5 }],
  };
  const all = [{ value: 2593, label: 'айвори алер' }, { value: 10, label: 'Белый' }, { value: 4897, label: 'Айвори софт AL17-Алер' }];

  it('lists similar films with similarity first, then all other films without duplicates', () => {
    expect(lineFilmOptions(line, all)).toEqual([
      { label: 'Похожие', options: [{ value: 2593, label: 'айвори алер · 67%' }, { value: 4897, label: 'Айвори софт AL17-Алер · 50%' }] },
      { label: 'Все плёнки', options: [{ value: 10, label: 'Белый' }] },
    ]);
  });

  it('shows the best suggestion until the user decides, and the chosen film afterwards', () => {
    expect(lineFilmValue(line)).toBe(2593);
    expect(lineFilmValue({ ...line, filmId: 10 })).toBe(10);
    expect(lineFilmValue({ ...line, suggestions: [] })).toBeUndefined();
    expect(lineFilmOptions({ ...line, suggestions: [] }, all)).toEqual([{ label: 'Все плёнки', options: all }]);
  });
});

describe('stock screen warehouse selection', () => {
  it('defaults to the first active warehouse and keeps a valid explicit choice', () => {
    expect(resolveActiveWarehouse(undefined, false, [2, 5])).toEqual({ activeId: 2, lost: false });
    expect(resolveActiveWarehouse(5, false, [2, 5])).toEqual({ activeId: 5, lost: false });
    expect(resolveActiveWarehouse(5, false, undefined)).toEqual({ activeId: 5, lost: false });
  });

  it('drops a deactivated explicit choice instead of switching to another warehouse', () => {
    expect(resolveActiveWarehouse(5, false, [2])).toEqual({ activeId: undefined, lost: true });
    expect(resolveActiveWarehouse(undefined, true, [2])).toEqual({ activeId: undefined, lost: true });
  });

  it('has no warehouse when none is active', () => {
    expect(resolveActiveWarehouse(undefined, false, [])).toEqual({ activeId: undefined, lost: false });
  });
});

describe('open stock operation keeps its warehouse', () => {
  it('pins the default warehouse: [A, B] → [B] drops the selection instead of switching to B', () => {
    // По умолчанию выбран A; страница закрепляет его в состоянии (selected = A).
    const initial = resolveActiveWarehouse(undefined, false, [2, 5]);
    expect(initial.activeId).toBe(2);
    expect(resolveActiveWarehouse(initial.activeId, false, [5])).toEqual({ activeId: undefined, lost: true });
  });

  it('sends an open operation only to its pinned warehouse while it is active', () => {
    expect(operationWarehouse(2, [2, 5])).toBe(2);
    expect(operationWarehouse(2, [5])).toBeNull();
    expect(operationWarehouse(undefined, [5])).toBeNull();
  });

  it('shows no badge without an answer: missing data is not «нет на складе»', () => {
    const stock = new Map<number, number | null>([[7, 12.5], [8, 0], [9, null]]);
    expect(filmStockBadgeFor(true, stock, 7)).toMatchObject({ kind: 'stock', quantity: 12.5 });
    expect(filmStockBadgeFor(true, stock, 8)).toMatchObject({ kind: 'none', label: 'нет на складе' });
    expect(filmStockBadgeFor(true, stock, 9)).toMatchObject({ kind: 'none' });
    // Loading, a failed request, an unsaved order (query disabled) and a film missing from the answer.
    expect(filmStockBadgeFor(false, stock, 7)).toBeNull();
    expect(filmStockBadgeFor(false, new Map(), 7)).toBeNull();
    expect(filmStockBadgeFor(true, stock, 10)).toBeNull();
    expect(filmStockBadgeFor(true, stock, null)).toBeNull();
  });
});


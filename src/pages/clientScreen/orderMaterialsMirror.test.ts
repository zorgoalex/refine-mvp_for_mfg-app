import { describe, expect, it, vi } from 'vitest';
import { buildOrderMaterialsMirror, type OrderMaterialsMirrorInput } from './orderMaterialsMirror';
import { clearOrderTabMirror, publishOrderTabMirror, readOrderTabMirror, subscribeOrderTabMirror } from './orderTabMirror';

const input = (over: Partial<OrderMaterialsMirrorInput> = {}): OrderMaterialsMirrorInput => ({
  filmRows: [
    { key: 'film:8', filmId: 8, name: 'Белый софт', totalArea: 3.456, detailsCount: 5, bathLinearMeters: 12.34, bathSheets: 2, cutJobIds: [12, 13] },
    { key: 'film:9', filmId: 9, name: 'ID: 9', totalArea: 1, detailsCount: 1, bathLinearMeters: 0, bathSheets: 0, cutJobIds: [] },
  ],
  sheetRows: [{ key: 'sheet:3', sheetMaterialTypeId: 3, name: 'МДФ 16 мм', totalArea: 4.5, detailsCount: 6 }],
  cutJobNameById: new Map([[12, 'Р-12: кухня']]),
  filmStock: new Map([[8, { stockLm: 40.5, coverage: 'Хватает' }]]),
  sheetStock: new Map([[3, { text: '12,000 лист ≈ 69,31 м²', coverage: 'Хватает' }]]),
  ...over,
});

describe('the materials tab as display text', () => {
  it('film rows with their totals, as the tab draws them', () => {
    const { films } = buildOrderMaterialsMirror(input());
    expect(films[0]).toEqual({ key: 'film:8', values: {
      film_name: 'Белый софт', film_area: '3,46', film_details: '5', film_meters: '12,3', film_sheets: '2', film_cut_jobs: 'Р-12: кухня, #13',
      film_stock: '40,50', film_coverage: 'Хватает',
    } });
    // A film the tab could not name («ID: 9») has no name for the customer; no bath usage and no stock answer are empty cells.
    expect(films[1].values).toEqual({ film_name: null, film_area: '1,00', film_details: '1', film_meters: null, film_sheets: null, film_cut_jobs: null,
      film_stock: null, film_coverage: 'Нет данных' });
    expect(films[2]).toEqual({ key: 'total', values: { film_name: 'Итого', film_area: '4,46', film_details: '6', film_meters: '12,3', film_sheets: '2',
      film_cut_jobs: '', film_stock: '', film_coverage: '' } });
    expect(JSON.stringify(films)).not.toContain('ID: 9');
  });

  it('sheet material rows with their totals', () => {
    const { sheets } = buildOrderMaterialsMirror(input());
    expect(sheets).toEqual([
      { key: 'sheet:3', values: { sheet_name: 'МДФ 16 мм', sheet_area: '4,50', sheet_details: '6', sheet_stock: '12,000 лист ≈ 69,31 м²', sheet_coverage: 'Хватает' } },
      { key: 'total', values: { sheet_name: 'Итого', sheet_area: '4,50', sheet_details: '6', sheet_stock: '', sheet_coverage: '' } },
    ]);
  });

  it('a manager who may not see the stock gives no stock columns at all — not in rows, not in totals', () => {
    const { films, sheets } = buildOrderMaterialsMirror(input({ filmStock: null, sheetStock: null }));
    for (const row of films) expect([row.values.film_stock, row.values.film_coverage]).toEqual([undefined, undefined]);
    for (const row of sheets) expect([row.values.sheet_stock, row.values.sheet_coverage]).toEqual([undefined, undefined]);
  });

  it('an order without materials has empty tables and no totals rows', () => {
    expect(buildOrderMaterialsMirror(input({ filmRows: [], sheetRows: [] }))).toEqual({ films: [], sheets: [] });
  });
});

describe('record of what a tab shows', () => {
  it('is kept per order draft and tab, tells the listeners, and is gone when cleared', () => {
    const a = {};
    const b = {};
    const listener = vi.fn();
    const stop = subscribeOrderTabMirror(a, listener);
    expect(readOrderTabMirror(a, 'requirements')).toBeNull();
    publishOrderTabMirror(a, 'requirements', { films: [], sheets: [] });
    publishOrderTabMirror(b, 'requirements', 'other order');
    publishOrderTabMirror(a, 'cut', 'another tab');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readOrderTabMirror(a, 'requirements')).toEqual({ films: [], sheets: [] });
    expect(readOrderTabMirror(b, 'requirements')).toBe('other order');
    clearOrderTabMirror(a, 'requirements');
    expect(readOrderTabMirror(a, 'requirements')).toBeNull();
    expect(readOrderTabMirror(a, 'cut')).toBe('another tab');
    expect(listener).toHaveBeenCalledTimes(3);
    clearOrderTabMirror(a, 'requirements');
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    publishOrderTabMirror(a, 'requirements', 1);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('a failing listener does not reach the tab', () => {
    const owner = {};
    subscribeOrderTabMirror(owner, () => {
      throw new Error('customer screen failed');
    });
    expect(() => publishOrderTabMirror(owner, 'requirements', 1)).not.toThrow();
  });
});

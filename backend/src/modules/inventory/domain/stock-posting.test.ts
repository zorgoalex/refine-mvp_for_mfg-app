import { describe, expect, it } from 'vitest';
import {
  aggregateLines,
  findUnresolvedLines,
  negativeAfter,
  parseNameWithQuantity,
  parseQuantityCell,
  planMovements,
  type StockLineState,
} from './stock-posting';

const line = (over: Partial<StockLineState>): StockLineState => ({
  lineId: 1, lineNo: 1, filmId: 10, quantity: 1.1, matchStatus: 'exact', quantityStatus: 'ok', ...over,
});

describe('findUnresolvedLines', () => {
  it('requires both a confirmed match and a confirmed quantity', () => {
    const lines = [
      line({ lineId: 1, lineNo: 1 }),
      line({ lineId: 2, lineNo: 2, matchStatus: 'suggested' }),
      line({ lineId: 3, lineNo: 3, matchStatus: 'unmatched', filmId: null }),
      line({ lineId: 4, lineNo: 4, matchStatus: 'manual', quantityStatus: 'needs_review' }),
      line({ lineId: 5, lineNo: 5, matchStatus: 'confirmed', quantityStatus: 'missing', quantity: null }),
      line({ lineId: 6, lineNo: 6, matchStatus: 'skipped', filmId: null, quantity: null, quantityStatus: 'missing' }),
      line({ lineId: 7, lineNo: 7, matchStatus: 'alias', quantityStatus: 'confirmed' }),
    ];
    expect(findUnresolvedLines(lines)).toEqual([
      { lineId: 2, lineNo: 2, reason: 'match' },
      { lineId: 3, lineNo: 3, reason: 'match' },
      { lineId: 4, lineNo: 4, reason: 'quantity' },
      { lineId: 5, lineNo: 5, reason: 'quantity' },
    ]);
  });

  it('a manually selected film does not approve a suspicious quantity', () => {
    expect(findUnresolvedLines([line({ matchStatus: 'manual', quantity: 101.1, quantityStatus: 'needs_review' })]))
      .toEqual([{ lineId: 1, lineNo: 1, reason: 'quantity' }]);
  });
});

describe('aggregateLines + planMovements', () => {
  it('sums repeated films exactly (Чага 1,1 + 2,1 + 5,2 = 8,4)', () => {
    const totals = aggregateLines([
      line({ lineId: 1, filmId: 7, quantity: 1.1 }),
      line({ lineId: 2, filmId: 7, quantity: 2.1 }),
      line({ lineId: 3, filmId: 7, quantity: 5.2 }),
      line({ lineId: 4, filmId: 3, quantity: 0.1 }),
      line({ lineId: 5, filmId: 3, quantity: 0.2 }),
    ]);
    expect([...totals.entries()]).toEqual([[3, 30], [7, 840]]);
  });

  it('receipt adds, write-off subtracts, inventory sets the listed films', () => {
    const totals = new Map([[1, 500], [2, 210]]);
    const balances = new Map([[1, 300], [2, 210]]);
    expect(planMovements('receipt', totals, balances)).toEqual([
      { filmId: 1, movementType: 'receipt', deltaCents: 500, beforeCents: 300, afterCents: 800 },
      { filmId: 2, movementType: 'receipt', deltaCents: 210, beforeCents: 210, afterCents: 420 },
    ]);
    expect(planMovements('writeoff', totals, balances)[0]).toMatchObject({ movementType: 'writeoff', deltaCents: -500, afterCents: -200 });
    expect(planMovements('inventory', totals, balances)).toEqual([
      { filmId: 1, movementType: 'inventory_adjustment', deltaCents: 200, beforeCents: 300, afterCents: 500 },
      { filmId: 2, movementType: 'inventory_adjustment', deltaCents: 0, beforeCents: 210, afterCents: 210 },
    ]);
    expect(planMovements('inventory', new Map([[9, 0]]), new Map())).toEqual([
      { filmId: 9, movementType: 'inventory_adjustment', deltaCents: 0, beforeCents: 0, afterCents: 0 },
    ]);
  });

  it('reports films that would go negative', () => {
    const movements = planMovements('writeoff', new Map([[1, 500], [2, 100]]), new Map([[1, 300], [2, 100]]));
    expect(negativeAfter(movements)).toEqual([{ filmId: 1, after: -2 }]);
    expect(negativeAfter(planMovements('inventory', new Map([[1, 0]]), new Map([[1, -50]])))).toEqual([]);
  });
});

describe('parseNameWithQuantity', () => {
  it('parses real stock file cells', () => {
    expect(parseNameWithQuantity('Брауни 2,1')).toEqual({ name: 'Брауни', quantity: 2.1, quantityStatus: 'ok', issue: null });
    expect(parseNameWithQuantity('Милк софт 3,1 ')).toMatchObject({ name: 'Милк софт', quantity: 3.1 });
    expect(parseNameWithQuantity('санд графит CRM1806-1,1')).toMatchObject({ name: 'санд графит CRM1806', quantity: 1.1, quantityStatus: 'ok' });
    expect(parseNameWithQuantity('Санд кварц грей CRM 840-2,1')).toMatchObject({ name: 'Санд кварц грей CRM 840', quantity: 2.1 });
    expect(parseNameWithQuantity('темно синийFRS 828--3,1')).toMatchObject({ name: 'темно синийFRS 828', quantity: 3.1 });
  });

  it('flags missing, integer (article-like) and too large quantities', () => {
    expect(parseNameWithQuantity('Лайт беж ')).toMatchObject({ name: 'Лайт беж', quantity: null, quantityStatus: 'missing' });
    expect(parseNameWithQuantity('Санд кварц грей CRM 840')).toMatchObject({ quantity: 840, quantityStatus: 'needs_review' });
    expect(parseNameWithQuantity('Чага 101,1')).toMatchObject({ quantity: 101.1, quantityStatus: 'needs_review' });
  });
});

describe('parseQuantityCell', () => {
  it('accepts numbers and decimal commas', () => {
    expect(parseQuantityCell(5.2)).toEqual({ quantity: 5.2, quantityStatus: 'ok', issue: null });
    expect(parseQuantityCell('8,4')).toEqual({ quantity: 8.4, quantityStatus: 'ok', issue: null });
    expect(parseQuantityCell('')).toMatchObject({ quantityStatus: 'missing' });
    expect(parseQuantityCell('abc')).toMatchObject({ quantityStatus: 'missing' });
    expect(parseQuantityCell(-1)).toMatchObject({ quantityStatus: 'missing' });
    expect(parseQuantityCell(150)).toMatchObject({ quantityStatus: 'needs_review' });
  });
});

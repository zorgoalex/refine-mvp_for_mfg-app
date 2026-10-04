import { describe, expect, it } from 'vitest';
import type { WorklistSupplierDto } from '../application/procurement-workspace.types';
import {
  assertDraftLimits,
  formatRequestNumber,
  nextStatus,
  normalizePatchLines,
  NO_SUPPLIER_NAME,
  planSupplierRequestDrafts,
  samePatch,
  type CurrentRequestLine,
  type DraftSourceLine,
} from './supplier-requests';

const MEBEL: WorklistSupplierDto = { key: 's:3', name: 'Мебель-Трейд', source: 'material', others: [] };
const AGER: WorklistSupplierDto = { key: 'c:e146027a-0000-0000-0000-000000000000', name: 'AGER-2005 TOO', source: 'first_receipt', others: [] };
const NONE: WorklistSupplierDto = { key: 'none', name: 'Не указан', source: 'none', others: [] };

function source(overrides: Partial<DraftSourceLine> = {}): DraftSourceLine {
  return {
    orderId: 1, resourceKey: 'sheet_material:8', kind: 'sheet_material', refId: 8, name: 'МДФ 16мм',
    demandSource: 'cut', deficit: 10, need: 10, supplier: MEBEL, sheetAreaM2: 5.796, ...overrides,
  };
}

describe('formatRequestNumber (В-5)', () => {
  it('YY-XXXX, больше 9999 — 5 цифр', () => {
    expect(formatRequestNumber(2026, 1)).toBe('26-0001');
    expect(formatRequestNumber(2026, 12)).toBe('26-0012');
    expect(formatRequestNumber(2027, 10000)).toBe('27-10000');
  });
});

describe('planSupplierRequestDrafts', () => {
  it('листы: на заказ — вверх до 0,001 листа, на строку — вверх до целого, разница на склад', () => {
    const { requests } = planSupplierRequestDrafts([source({ deficit: 10 }), source({ orderId: 2, deficit: 3.19 })], 0);
    expect(requests).toHaveLength(1);
    const [line] = requests[0].lines;
    expect(line.unit).toBe('sheet');
    // 10 / 5,796 = 1,7253… → 1,726; 3,19 / 5,796 = 0,5503… → 0,551
    expect(line.orders.map((order) => order.quantity)).toEqual([1726, 551]);
    expect(line.quantity).toBe(3000);
    expect(line.stockQuantity).toBe(3000 - 1726 - 551);
  });

  it('запас на обрезки — только для потребности по площади', () => {
    const { requests } = planSupplierRequestDrafts([
      source({ orderId: 1, demandSource: 'area', deficit: 10, kind: 'film', resourceKey: 'film:5', refId: 5, sheetAreaM2: null }),
      source({ orderId: 2, demandSource: 'cut', deficit: 10, kind: 'film', resourceKey: 'film:5', refId: 5, sheetAreaM2: null }),
    ], 5);
    const [line] = requests[0].lines;
    expect(line.unit).toBe('lm');
    expect(line.orders.map((order) => order.quantity)).toEqual([10500, 10000]);
    expect(line.quantity).toBe(20500);
    expect(line.stockQuantity).toBe(0);
  });

  it('лист без размеров — заявка в м²', () => {
    const [line] = planSupplierRequestDrafts([source({ sheetAreaM2: null, deficit: 2.5 })], 0).requests[0].lines;
    expect(line).toMatchObject({ unit: 'm2', quantity: 2500, stockQuantity: 0 });
  });

  it('по заявке на поставщика, «не указан» — последним; поставщик из справочника — supplierId', () => {
    const { requests } = planSupplierRequestDrafts([
      source({ orderId: 1, supplier: NONE }),
      source({ orderId: 2, supplier: MEBEL }),
      source({ orderId: 3, supplier: AGER }),
    ], 0);
    expect(requests.map((request) => [request.supplierName, request.supplierId])).toEqual([
      // Русская сортировка: кириллица раньше латиницы; «не указан» — всегда последним.
      ['Мебель-Трейд', 3], ['AGER-2005 TOO', null], [NO_SUPPLIER_NAME, null],
    ]);
  });

  it('без дефицита и без данных — пропуск с причиной', () => {
    const { requests, skipped } = planSupplierRequestDrafts([
      source({ orderId: 1, deficit: 0 }),
      source({ orderId: 2, need: null, deficit: null }),
    ], 5);
    expect(requests).toEqual([]);
    expect(skipped).toEqual([
      { orderId: 1, resourceKey: 'sheet_material:8', reason: 'no_deficit' },
      { orderId: 2, resourceKey: 'sheet_material:8', reason: 'no_data' },
    ]);
  });

  it('детерминирован: порядок входа не влияет', () => {
    const input = [source({ orderId: 2 }), source({ orderId: 1, resourceKey: 'film:5', kind: 'film', refId: 5, name: 'Плёнка', sheetAreaM2: null })];
    expect(planSupplierRequestDrafts(input, 5)).toEqual(planSupplierRequestDrafts([...input].reverse(), 5));
  });
});

describe('nextStatus (R1-8)', () => {
  it('разрешённые переходы, повтор — noop', () => {
    expect(nextStatus('draft', 'send')).toBe('sent');
    expect(nextStatus('sent', 'send')).toBe('noop');
    expect(nextStatus('sent', 'close')).toBe('closed');
    expect(nextStatus('draft', 'cancel')).toBe('cancelled');
    expect(nextStatus('sent', 'cancel')).toBe('cancelled');
    expect(nextStatus('cancelled', 'cancel')).toBe('noop');
  });

  it('недопустимые — 409', () => {
    expect(() => nextStatus('cancelled', 'send')).toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_INVALID_TRANSITION' }));
    expect(() => nextStatus('draft', 'close')).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => nextStatus('closed', 'cancel')).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

describe('normalizePatchLines', () => {
  const current: CurrentRequestLine[] = [
    { lineId: 1, quantity: 3000, stockQuantity: 723, unit: 'sheet', orders: [
      { lineOrderId: 11, quantity: 1726, visible: true },
      { lineOrderId: 12, quantity: 551, visible: true },
    ] },
    { lineId: 2, quantity: 20500, stockQuantity: 0, unit: 'lm', orders: [
      { lineOrderId: 21, quantity: 10500, visible: true },
      { lineOrderId: 22, quantity: 10000, visible: false },
    ] },
  ];

  it('пересчитывает «на склад», удаляет пропущенные заказы, сохраняет заказы вне scope', () => {
    const next = normalizePatchLines(current, [
      { lineId: 1, quantity: 4, orders: [{ lineOrderId: 11, quantity: 1.726 }] },
      { lineId: 2, quantity: 25, orders: [{ lineOrderId: 21, quantity: 12 }] },
    ]);
    expect(next).toEqual([
      { lineId: 1, quantity: 4000, stockQuantity: 2274, orders: [{ lineOrderId: 11, quantity: 1726 }] },
      { lineId: 2, quantity: 25000, stockQuantity: 3000, orders: [{ lineOrderId: 21, quantity: 12000 }, { lineOrderId: 22, quantity: 10000 }] },
    ]);
    expect(samePatch(current, next)).toBe(false);
  });

  it('то же содержимое — samePatch', () => {
    const next = normalizePatchLines(current, [
      { lineId: 1, quantity: 3, orders: [{ lineOrderId: 11, quantity: 1.726 }, { lineOrderId: 12, quantity: 0.551 }] },
      { lineId: 2, quantity: 20.5, orders: [{ lineOrderId: 21, quantity: 10.5 }] },
    ]);
    expect(samePatch(current, next)).toBe(true);
  });

  it('ошибки: листы не целые, количество меньше заказов, чужой/повторный заказ, пусто, удаление строки со скрытыми заказами', () => {
    expect(() => normalizePatchLines(current, [{ lineId: 1, quantity: 2.5, orders: [] }])).toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_WHOLE_SHEETS' }));
    expect(() => normalizePatchLines(current, [
      { lineId: 1, quantity: 1, orders: [{ lineOrderId: 11, quantity: 1.726 }] },
      { lineId: 2, quantity: 20.5, orders: [] },
    ])).toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_QUANTITY_BELOW_ORDERS' }));
    expect(() => normalizePatchLines(current, [{ lineId: 2, quantity: 30, orders: [{ lineOrderId: 22, quantity: 1 }] }]))
      .toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_LINE_ORDER_UNKNOWN' }));
    expect(() => normalizePatchLines(current, [{ lineId: 2, quantity: 30, orders: [{ lineOrderId: 11, quantity: 1 }] }]))
      .toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_LINE_ORDER_UNKNOWN' }));
    expect(() => normalizePatchLines(current, [])).toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_EMPTY' }));
    expect(() => normalizePatchLines(current, [{ lineId: 1, quantity: 3, orders: [] }]))
      .toThrow(expect.objectContaining({ code: 'SUPPLIER_REQUEST_LINE_HAS_HIDDEN_ORDERS' }));
  });
});

describe('assertDraftLimits (CR1-3)', () => {
  it('100 материалов одного поставщика — можно, 101 — 422 (правка принимает не больше 100 строк)', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => source({ orderId: 1, resourceKey: `film:${index + 1}`, kind: 'film', refId: index + 1, name: `П${index}`, sheetAreaM2: null }));
    expect(() => assertDraftLimits(planSupplierRequestDrafts(lines(100), 0).requests)).not.toThrow();
    expect(() => assertDraftLimits(planSupplierRequestDrafts(lines(101), 0).requests))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'SUPPLIER_REQUEST_TOO_MANY_LINES' }));
  });
});

import { describe, expect, it } from 'vitest';
import type { OnecDocumentCardDto } from '../../api/types/onecDocumentsApi.types';
import {
  buildAllocatedGroups,
  lineSummaryText,
  matchesReceiptFilter,
  parseReceiptFilter,
  receiptListParams,
  worklistForReceiptParams,
} from './receiptHelpers';

type Line = OnecDocumentCardDto['lines'][number];
const allocation = (orderId: number, quantity: number, extra: Partial<Line['allocations'][number]> = {}): Line['allocations'][number] => ({
  allocationId: orderId * 10 + quantity, orderId, orderName: `A-${orderId}`, resourceKey: 'sheet_material:1', role: 'receipt', quantity,
  amount: null, origin: 'manual', procurementVersion: 1, createdAt: '2026-10-04T00:00:00.000Z', createdByName: null, ...extra,
});
const line = (extra: Partial<Line>): Line => ({
  lineId: 1, lineNo: 1, nomenclatureName: 'МДФ 16 (1С)', quantity: 10, unitName: 'лист', unitCode: 'sheet', price: null, amount: null,
  isDocumentTotal: false, material: { resourceKey: 'sheet_material:1', kind: 'sheet_material', refId: 1, name: 'МДФ 16мм' },
  allocated: 0, remaining: 10, removedInOnec: false, onecConflict: null, allocations: [], hiddenAllocationsCount: 0, ...extra,
});

describe('список приходов (замечание 13)', () => {
  it('фильтр по умолчанию — не распределённые; частично распределённые относятся к ним', () => {
    expect(parseReceiptFilter(null)).toBe('open');
    expect(parseReceiptFilter('full')).toBe('full');
    expect(parseReceiptFilter('x')).toBe('open');
    expect(matchesReceiptFilter('partial', 'open')).toBe(true);
    expect(matchesReceiptFilter('none', 'open')).toBe(true);
    expect(matchesReceiptFilter('full', 'open')).toBe(false);
    expect(matchesReceiptFilter('full', 'full')).toBe(true);
    expect(matchesReceiptFilter('partial', 'all')).toBe(true);
  });

  it('параметры запроса: фильтр и состав строк; для старого backend — прежний запрос', () => {
    expect(receiptListParams('open', 2)).toEqual({ tab: 'receipts', postedOnly: true, page: 2, pageSize: 30, withLines: true, allocation: 'open' });
    expect(receiptListParams('all', 1)).toEqual({ tab: 'receipts', postedOnly: true, page: 1, pageSize: 30, withLines: true });
    expect(receiptListParams('full', 3, true)).toEqual({ tab: 'receipts', postedOnly: true, page: 1, pageSize: 50 });
  });

  it('строка состава: материал и количество с единицей', () => {
    expect(lineSummaryText({ lineNo: 1, name: 'МДФ 16мм', quantity: 12.5, unitName: 'лист' })).toBe('МДФ 16мм — 12,5 лист');
    expect(lineSummaryText({ lineNo: 2, name: 'Плёнка', quantity: 3, unitName: null })).toBe('Плёнка — 3');
  });
});

describe('«Распределено по заказам» (замечание 10)', () => {
  it('по строке: заказы, потребность из рабочего списка, обеспечено из поступления; сумма ≤ количеству документа', () => {
    const groups = buildAllocatedGroups({ lines: [
      line({ allocated: 7, remaining: 3, allocations: [allocation(5, 4), allocation(3, 2), allocation(5, 1)] }),
      line({ lineId: 2, lineNo: 2 }),
      line({ lineId: 3, lineNo: 3, isDocumentTotal: true, allocations: [allocation(9, 1)] }),
    ] }, [{ orderId: 5, resourceKey: 'sheet_material:1', need: 22.5, unit: 'm2', fullNumber: 'МП-1-A-5' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: 'МДФ 16мм', documentQuantity: 10, allocated: 7, remaining: 3, exceeded: false });
    expect(groups[0].rows).toEqual([
      { key: '3|sheet_material:1', orderId: 3, orderName: 'A-3', fullNumber: null, need: null, needUnit: null, quantity: 2 },
      { key: '5|sheet_material:1', orderId: 5, orderName: 'A-5', fullNumber: 'МП-1-A-5', need: 22.5, needUnit: 'm2', quantity: 5 },
    ]);
    expect(groups[0].rows.reduce((sum, row) => sum + row.quantity, 0)).toBeLessThanOrEqual(groups[0].documentQuantity);
  });

  it('превышение количества документа помечается; строка только со скрытыми заказами тоже показана', () => {
    const groups = buildAllocatedGroups({ lines: [
      line({ quantity: 2, allocated: 3, remaining: -1, allocations: [allocation(1, 3)] }),
      line({ lineId: 2, lineNo: 2, allocated: 4, hiddenAllocationsCount: 2 }),
    ] }, []);
    expect(groups[0].exceeded).toBe(true);
    expect(groups[1]).toMatchObject({ allocated: 4, rows: [], hiddenAllocationsCount: 2 });
  });

  it('переход в рабочий список: набор «Всё» и фильтр документа, прочие фильтры списка сброшены, чужие параметры целы', () => {
    const next = worklistForReceiptParams(new URLSearchParams('tab=supply&section=receipt&receipt=7&q=abc&coverage=none&receipts=full'), 7);
    expect(Object.fromEntries(next)).toEqual({ tab: 'supply', receipt: '7', receipts: 'full', preset: 'all', wlDoc: '7' });
  });
});

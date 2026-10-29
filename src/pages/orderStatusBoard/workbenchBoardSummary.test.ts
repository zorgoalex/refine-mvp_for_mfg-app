import { describe, expect, it, vi } from 'vitest';
import type { OrderStatusBoardCard, OrderStatusBoardColumn } from '../../api/types/orderStatusBoardApi.types';

vi.mock('../../ui-variant/UiVariantProvider', () => ({ useOptionalUiVariant: () => null }));

const { boardSummary, columnTotalsLine } = await import('./workbenchBoardSummary');

const card = (over: Partial<OrderStatusBoardCard> = {}): OrderStatusBoardCard => ({
  orderId: 1, orderName: '1', fullNumber: '1', clientId: 1, clientName: null, priority: 0,
  plannedCompletionDate: null, pastPlannedDate: false, orderStatusId: 1, orderStatusName: 'В работе',
  orderStatusIssuedOrLater: false, productionStatusId: null, productionStatusName: null,
  productionStatusFromDetailsEnabled: false, paymentStatusId: null, paymentStatusName: null,
  finalAmount: 100_000, paidAmount: null, debtAmount: null, partsCount: 3, totalArea: 1.25, details: [],
  managerId: null, managerName: null, updatedAt: '', version: 1, canChangeOrderStatus: true,
  canChangeProductionStatus: true, ...over,
});

const column = (name: string, cards: OrderStatusBoardCard[], total = cards.length): OrderStatusBoardColumn => ({
  key: name, status: { id: 1, code: null, name, color: null, sortOrder: 1, isActive: true }, total, cards, nextCursor: null,
});

describe('board summary', () => {
  it('order board: in work before «Готов к выдаче» / «Выдан», overdue, ready for issue', () => {
    const items = boardSummary('order', [
      column('В работе', [card({ pastPlannedDate: true }), card()], 2),
      column('Готов к выдаче', [card()], 1),
      column('Выдан', [card({ orderStatusIssuedOrLater: true, pastPlannedDate: true })], 1),
      column('Пусто', []),
    ]);
    expect(items.map((item) => [item.label, item.value, item.tone])).toEqual([
      ['в работе', '2', undefined],
      ['просрочено', '2', 'danger'],
      ['готовы к выдаче', '1', 'success'],
    ]);
  });

  it('marks overdue as a lower bound while some column is loaded only in part', () => {
    const items = boardSummary('production', [column('Распил', [card({ pastPlannedDate: true })], 30)]);
    expect(items.map((item) => [item.label, item.value])).toEqual([['заказов', '30'], ['просрочено', '≥ 1']]);
  });
});

describe('column totals', () => {
  it('sums area and money of the loaded cards and says when the column is partial', () => {
    const cards = [card({ totalArea: 12.34, finalAmount: 700_000 }), card({ totalArea: 0.1, finalAmount: 600_000 })];
    expect(columnTotalsLine(column('A', cards), true)).toBe('12,4 м² · 1,3 млн ₸');
    expect(columnTotalsLine(column('A', cards, 61), true)).toBe('2 из 61 · 12,4 м² · 1,3 млн ₸');
  });

  it('no money without the right, nothing for an empty column', () => {
    expect(columnTotalsLine(column('A', [card({ finalAmount: 5000 })]), false)).toBe('1,3 м²');
    expect(columnTotalsLine(column('A', [card({ finalAmount: 5000 })]), true)).toBe('1,3 м² · 5 000 ₸');
    expect(columnTotalsLine(column('A', []), true)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { workbenchPaymentRows } from './workbenchOrderMobileModel';

describe('workbench mobile order card — payments section', () => {
  const types = new Map([[1, 'Kaspi'], [2, 'Наличные']]);

  it('lists payments newest first as «date · type», with the amount and the note', () => {
    expect(workbenchPaymentRows([
      { payment_id: 10, payment_date: '2026-09-28', type_paid_id: 1, amount: 70000 },
      { payment_id: 11, payment_date: '2026-09-30', type_paid_id: 2, amount: '30000.5', notes: ' предоплата ' },
    ], types)).toEqual([
      { key: '11', label: '30.09.2026 · Наличные', amount: '30 000,5 ₸', notes: 'предоплата' },
      { key: '10', label: '28.09.2026 · Kaspi', amount: '70 000 ₸', notes: null },
    ]);
  });

  it('falls back to the row type name, survives missing dates and skips deleted rows', () => {
    expect(workbenchPaymentRows([
      { payment_id: 1, type_paid_id: 9, type_paid_name: 'Перевод', amount: 5 },
      { payment_id: 2, payment_date: '2026-10-01', type_paid_id: 1, amount: 1, delete_flag: true },
    ], types)).toEqual([{ key: '1', label: 'без даты · Перевод', amount: '5 ₸', notes: null }]);
    expect(workbenchPaymentRows([], types)).toEqual([]);
  });
});

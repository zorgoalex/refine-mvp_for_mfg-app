import { describe, expect, it } from 'vitest';
import { buildPaymentCardModel } from './paymentCardModel';

describe('buildPaymentCardModel', () => {
  it('maps payment row', () => {
    const m = buildPaymentCardModel(
      { payment_id: 8785, order_id: 11372, type_paid_id: 1, amount: 4501, payment_date: '2026-06-23', notes: '' },
      { orderLabelOf: () => 'E2E codex full coverage', orderDeletedOf: () => true, typeLabelOf: () => 'нал' },
    );
    expect(m.id).toBe(8785);
    expect(m.orderLabel).toBe('E2E codex full coverage');
    expect(m.orderDeleted).toBe(true);
    expect(m.typeLabel).toBe('нал');
    expect(m.amount).toBe('4 501 ₸');
    expect(m.date).toBe('23.06.2026');
  });
});

import { describe, expect, it } from 'vitest';
import { buildOrderCardModel } from './orderCardModel';

const row = {
  order_id: 11372,
  order_name: 'Тест SP3 листовой МДФ18',
  client_name: 'Ризат',
  order_date: '2026-06-21',
  planned_completion_date: '2026-07-05',
  issue_date: null,
  order_status_name: 'Предварительный',
  payment_status_name: 'Не оплачен',
  production_status_name: 'Не назначен',
  final_amount: 391419,
  paid_amount: 0,
  priority: 50,
};

describe('buildOrderCardModel', () => {
  it('maps row to card fields', () => {
    const m = buildOrderCardModel(row);
    expect(m.id).toBe(11372);
    expect(m.title).toBe('Тест SP3 листовой МДФ18');
    expect(m.client).toBe('Ризат');
    expect(m.dates).toBe('21.06.2026 → 05.07.2026');
    expect(m.statusTag).toBe('Предварительный');
    expect(m.amountLine).toBe('391 419 ₸ · оплачено 0 ₸');
    expect(m.priority).toBe(true); // 50 <= 50 → срочный
  });
  it('priority follows ERP urgency semantics (<= 50, but set)', () => {
    expect(buildOrderCardModel({ ...row, priority: 100 }).priority).toBe(false);
    expect(buildOrderCardModel({ ...row, priority: 0 }).priority).toBe(false);
    expect(buildOrderCardModel({ ...row, priority: null }).priority).toBe(false);
    expect(buildOrderCardModel({ ...row, priority: 1 }).priority).toBe(true);
  });
  it('tolerates missing fields', () => {
    const m = buildOrderCardModel({ order_id: 1 });
    expect(m.title).toBe('Заказ 1');
    expect(m.client).toBe('—');
    expect(m.dates).toBe('—');
    expect(m.amountLine).toBe('0 ₸ · оплачено 0 ₸');
    expect(m.priority).toBe(false);
  });
});

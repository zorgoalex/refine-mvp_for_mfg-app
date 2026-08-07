import { describe, expect, it } from 'vitest';
import {
  buildOrderCardModel,
  buildOrderCardStatusColorMap,
  getOrderCardStatusTextColor,
  resolveOrderCardStatusColor,
} from './orderCardModel';

const row = {
  order_id: 11372,
  order_name: 'Тест SP3 листовой МДФ18',
  client_name: 'Ризат',
  order_date: '2026-06-21',
  planned_completion_date: '2026-07-05',
  issue_date: null,
  order_status_name: 'Предварительный',
  payment_status_name: 'Не оплачен',
  order_status_id: 11,
  payment_status_id: 22,
  production_status_id: 33,
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

  it('omits payment status and amounts without the financial layer', () => {
    const model = buildOrderCardModel({
      order_id: 7,
      payment_status_name: 'Оплачен',
      final_amount: 1200,
      paid_amount: 800,
    }, { showFinancials: false });

    expect(model.paymentTag).toBe('');
    expect(model.amountLine).toBe('');
  });

  it('maps every badge to its configured status color by id', () => {
    const model = buildOrderCardModel(row, {
      statusColors: {
        order: new Map([[11, '#0050B3']]),
        payment: new Map([[22, '#FA8C16']]),
        production: new Map([[33, '#722ED1']]),
      },
    });

    expect(model.statusTagColor).toBe('#0050B3');
    expect(model.paymentTagColor).toBe('#FA8C16');
    expect(model.productionTagColor).toBe('#722ED1');
  });

  it('normalizes configured hex, supports legacy preset colors, and falls back safely', () => {
    expect(buildOrderCardStatusColorMap([
      { order_status_id: 1, color: ' #ff5733 ' },
      { order_status_id: 2, color: 'cyan' },
      { order_status_id: 3, color: 'not-a-color' },
    ], 'order_status_id')).toEqual(new Map([
      [1, '#FF5733'],
      [2, '#13C2C2'],
      [3, '#1677FF'],
    ]));
    expect(resolveOrderCardStatusColor(undefined)).toBe('#1677FF');
  });

  it('uses readable foreground text for both light and dark configured colors', () => {
    expect(getOrderCardStatusTextColor('#FAAD14')).toBe('#000000');
    expect(getOrderCardStatusTextColor('#1677FF')).toBe('#000000');
    expect(getOrderCardStatusTextColor('#0050B3')).toBe('#FFFFFF');
  });
});

import { describe, expect, it } from 'vitest';
import { orderQuickViewFacts, quickViewKeyAction } from './WorkbenchOrderQuickView';

const now = new Date(2026, 9, 27, 10, 0, 0);
const row = {
  order_id: 11842,
  order_name: '3087',
  client_name: 'Клиент',
  project_code: 'МП-5166',
  order_date: '2026-10-24',
  planned_completion_date: '2026-10-29',
  final_amount: 102873,
  paid_amount: 50000,
  parts_count: 28,
  total_area: 6.32,
  material_name: 'МДФ 16мм',
  notes: '',
};

describe('order quick view (NewLine)', () => {
  it('lists the facts with money only when allowed', () => {
    const facts = orderQuickViewFacts(row, true, now);
    expect(facts.map((fact) => fact.label)).toEqual(['Клиент', 'Проект', 'Дата заказа', 'Срок', 'Сумма', 'Оплачено', 'Остаток', 'Состав', 'Материал']);
    expect(facts.find((fact) => fact.label === 'Срок')?.value).toBe('29.10.2026 · через 2 дн.');
    expect(facts.find((fact) => fact.label === 'Остаток')?.value).toBe('52 873 ₸');
    expect(facts.find((fact) => fact.label === 'Состав')?.value).toBe('28 дет. · 6,32 м²');
    expect(orderQuickViewFacts(row, false, now).some((fact) => ['Сумма', 'Оплачено', 'Остаток'].includes(fact.label))).toBe(false);
  });

  it('maps the keys and ignores them while typing', () => {
    expect(quickViewKeyAction({ key: 'Enter', ctrlKey: true })).toBe('open');
    expect(quickViewKeyAction({ key: 'Enter' })).toBeNull();
    expect(quickViewKeyAction({ key: 'e' })).toBe('edit');
    expect(quickViewKeyAction({ key: 'у' })).toBe('edit');
    expect(quickViewKeyAction({ key: 'e', targetIsField: true })).toBeNull();
    expect(quickViewKeyAction({ key: 'e', ctrlKey: true })).toBeNull();
  });
});

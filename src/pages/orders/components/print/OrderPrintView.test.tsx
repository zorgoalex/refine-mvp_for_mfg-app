import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrderPrintView } from './OrderPrintView';

type Props = React.ComponentProps<typeof OrderPrintView>;
const order: Props['order'] = {
  order_id: 501, order_name: 'Тест печати', order_date: '2026-09-19',
  total_amount: 12000, final_amount: 10000, paid_amount: 4500,
  parts_count: 2, total_area: 1, notes: null,
};
const detail = {
  detail_id: 1, detail_number: 7, height: 1000, width: 500, quantity: 2,
  area: 1, note: 'Тест примечания', milling_cost_per_sqm: 12000, detail_cost: 12000,
  milling_type: { milling_type_name: 'Тест фрезеровки' },
  edge_type: { edge_type_name: 'Тест кромки' }, film: { film_name: 'Тест плёнки' },
};

describe('order print input contract', () => {
  it('renders stored detail fields and preserves financial totals', () => {
    const html = renderToStaticMarkup(<OrderPrintView order={order} details={[detail]} />);
    expect(html).toContain('<td class="col-num">7</td>');
    expect(html).toContain('<td class="col-height">1000</td>');
    expect(html).toContain('<td class="col-width">500</td>');
    expect(html).toContain('<td class="col-qty">2</td>');
    expect(html).toContain('<td class="col-note">Тест примечания</td>');
    expect(html).toContain('Тест фрезеровки');
    expect(html).toContain('Тест кромки');
    expect(html).toContain('Тест плёнки');
    expect(html.replace(/\s|&nbsp;/g, '')).toContain('10000');
    expect(html.replace(/\s|&nbsp;/g, '')).toContain('5500');
  });

  it('keeps null dimensions and notes blank without inventing values', () => {
    const html = renderToStaticMarkup(<OrderPrintView order={order} details={[{
      ...detail, height: null, width: null, note: null,
    }]} />);
    expect(html).toContain('<td class="col-height"></td>');
    expect(html).toContain('<td class="col-width"></td>');
    expect(html).toContain('<td class="col-note"></td>');
    expect(html).toContain('<td class="col-num">7</td>');
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaymentCardList, type PaymentCardListProps } from './PaymentCardList';

const props: PaymentCardListProps = {
  rows: [{ payment_id: 1, order_id: 7, amount: 100, notes: 'Тест платёж' }],
  lookups: { orderLabelOf: () => 'Тест заказ', typeLabelOf: () => 'Наличные' },
  pagination: false, onPaginationChange: () => {}, onOpen: () => {},
};
describe('PaymentCardList native pagination', () => {
  it.each([['bottomCenter'], ['bottomRight'], ['topLeft'], []] as const)(
    'adapts Table position %j into a visible List pager', (...position) => {
      const html = renderToStaticMarkup(<PaymentCardList {...props} pagination={{
        position: [...position], current: 1, pageSize: 10, total: 30,
      }} />);
      expect(html).toContain('ant-list-pagination');
      expect(html).toContain('ant-pagination-next');
      expect(html).toContain('Тест платёж');
    },
  );
  it('preserves explicitly disabled pagination', () => {
    const html = renderToStaticMarkup(<PaymentCardList {...props} />);
    expect(html).not.toContain('ant-list-pagination');
    expect(html).toContain('Тест платёж');
  });
  it('preserves hideOnSinglePage', () => {
    const html = renderToStaticMarkup(<PaymentCardList {...props} pagination={{
      total: 1, pageSize: 10, hideOnSinglePage: true, showTotal: total => `Тест всего ${total}`,
    }} />);
    expect(html).not.toContain('ant-pagination-next');
  });
});

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PaymentCardList } from '../../src/pages/payments/mobile/PaymentCardList';

function App() {
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [disabled, setDisabled] = useState(false);
  const [calls, setCalls] = useState<number[][]>([]);
  const [opened, setOpened] = useState<number>();
  const rows = Array.from({ length: 31 }, (_, i) => ({
    payment_id: i + 1, order_id: i + 1, amount: 100 + i, notes: `Тест платёж ${i + 1}`,
  }));
  return <div style={{ padding: 8 }}>
    <PaymentCardList rows={rows.slice((current - 1) * pageSize, current * pageSize)}
      pagination={disabled ? false : { position: ['bottomCenter'], current, pageSize, total: rows.length, pageSizeOptions: [10, 20] }}
      lookups={{ orderLabelOf: id => `Тест заказ ${id}`, typeLabelOf: () => 'Наличные' }}
      onPaginationChange={(page, size) => {
        setCalls(value => [...value, [page, size]]);
        setCurrent(size === pageSize ? page : 1);
        setPageSize(size);
      }}
      onOpen={setOpened}
    />
    <output data-testid="calls">{JSON.stringify(calls)}</output>
    <output data-testid="opened">{opened}</output>
    <button onClick={() => setDisabled(value => !value)}>Тест без пагинации</button>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);


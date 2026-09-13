import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import DayColumn from '../../src/pages/calendar/components/DayColumn';
import { type CalendarOrder, ViewMode } from '../../src/pages/calendar/types/calendar';
import '../../src/pages/calendar/styles/calendar.css';

const order: CalendarOrder = {
  order_id: 1, order_name: 'Заказ календаря', order_date: '2026-09-12',
  planned_completion_date: '2026-09-12', version: 1, parts_count: 1,
  total_area: 2, paid_amount: 0, order_status_name: 'Выдан',
};
function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}
function Fixture() {
  const [orders, setOrders] = useState([order]);
  const [changes, setChanges] = useState<Array<[number, boolean]>>([]);
  return <MemoryRouter><DndProvider backend={HTML5Backend}>
    <CurrentPath />
    <output data-testid="checkbox-changes">{JSON.stringify(changes)}</output>
    <button onClick={() => setOrders([order, { ...order, order_id: 2, order_name: 'Невыданный заказ', order_status_name: 'Новый' }])}>Смешанный день</button>
    <button onClick={() => setOrders([])}>Пустой день</button>
    <button onClick={() => setOrders([{ ...order, order_status_name: 'Новый', is_issued: true }])}>Флаг выдачи</button>
    <button onClick={() => setOrders([order])}>Все выданы</button>
    {[ViewMode.STANDARD, ViewMode.COMPACT].map(viewMode => <section key={viewMode} data-testid={viewMode}>
      <DayColumn date={new Date(2026, 8, 12)} orders={orders} columnWidth={320} viewMode={viewMode}
        onCheckboxChange={(selected, checked) => {
          setChanges(previous => [...previous, [selected.order_id, checked]]);
          setOrders(previous => previous.map(item => item.order_id === selected.order_id
            ? { ...item, is_issued: checked, order_status_name: checked ? 'Выдан' : 'Новый' } : item));
        }} />
    </section>)}
  </DndProvider></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

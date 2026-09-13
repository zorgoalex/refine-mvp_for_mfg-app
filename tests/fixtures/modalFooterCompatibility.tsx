import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarMenuSettingsButton } from '../../src/components/SidebarMenuSettingsButton';
import { OrderDetailColumnSettingsButton, type OrderDetailColumnDefinition } from '../../src/pages/orders/components/tables/OrderDetailColumnSettings';
import type { SidebarMenuOrderPreference, OrderDetailColumnPreference } from '../../src/api/types/profileApi.types';

declare global {
  interface Window {
    footerCase: 'sidebar' | 'columns';
    footerCalls: unknown[];
    resolveFooterSave: () => void;
    rejectFooterSave: () => void;
  }
}

const sidebarDefaults: SidebarMenuOrderPreference = {
  top: ['orders', 'clients'], categories: ['work'],
  resources: { work: ['orders_resource', 'clients_resource'] },
};
const definitions: OrderDetailColumnDefinition[] = [
  { key: 'id', label: 'ID', lockVisible: true, lockPosition: 'start' },
  { key: 'name', label: 'Название' },
  { key: 'quantity', label: 'Количество' },
];
const defaultOrder = ['id', 'name', 'quantity'];
window.footerCalls = [];

function deferSave<T>(next: T, persist: (value: T) => void): Promise<void> {
  window.footerCalls.push(structuredClone(next));
  return new Promise((resolve, reject) => {
    window.resolveFooterSave = () => { persist(next); resolve(); };
    window.rejectFooterSave = () => reject(new Error('Тест: отказ сохранения'));
  });
}

function App() {
  const [sidebar, setSidebar] = useState<SidebarMenuOrderPreference>({
    top: ['clients', 'orders'], categories: ['work'],
    resources: { work: ['clients_resource', 'orders_resource'] },
  });
  const [columns, setColumns] = useState<OrderDetailColumnPreference>({
    order: ['id', 'quantity', 'name'], hidden: ['name'],
  });
  return <div style={{ padding: 24 }}>
    {window.footerCase === 'sidebar' ? <SidebarMenuSettingsButton
      topItems={[{ key: 'orders', label: 'Заказы' }, { key: 'clients', label: 'Клиенты' }]}
      categorizedResources={{ work: [
        { name: 'orders_resource', label: 'Заказы раздела', route: '/orders' },
        { name: 'clients_resource', label: 'Клиенты раздела', route: '/clients' },
      ] }}
      categoryLabels={{ work: 'Работа' }}
      defaults={sidebarDefaults} settings={sidebar}
      onChange={next => deferSave(next, setSidebar)}
    /> : <OrderDetailColumnSettingsButton
      tableKey="footer-test" definitions={definitions} defaultOrder={defaultOrder}
      settings={columns} onChange={next => deferSave(next, setColumns)}
    />}
    <output data-testid="persisted">{JSON.stringify(window.footerCase === 'sidebar' ? sidebar : columns)}</output>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);

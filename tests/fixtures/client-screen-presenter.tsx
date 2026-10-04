import type { ClientScreenIdFor, ClientScreenOrderSource } from '../../src/pages/clientScreen/buildClientScreenSnapshot';
import { browserClientScreenEnvironment } from '../../src/pages/clientScreen/clientScreenEnvironment';
import { ClientScreenPresenter } from '../../src/pages/clientScreen/clientScreenPresenter';
import { CLIENT_SCREEN_CODES } from '../../src/pages/clientScreen/clientScreenRegistry';
import type { ClientScreenUi } from '../../src/pages/clientScreen/clientScreenSnapshotSchema';

// Fixture only: a manager window with the real presenter and a made-up order; the browser script drives it.
const policy = { enabled: true, visibleCodes: CLIENT_SCREEN_CODES.filter((code) => code !== 'details.cost' && code !== 'basic.notes') as string[], version: 1 };
const rows = Array.from({ length: 60 }, (_, index) => ({
  key: `detail-${index + 1}`,
  values: {
    n: String(index + 1), name: `Фасад ${index + 1}`, height: '716', width: '396', quantity: String(1 + (index % 4)), area: '1,13 м²',
    material: 'МДФ 16 мм', milling_type: 'Модерн', edge_type: 'R2', film: index % 2 ? 'Белый софт' : 'Графит матовый',
    price_per_sqm: '14 500,00', cost: `SECRET-COST-${index + 1}`, note: '', production_status: 'Новая',
  },
}));
const source: ClientScreenOrderSource = {
  tabs: [{ key: 'basic', label: 'Основная информация' }, { key: 'details', label: 'Детали заказа' }, { key: 'dates', label: 'Даты' },
    { key: 'finance', label: 'Финансы' }, { key: 'services', label: 'Услуги/товары' }],
  summary: { number: '2418', client: 'Садыков Арман', parts: '150', area: '67,80 м²', final: '115 000,00 ₸', debt: '75 000,00 ₸' },
  basic: { client: 'Садыков Арман', order_name: 'Кухня — фасады', order_date: '02.10.2026', order_status: 'В работе', payment_status: 'Частично оплачен',
    production_status: 'Фрезеровка', manager: 'Алия К.', priority: '100', doweling: 'П-17', notes: 'SECRET-NOTE' },
  dates: { planned: '16.10.2026', completion: null, issue: null },
  finance: { total: '120 000,00 ₸', discount: '5 000,00 ₸', surcharge: '0,00 ₸', final: '115 000,00 ₸', paid: '40 000,00 ₸', debt: '75 000,00 ₸' },
  payments: [{ key: 'pay-1', values: { date: '02.10.2026', type: 'Kaspi', amount: '40 000,00 ₸', note: 'предоплата' } }],
  details: { columnOrder: ['n', 'name', 'height', 'width', 'quantity', 'area', 'material', 'milling_type', 'edge_type', 'film', 'price_per_sqm', 'cost', 'note'], rows, grouping: null },
  services: [{ key: 'srv-1', values: { name: 'Доставка', quantity: '1 шт', price: '6 000,00', sum: '6 000,00' } }],
};
const state: { source: ClientScreenOrderSource; ui: (idFor: ClientScreenIdFor) => ClientScreenUi } = {
  source,
  ui: () => ({ tab: 'details', focus: null, editing: null, scroll: null, page: { current: 1, size: 50 } }),
};
const presenter = new ClientScreenPresenter({
  env: browserClientScreenEnvironment(),
  loadPolicy: async () => policy,
  openWindow: () => { (window as unknown as { openRequested: number }).openRequested = ((window as unknown as { openRequested?: number }).openRequested ?? 0) + 1; },
});
Object.assign(window, {
  cs: {
    presenter, policy, state,
    present: () => presenter.present('order-1', { getSource: () => state.source, getUi: (idFor) => state.ui(idFor) }),
    edit: (rowKey: string, name: string, quantity: string) => {
      state.ui = (idFor) => ({
        tab: 'details', focus: { code: 'details.quantity', rowId: idFor('detail', rowKey) },
        editing: { rowId: idFor('detail', rowKey), values: [{ code: 'details.name', value: name }, { code: 'details.quantity', value: quantity }, { code: 'details.cost', value: 'SECRET-EDIT-COST' }] },
        scroll: null, page: { current: 2, size: 50 },
      });
      presenter.notifyUi('order-1');
    },
    tab: (tab: ClientScreenUi['tab']) => {
      state.ui = () => ({ tab, focus: tab === 'basic' ? { code: 'basic.order_date' } : null, editing: null, scroll: null, page: null });
      presenter.notifyUi('order-1');
    },
    view: () => presenter.getView(),
  },
});
document.getElementById('root')!.textContent = 'manager fixture';

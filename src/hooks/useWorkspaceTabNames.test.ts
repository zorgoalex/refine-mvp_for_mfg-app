import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_TAB_GRACE_MS, loadTabName, matchResourceRoute, TabNameQueue } from './useWorkspaceTabNames';

const resources = [
  { name: 'orders_view', show: '/orders/show/:id', edit: '/orders/edit/:id', meta: { idColumnName: 'order_id' } },
  { name: 'clients', show: '/clients/show/:id', edit: '/clients/edit/:id', meta: { idColumnName: 'client_id' } },
  { name: 'milling_types', show: '/milling-types/show/:id', meta: { idColumnName: 'milling_type_id' } },
];

describe('workspace tab names', () => {
  it('finds the resource of a record tab by its show/edit route', () => {
    expect(matchResourceRoute(resources, '/clients/show/2606')).toMatchObject({ resource: { name: 'clients' }, action: 'show', id: '2606' });
    expect(matchResourceRoute(resources, '/milling-types/show/12')).toMatchObject({ resource: { name: 'milling_types' }, id: '12' });
    expect(matchResourceRoute(resources, '/clients')).toBeNull();
    expect(matchResourceRoute(resources, '/clients/show/abc')).toBeNull();
  });

  it('names an order tab by the order number and a client tab by the client name — never by the id', async () => {
    const getOne = vi.fn(async (resource: string) => (resource === 'orders_view'
      ? { order_id: 11842, order_name: '3087' }
      : { client_id: 2606, client_name: 'Ғибрат Шадет' }));
    expect(await loadTabName('/orders/show/11842', resources, getOne)).toBe('3087');
    expect(getOne).toHaveBeenCalledWith('orders_view', '11842', { idColumnName: 'order_id' });
    expect(await loadTabName('/cad/orders/11842', resources, getOne)).toBe('CAD · заказ 3087');
    expect(await loadTabName('/clients/show/2606', resources, getOne)).toBe('Клиенты · Просмотр · Ғибрат Шадет');
    expect(await loadTabName('/clients/edit/2606', resources, getOne)).toBe('Клиенты · Редактирование · Ғибрат Шадет');
  });

  it('names a Базис-раскрой set tab by the set name without doubling «БР»', async () => {
    const { bazisCutSetTabLabel } = await import('../utils/tabLabels');
    expect(bazisCutSetTabLabel('БР-12')).toBe('БР-12');
    expect(bazisCutSetTabLabel(' Кухня Иванова ')).toBe('БР Кухня Иванова');
  });

  it('gives no name (keeps the id-free default) when the record has no name', async () => {
    const getOne = vi.fn(async () => ({ client_id: 2606 }));
    expect(await loadTabName('/clients/show/2606', resources, getOne)).toBeNull();
    expect(await loadTabName('/orders/show/11842', resources, vi.fn(async () => ({ order_id: 11842 })))).toBeNull();
    expect(await loadTabName('/unknown/show/5', resources, getOne)).toBeNull();
  });
});

describe('TabNameQueue', () => {
  const tabs = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `/clients/show/${i + 1}`, label: 'Клиенты · Просмотр' }));

  it('reads at most three tabs at once, each once per session, and drains the rest as reads finish', () => {
    const queue = new TabNameQueue();
    queue.syncSession('1:89');
    const first = queue.plan(tabs(5), '/orders', 0);
    expect(first.load.map((tab) => tab.key)).toEqual(['/clients/show/1', '/clients/show/2', '/clients/show/3']);
    expect(queue.plan(tabs(5), '/orders', 0).load).toEqual([]);
    queue.finish();
    expect(queue.plan(tabs(5), '/orders', 0).load.map((tab) => tab.key)).toEqual(['/clients/show/4']);
    queue.finish(); queue.finish(); queue.finish();
    expect(queue.plan(tabs(5), '/orders', 0).load.map((tab) => tab.key)).toEqual(['/clients/show/5']);
    queue.finish();
    expect(queue.plan(tabs(5), '/orders', 0).load).toEqual([]); // никаких повторов после отказа/пустого имени
  });

  it('a new session starts over and refuses names read in the old one', () => {
    const queue = new TabNameQueue();
    queue.syncSession('1:89');
    const [read] = queue.plan(tabs(1), '/orders', 0).load;
    queue.syncSession('2:158'); // выход и вход другим пользователем
    expect(queue.canApply('1:89', read.label, read.label)).toBe(false);
    expect(queue.plan(tabs(1), '/orders', 0).load).toHaveLength(1);
    expect(queue.canApply('2:158', read.label, read.label)).toBe(true);
    expect(queue.canApply('2:158', read.label, 'Клиенты · Просмотр · Имя со страницы')).toBe(false); // имя страницы главнее
  });

  it('never touches a named tab, whatever its name looks like', () => {
    const queue = new TabNameQueue();
    queue.syncSession('1:89');
    const named = [
      { key: '/clients/show/2606', label: 'Клиенты · Просмотр · #2606' },
      { key: '/bazis-cut/9', label: 'БР #9' },
      { key: '/orders/show/11842', label: '3087' },
    ];
    expect(queue.plan(named, '/orders', 0)).toEqual({ load: [], recheckInMs: null });
  });

  it('leaves the open tab to its page for a while, then names it itself', () => {
    const queue = new TabNameQueue();
    queue.syncSession('1:89');
    const open = [{ key: '/order-resource-requirements/show/42', label: 'Потребности заказов · Просмотр' }];
    const early = queue.plan(open, open[0].key, 1000);
    expect(early.load).toEqual([]);
    expect(early.recheckInMs).toBe(ACTIVE_TAB_GRACE_MS);
    expect(queue.plan(open, open[0].key, 1000 + ACTIVE_TAB_GRACE_MS).load).toHaveLength(1);
  });

  it('names the requirements card by the order number and the 1С document by its number', async () => {
    const { ordersApi } = await import('../api/ordersApi');
    const { onecDocumentsApi } = await import('../api/onecDocumentsApi');
    const demand = vi.spyOn(ordersApi, 'getResourceDemandCard').mockResolvedValue({ data: { orderName: '3087' } } as never);
    const doc = vi.spyOn(onecDocumentsApi, 'getCard').mockResolvedValue({ data: { number: 'ПТ-000123' } } as never);
    const getOne = vi.fn();
    expect(await loadTabName('/order-resource-requirements/show/11842', resources, getOne)).toBe('Потребности заказов · Просмотр · 3087');
    expect(await loadTabName('/procurement/onec-documents/show/42', resources, getOne)).toBe('Документы 1С · Просмотр · ПТ-000123');
    expect(getOne).not.toHaveBeenCalled(); // не через Hasura-getOne, а через их backend-карточки
    demand.mockRestore();
    doc.mockRestore();
  });
});

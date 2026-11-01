import { useEffect, useState } from 'react';
import { Alert, Descriptions, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { clientOrdersApi, type ClientOrder, type ClientOrderSortKey, type ClientOrdersResponse, type ClientTabSort } from '../../api/clientsReadApi';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import {
  clientOrderMoney, clientOrderNumber, clientOrdersProblem, clientOrdersScopeNote, clientOrdersTotals, columnSortOrder, tabSortFromTable,
} from './clientOrdersModel';

const PAGE_SIZE = 20;
const SORT_KEYS: readonly ClientOrderSortKey[] = ['number', 'date', 'status', 'production', 'payment', 'final', 'paid', 'debt'];

type Load =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'ready'; response: ClientOrdersResponse };

/**
 * Вкладка «Заказы» карточки клиента: заказы этого клиента (новые сверху; любая колонка сортируется по клику — на
 * сервере, по всем страницам), с переходом в заказ, и итог по
 * ним (по всем страницам; с документами 1С не складывается — у той вкладки свой итог). Какие заказы видны
 * пользователю (все или только свои) и видны ли деньги, решает backend — здесь только показ.
 */
export function ClientOrdersTab({ clientId }: { clientId: number | null }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<ClientTabSort<ClientOrderSortKey> | null>(null);
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => { setPage(1); setSort(null); }, [clientId]);
  useEffect(() => {
    if (clientId === null) return undefined;
    let cancelled = false;
    setLoad({ status: 'loading' });
    clientOrdersApi.list(clientId, page, PAGE_SIZE, sort ?? undefined)
      .then((response) => { if (!cancelled) setLoad({ status: 'ready', response }); })
      .catch((error: unknown) => { if (!cancelled) setLoad({ status: 'error', text: clientOrdersProblem(error) }); });
    return () => { cancelled = true; };
  }, [clientId, page, sort]);

  if (load.status === 'error') return <Alert type="info" showIcon message={load.text} />;

  const response = load.status === 'ready' ? load.response : null;
  const showMoney = Boolean(response?.summary);
  const scopeNote = response ? clientOrdersScopeNote(response.scope) : null;
  // Every column sorts on the server over all pages; the payment status and money columns exist (and sort) only with the
  // right to see order financials.
  const sortable = (key: ClientOrderSortKey) => ({ key, sorter: true, sortOrder: columnSortOrder(sort, key) });
  const columns = [
    { title: 'Заказ', ...sortable('number'), render: (_: unknown, order: ClientOrder) => (
      <Link to={`/orders/show/${order.orderId}`}>{clientOrderNumber(order)}</Link>
    ) },
    { title: 'Дата', ...sortable('date'), width: 110, render: (_: unknown, order: ClientOrder) => formatDate(order.orderDate) },
    { title: 'Статус', ...sortable('status'), render: (_: unknown, order: ClientOrder) => order.orderStatusName ?? '' },
    { title: 'Производство', ...sortable('production'), render: (_: unknown, order: ClientOrder) => order.productionStatusName ?? '' },
    ...(showMoney ? [
      { title: 'Оплата', ...sortable('payment'), render: (_: unknown, order: ClientOrder) => order.paymentStatusName ?? '' },
      { title: 'Сумма', ...sortable('final'), align: 'right' as const, render: (_: unknown, order: ClientOrder) => clientOrderMoney(order.finalAmount) },
      { title: 'Оплачено', ...sortable('paid'), align: 'right' as const, render: (_: unknown, order: ClientOrder) => clientOrderMoney(order.paidAmount) },
      { title: 'Долг', ...sortable('debt'), align: 'right' as const, render: (_: unknown, order: ClientOrder) => clientOrderMoney(order.debtAmount) },
    ] : []),
  ];

  return (
    <>
      <Typography.Title level={5}>Заказы</Typography.Title>
      {scopeNote && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={scopeNote} />}
      {response && (
        // antd 5.0.5: у Descriptions нет свойства items — только дочерние Descriptions.Item.
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }} style={{ marginBottom: 12 }}>
          {clientOrdersTotals(response).map((item) => (
            <Descriptions.Item key={item.label} label={item.label}>{item.value}</Descriptions.Item>
          ))}
        </Descriptions>
      )}
      <Table
        rowKey="orderId"
        size="small"
        loading={load.status === 'loading'}
        dataSource={response?.data ?? []}
        columns={columns}
        onChange={(_pagination, _filters, sorter, extra) => {
          if (extra.action !== 'sort') return;
          setSort(tabSortFromTable(sorter, SORT_KEYS));
          setPage(1);
        }}
        locale={{ emptyText: 'У клиента пока нет заказов' }}
        pagination={response && response.pagination.total > PAGE_SIZE
          ? { current: page, pageSize: PAGE_SIZE, total: response.pagination.total, showSizeChanger: false, onChange: setPage }
          : false}
      />
    </>
  );
}

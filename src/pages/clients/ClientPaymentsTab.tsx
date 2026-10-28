import { useEffect, useState } from 'react';
import { Alert, Descriptions, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { clientPaymentsApi, type ClientPayment, type ClientPaymentsResponse } from '../../api/clientsReadApi';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import { clientOrderMoney, clientOrderNumber } from './clientOrdersModel';
import { clientPaymentsProblem, clientPaymentsScopeNote, clientPaymentsTotals } from './clientPaymentsModel';

const PAGE_SIZE = 20;

type Load =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'ready'; response: ClientPaymentsResponse };

/**
 * Вкладка «Платежи» карточки клиента: платежи по заказам этого клиента, новые сверху, с переходом в заказ, и их сумма
 * по всем страницам. Какие платежи видны пользователю (по всем заказам или только по своим), решает backend.
 */
export function ClientPaymentsTab({ clientId }: { clientId: number | null }) {
  const [page, setPage] = useState(1);
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => { setPage(1); }, [clientId]);
  useEffect(() => {
    if (clientId === null) return undefined;
    let cancelled = false;
    setLoad({ status: 'loading' });
    clientPaymentsApi.list(clientId, page, PAGE_SIZE)
      .then((response) => { if (!cancelled) setLoad({ status: 'ready', response }); })
      .catch((error: unknown) => { if (!cancelled) setLoad({ status: 'error', text: clientPaymentsProblem(error) }); });
    return () => { cancelled = true; };
  }, [clientId, page]);

  if (load.status === 'error') return <Alert type="info" showIcon message={load.text} />;

  const response = load.status === 'ready' ? load.response : null;
  const scopeNote = response ? clientPaymentsScopeNote(response.scope) : null;
  const columns = [
    { title: 'Дата', key: 'date', width: 110, render: (_: unknown, payment: ClientPayment) => formatDate(payment.paymentDate) },
    { title: 'Сумма', key: 'amount', align: 'right' as const, render: (_: unknown, payment: ClientPayment) => clientOrderMoney(payment.amount) },
    { title: 'Тип оплаты', key: 'type', render: (_: unknown, payment: ClientPayment) => (
      <>{payment.typePaidName ?? ''}{payment.fromOnec && <Tag style={{ marginLeft: 8 }}>из 1С</Tag>}</>
    ) },
    { title: 'Заказ', key: 'order', render: (_: unknown, payment: ClientPayment) => (
      <Link to={`/orders/show/${payment.order.orderId}`}>{clientOrderNumber(payment.order)}</Link>
    ) },
    { title: 'Примечание', key: 'notes', render: (_: unknown, payment: ClientPayment) => payment.notes ?? '' },
  ];

  return (
    <>
      <Typography.Title level={5}>Платежи</Typography.Title>
      {scopeNote && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={scopeNote} />}
      {response && (
        // antd 5.0.5: у Descriptions нет свойства items — только дочерние Descriptions.Item.
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }} style={{ marginBottom: 12 }}>
          {clientPaymentsTotals(response).map((item) => (
            <Descriptions.Item key={item.label} label={item.label}>{item.value}</Descriptions.Item>
          ))}
        </Descriptions>
      )}
      <Table
        rowKey="paymentId"
        size="small"
        loading={load.status === 'loading'}
        dataSource={response?.data ?? []}
        columns={columns}
        locale={{ emptyText: 'У клиента пока нет платежей' }}
        pagination={response && response.pagination.total > PAGE_SIZE
          ? { current: page, pageSize: PAGE_SIZE, total: response.pagination.total, showSizeChanger: false, onChange: setPage }
          : false}
      />
    </>
  );
}

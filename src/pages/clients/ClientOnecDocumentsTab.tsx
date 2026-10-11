import { useEffect, useState } from 'react';
import { Alert, Descriptions, Radio, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';
import {
  partyContactsApi, type ClientOnecDocument, type ClientOnecDocumentGroup, type ClientOnecDocumentsResponse,
} from '../../api/partyContactsApi';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import {
  clientOnecDocumentAmount, clientOnecDocumentKind, clientOnecDocumentsProblem, clientOnecDocumentStateNote, clientOnecGroupOptions,
  clientOnecScopeNote, clientOnecTotals, clientOnecTotalsTitle,
} from './clientOnecDocumentsModel';

const PAGE_SIZE = 20;

type Load =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'ready'; response: ClientOnecDocumentsResponse };

/**
 * Вкладка «Документы 1С» карточки клиента: заказы покупателя, отгрузки, поступления и возвраты денег контрагента
 * 1С, с которым сопоставлен клиент; новые сверху. Итог — по проведённым документам 1С и с «Документами ERP» не
 * складывается. Какие документы видны пользователю (все или только по его заказам) и видны ли деньги, решает
 * backend — здесь только показ.
 */
export function ClientOnecDocumentsTab({ clientId }: { clientId: number | null }) {
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<ClientOnecDocumentGroup | 'all'>('all');
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => { setPage(1); setGroup('all'); }, [clientId]);
  useEffect(() => {
    if (clientId === null) return undefined;
    let cancelled = false;
    setLoad({ status: 'loading' });
    partyContactsApi.clientOnecDocuments(clientId, { group: group === 'all' ? undefined : group, page, pageSize: PAGE_SIZE })
      .then((response) => { if (!cancelled) setLoad({ status: 'ready', response }); })
      .catch((error: unknown) => { if (!cancelled) setLoad({ status: 'error', text: clientOnecDocumentsProblem(error) }); });
    return () => { cancelled = true; };
  }, [clientId, group, page]);

  if (load.status === 'error') return <Alert type="info" showIcon message={load.text} />;

  const response = load.status === 'ready' ? load.response : null;
  if (response && !response.linked) {
    return (
      <Alert
        type="info"
        showIcon
        message="Клиент не сопоставлен с контрагентом 1С"
        description="Выберите контрагента в блоке «Контрагент 1С» при редактировании клиента — после этого здесь появятся его документы."
      />
    );
  }

  const showMoney = Boolean(response?.summary);
  const scopeNote = response ? clientOnecScopeNote(response.scope) : null;
  const columns = [
    { title: 'Документ', key: 'kind', render: (_: unknown, document: ClientOnecDocument) => {
      const note = clientOnecDocumentStateNote(document.state);
      return (
        <Space size={6} wrap>
          <span>{clientOnecDocumentKind(document.kind)}</span>
          {note && <Typography.Text type="secondary">({note})</Typography.Text>}
        </Space>
      );
    } },
    { title: 'Номер', key: 'number', render: (_: unknown, document: ClientOnecDocument) => document.number ?? '' },
    { title: 'Дата', key: 'date', width: 110, render: (_: unknown, document: ClientOnecDocument) => formatDate(document.date) },
    { title: 'Состояние в 1С', key: 'orderState', render: (_: unknown, document: ClientOnecDocument) => document.orderStateName ?? '' },
    { title: 'Ответственный', key: 'responsible', render: (_: unknown, document: ClientOnecDocument) => document.responsibleName ?? '' },
    { title: 'Заказ ERP', key: 'erpOrders', render: (_: unknown, document: ClientOnecDocument) => (
      <Space size={8} wrap>
        {document.erpOrders.map((order) => <Link key={order.orderId} to={`/orders/show/${order.orderId}`}>{order.orderName}</Link>)}
      </Space>
    ) },
    ...(showMoney ? [
      { title: 'Сумма', key: 'amount', align: 'right' as const, render: (_: unknown, document: ClientOnecDocument) => clientOnecDocumentAmount(document) },
    ] : []),
  ];

  return (
    <>
      <Typography.Title level={5}>
        Документы 1С{response?.counterparty?.name ? ` — ${response.counterparty.name}` : ''}
      </Typography.Title>
      {scopeNote && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={scopeNote} />}
      {response?.summary?.map((summary) => (
        // antd 5.0.5: у Descriptions нет свойства items — только дочерние Descriptions.Item.
        <Descriptions
          key={summary.currency ?? ''}
          size="small"
          column={{ xs: 1, sm: 2, md: 5 }}
          style={{ marginBottom: 12 }}
          title={clientOnecTotalsTitle(summary.currency)}
        >
          {clientOnecTotals(summary).map((item) => (
            <Descriptions.Item key={item.label} label={item.label}>{item.value}</Descriptions.Item>
          ))}
        </Descriptions>
      ))}
      {response && (
        // antd 5.0.5: Segmented без типов — кнопочная Radio.Group.
        <Radio.Group
          optionType="button"
          size="small"
          style={{ marginBottom: 12 }}
          value={group}
          options={clientOnecGroupOptions(response.groups)}
          onChange={(event) => { setGroup(event.target.value as ClientOnecDocumentGroup | 'all'); setPage(1); }}
        />
      )}
      <Table
        rowKey="id"
        size="small"
        loading={load.status === 'loading'}
        dataSource={response?.data ?? []}
        columns={columns}
        locale={{ emptyText: response?.scope === 'own' ? 'Нет документов 1С по вашим заказам этого клиента' : 'У контрагента нет документов в 1С' }}
        pagination={response && response.pagination.total > PAGE_SIZE
          ? { current: page, pageSize: PAGE_SIZE, total: response.pagination.total, showSizeChanger: false, onChange: setPage }
          : false}
      />
    </>
  );
}

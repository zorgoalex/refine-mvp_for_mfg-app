import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, DatePicker, Descriptions, Drawer, Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import {
  documentStateLabel,
  formatMoney,
  isRefund,
  onecDocKindLabel,
  otherCurrencyLabel,
  SETTLEMENT_TONE_COLORS,
  settlementTone,
  type OnecCustomerOrderDetail,
  type OnecCustomerOrderList,
  type OnecCustomerOrderSummary,
  type OnecDocumentRef,
  type OnecLinkedDocument,
} from './onecCustomerOrders';

const { Text } = Typography;
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;

const date = (value: string | null) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU') : '—');
const dateTime = (value: string | null) => (value ? new Date(value).toLocaleString('ru-RU') : '—');

function StateTag({ doc }: { doc: { posted: boolean; deletedInOnec: boolean; missingInSource: boolean } }) {
  const label = documentStateLabel(doc);
  return label ? <Tag color="red">{label}</Tag> : null;
}

function RefCell({ refs }: { refs: OnecDocumentRef[] }) {
  if (refs.length === 0) return <>—</>;
  return (
    <Space direction="vertical" size={0}>
      {refs.map((ref) => (
        <Text key={ref.refKey} type={ref.documentId === null ? 'secondary' : undefined}>
          {onecDocKindLabel(ref.docKind, ref.type)} {ref.number ?? '(не загружен)'} {ref.docDate ? `от ${date(ref.docDate)}` : ''}
        </Text>
      ))}
    </Space>
  );
}

/** «Заказы 1С»: заказы покупателей из 1С с оплатами и отгрузками; карточка — связанные документы (только чтение). */
export function CustomerOrdersTab() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [stateRefKey, setStateRefKey] = useState<string | undefined>(undefined);
  const [period, setPeriod] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<OnecCustomerOrderList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<OnecCustomerOrderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Поколение запроса: ответ устаревшего запроса (другие фильтры/страница) не попадает на экран.
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await onecApi.listCustomerOrders({
        search: search || undefined, stateRefKey, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
        from: period?.[0]?.format('YYYY-MM-DD'), to: period?.[1]?.format('YYYY-MM-DD'),
      });
      if (current === generation.current) setList(result);
    } catch (err) {
      if (current === generation.current) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить заказы 1С');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [search, stateRefKey, period, page]);

  useEffect(() => { void load(); }, [load]);

  const detailGeneration = useRef(0);
  useEffect(() => {
    const current = ++detailGeneration.current;
    setDetail(null);
    setDetailError(null);
    if (openId === null) return;
    onecApi.getCustomerOrder(openId)
      .then((result) => { if (current === detailGeneration.current) setDetail(result); })
      .catch((err) => { if (current === detailGeneration.current) setDetailError(err instanceof ApiError ? err.message : 'Не удалось загрузить заказ'); });
  }, [openId]);

  const money = (value: string | null, row: OnecCustomerOrderSummary) => formatMoney(value, row.currency);
  const settled = (value: string, row: OnecCustomerOrderSummary) => (
    <Tag color={SETTLEMENT_TONE_COLORS[settlementTone(value, row.amount)]}>{formatMoney(value, row.currency)}</Tag>
  );

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="Номер или контрагент"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ width: 280 }}
        />
        <DatePicker.RangePicker
          value={period}
          onChange={(value) => { setPeriod(value); setPage(1); }}
          format="DD.MM.YYYY"
          placeholder={['Дата с', 'по']}
          allowEmpty={[true, true]}
        />
        <Select
          allowClear
          placeholder="Состояние"
          value={stateRefKey}
          onChange={(value) => { setStateRefKey(value); setPage(1); }}
          style={{ minWidth: 220 }}
          options={(list?.states ?? []).map((state) => ({ value: state.refKey, label: `${state.name ?? state.refKey} (${state.count})` }))}
        />
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      <Table<OnecCustomerOrderSummary>
        size="small"
        rowKey="documentId"
        loading={loading}
        dataSource={list?.items ?? []}
        onRow={(row) => ({ onClick: () => setOpenId(row.documentId), style: { cursor: 'pointer' } })}
        pagination={{ current: page, pageSize: PAGE_SIZE, total: list?.total ?? 0, showSizeChanger: false, onChange: setPage }}
        locale={{ emptyText: <Empty description="Заказов 1С нет" /> }}
        columns={[
          { title: 'Номер', dataIndex: 'number', render: (value: string, row: OnecCustomerOrderSummary) => <Space size={4}>{value}<StateTag doc={row} /></Space> },
          { title: 'Дата', dataIndex: 'docDate', render: date },
          { title: 'Контрагент', dataIndex: 'counterpartyName', render: (value: string | null) => value ?? '—' },
          { title: 'Состояние', dataIndex: 'stateName', render: (value: string | null) => value ?? '—' },
          { title: 'Сумма', dataIndex: 'amount', align: 'right' as const, render: money },
          { title: 'Оплачено', dataIndex: 'paid', align: 'right' as const, render: settled },
          { title: 'Отгружено', dataIndex: 'shipped', align: 'right' as const, render: settled },
          { title: 'Другие валюты', dataIndex: 'otherCurrency', render: (items: OnecCustomerOrderSummary['otherCurrency']) => {
            const label = otherCurrencyLabel(items);
            return label ? <Text type="warning">{label}</Text> : '—';
          } },
          { title: 'Автор', dataIndex: 'authorName', render: (value: string | null) => value ?? '—' },
        ]}
      />
      <Drawer open={openId !== null} onClose={() => setOpenId(null)} width={860} title={detail ? `Заказ 1С ${detail.number}` : 'Заказ 1С'} destroyOnClose>
        {detailError && <Alert type="error" showIcon message={detailError} />}
        {!detail && !detailError && <Spin />}
        {detail && <OrderDetail order={detail} />}
      </Drawer>
    </Space>
  );
}

function OrderDetail({ order }: { order: OnecCustomerOrderDetail }) {
  const linkedColumns = (withSettlements: boolean) => [
    { title: 'Документ', dataIndex: 'docKind', render: (kind: string, row: OnecLinkedDocument) => (
      <Space size={4}>{onecDocKindLabel(kind)} {row.number}<StateTag doc={row} />{row.advance && <Tag>аванс</Tag>}</Space>) },
    { title: 'Дата', dataIndex: 'docDate', render: date },
    { title: 'Сумма по заказу', dataIndex: 'amount', align: 'right' as const, render: (value: string | null, row: OnecLinkedDocument) => (
      <Text type={isRefund(row.docKind) ? 'danger' : undefined}>{isRefund(row.docKind) ? '−' : ''}{formatMoney(value, row.currency)}</Text>) },
    ...(withSettlements ? [{ title: 'Зачёт по накладной', dataIndex: 'settlements', render: (refs: OnecDocumentRef[] | undefined) => <RefCell refs={refs ?? []} /> }] : []),
    { title: 'Автор', dataIndex: 'authorName', render: (value: string | null | undefined) => value ?? '—' },
  ];
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="Дата">{dateTime(order.docAt)}</Descriptions.Item>
        <Descriptions.Item label="Состояние">{order.stateName ?? '—'} <StateTag doc={order} /></Descriptions.Item>
        <Descriptions.Item label="Контрагент">{order.counterpartyName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Вид заказа">{order.orderKindName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Сумма">{formatMoney(order.amount, order.currency)}</Descriptions.Item>
        <Descriptions.Item label="Оплата в 1С">{order.paymentStatus ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Оплачено">{formatMoney(order.paid, order.currency)}</Descriptions.Item>
        <Descriptions.Item label="Отгружено">{formatMoney(order.shipped, order.currency)}</Descriptions.Item>
        {otherCurrencyLabel(order.otherCurrency) && (
          <Descriptions.Item label="Другие валюты" span={2}><Text type="warning">{otherCurrencyLabel(order.otherCurrency)}</Text></Descriptions.Item>
        )}
        <Descriptions.Item label="Автор">{order.authorName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Ответственный">{order.responsibleName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Производство">{order.productionStatus ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Завершение">{order.completionVariant ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Доставка">{order.deliveryMethod ?? '—'}{order.deliveryServiceName ? ` · ${order.deliveryServiceName}` : ''}</Descriptions.Item>
        <Descriptions.Item label="Дата отгрузки">{date(order.shipmentDate)}</Descriptions.Item>
        <Descriptions.Item label="Адрес доставки" span={2}>{order.deliveryAddress ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Ожидаемая дата вручения">{date(order.expectedDeliveryDate)}</Descriptions.Item>
        <Descriptions.Item label="Изменён в 1С">{dateTime(order.onecChangedAt)}</Descriptions.Item>
        <Descriptions.Item label="Основание" span={2}><RefCell refs={order.basis ? [order.basis] : []} /></Descriptions.Item>
        {order.comment && <Descriptions.Item label="Комментарий" span={2}>{order.comment}</Descriptions.Item>}
      </Descriptions>
      <Table
        size="small"
        rowKey={(row) => `${row.section}-${row.lineNo}`}
        pagination={false}
        dataSource={order.lines}
        title={() => 'Строки заказа'}
        columns={[
          { title: '№', dataIndex: 'lineNo', render: (value: number, row) => (row.section === 'works' ? `Р${value}` : value) },
          { title: 'Номенклатура', dataIndex: 'nomenclatureName', render: (value: string | null, row) => (
            <Space direction="vertical" size={0}>{value ?? '—'}{row.content && <Text type="secondary">{row.content}</Text>}</Space>) },
          { title: 'Кол-во', dataIndex: 'quantity', align: 'right' as const, render: (value: string, row) => `${Number(value).toLocaleString('ru-RU')} ${row.unitName ?? ''}` },
          { title: 'Сумма', dataIndex: 'amount', align: 'right' as const, render: (value: string | null) => formatMoney(value) },
          { title: 'Отгрузка', dataIndex: 'shipmentDate', render: date },
        ]}
      />
      <Table size="small" rowKey="documentId" pagination={false} dataSource={order.payments} title={() => 'Оплаты и возвраты'}
        locale={{ emptyText: 'Оплат нет' }} columns={linkedColumns(true)} />
      <Table size="small" rowKey="documentId" pagination={false} dataSource={order.shipments} title={() => 'Отгрузки'}
        locale={{ emptyText: 'Отгрузок нет' }} columns={linkedColumns(false)} />
    </Space>
  );
}

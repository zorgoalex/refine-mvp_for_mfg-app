import { Alert, DatePicker, Descriptions, Drawer, Input, Pagination, Select, Space, Spin, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { isApiError } from '../../api/apiError';
import { paymentsOnecApi } from '../../api/paymentsOnecApi';
import type {
  OnecReceiptCardResponse, OnecReceiptGroup, OnecReceiptListItemDto, OnecReceiptListResponse,
} from '../../api/types/paymentsOnecApi.types';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import {
  formatOnecMoney, ONEC_RECEIPT_GROUPS, ONEC_RECEIPT_STATE_COLORS, ONEC_RECEIPT_STATE_LABELS, onecReceiptHasRefund,
  onecReceiptKindLabel, onecReceiptPaymentText, onecReceiptReasonLabel, onecReceiptSignedAmount,
} from './onecReceipts';

const { RangePicker } = DatePicker;
const { Text } = Typography;

export const ONEC_RECEIPTS_SEARCH_DEBOUNCE_MS = 400;
const DEFAULT_PAGE_SIZE = 50;
type DateRange = [Dayjs | null, Dayjs | null] | null;
type KindFilter = 'all' | 'receipts' | 'refunds';

type LoadState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; response: OnecReceiptListResponse };

const EMPTY_ROWS: OnecReceiptListItemDto[] = [];

function StateTag({ row }: { row: Pick<OnecReceiptListItemDto, 'state'> }) {
  return <Tag color={ONEC_RECEIPT_STATE_COLORS[row.state]}>{ONEC_RECEIPT_STATE_LABELS[row.state]}</Tag>;
}

function OrderCell({ row }: { row: OnecReceiptListItemDto }) {
  if (!row.onecOrder && !row.erpOrder) return <Text type="secondary">—</Text>;
  return (
    <Space direction="vertical" size={0}>
      {row.erpOrder ? (
        <span>
          <Link to={`/orders/show/${row.erpOrder.orderId}`} onClick={(event) => event.stopPropagation()}>
            Заказ {row.erpOrder.orderName ?? row.erpOrder.orderId}
          </Link>
          {row.erpOrder.deleted && <Tag color="error" style={{ marginInlineStart: 6 }}>удалён</Tag>}
          {row.erpOrder.linkOrigin === 'manual' && <Tag style={{ marginInlineStart: 6 }}>связан вручную</Tag>}
        </span>
      ) : null}
      {row.onecOrder ? (
        <Text type="secondary">1С: {row.onecOrder.number ?? 'заказ не загружен'}</Text>
      ) : null}
    </Space>
  );
}

/**
 * «Платежи → Поступления 1С» (срез A — только чтение): поступления и возвраты покупателей из 1С и состояние их
 * сверки с платежами заказов. Данные — только backend. Команды сверки появятся следующими срезами
 * (`capabilities.commands`); до тех пор вкладка ничего не меняет.
 */
export function OnecReceiptsTab() {
  const [group, setGroup] = useState<OnecReceiptGroup | null>('review');
  const [kind, setKind] = useState<KindFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [page, setPage] = useState(1);
  const { pageSize, setPageSize } = usePageSizePreference('payments:onec-receipts', DEFAULT_PAGE_SIZE);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [openLineId, setOpenLineId] = useState<number | null>(null);
  const [card, setCard] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: OnecReceiptCardResponse } | null>(null);
  // Номер запроса: ответ устаревшего запроса (другой фильтр/страница) не должен затирать свежий.
  const generation = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, ONEC_RECEIPTS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const current = ++generation.current;
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    paymentsOnecApi.listReceipts({
      page,
      pageSize,
      group: group ?? undefined,
      kind: kind === 'all' ? undefined : kind,
      search: search || undefined,
      dateFrom: dateRange?.[0]?.format('YYYY-MM-DD'),
      dateTo: dateRange?.[1]?.format('YYYY-MM-DD'),
    })
      .then((response) => {
        if (current === generation.current) setState({ status: 'ready', response });
      })
      .catch((error: unknown) => {
        if (current !== generation.current) return;
        if (isApiError(error, 'ONEC_PAYMENT_MATCHING_DISABLED')) {
          setState({ status: 'disabled' });
        } else if (isApiError(error, 'PERMISSION_DENIED') || isApiError(error, 'AUTH_REQUIRED')) {
          setState({ status: 'error', message: 'Недостаточно прав для просмотра поступлений 1С.' });
        } else {
          setState({ status: 'error', message: 'Не удалось загрузить поступления 1С.' });
        }
      });
  }, [page, pageSize, group, kind, search, dateRange]);

  useEffect(() => {
    if (openLineId === null) {
      setCard(null);
      return undefined;
    }
    let active = true;
    setCard({ status: 'loading' });
    paymentsOnecApi.getReceipt(openLineId)
      .then((data) => {
        if (active) setCard({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setCard({
          status: 'error',
          message: isApiError(error, 'ONEC_RECEIPT_NOT_FOUND') ? 'Поступление не найдено или недоступно.' : 'Не удалось загрузить поступление.',
        });
      });
    return () => {
      active = false;
    };
  }, [openLineId]);

  const response = state.status === 'ready' ? state.response : null;
  const rows = response?.data ?? EMPTY_ROWS;
  const total = response?.pagination.total ?? 0;

  const columns = useMemo(() => [
    { title: 'Дата', dataIndex: 'date', width: 100, render: (value: string) => formatDate(value) },
    {
      title: 'Документ 1С',
      key: 'document',
      render: (_: unknown, row: OnecReceiptListItemDto) => (
        <Space direction="vertical" size={0}>
          <span>{row.number}</span>
          <Text type="secondary">{onecReceiptKindLabel(row.kind)}</Text>
          {row.refundOf && <Text type="secondary">по поступлению {row.refundOf.number ?? '—'}</Text>}
        </Space>
      ),
    },
    { title: 'Контрагент', dataIndex: 'counterpartyName', render: (value: string | null) => value ?? '—' },
    { title: 'Заказ', key: 'order', render: (_: unknown, row: OnecReceiptListItemDto) => <OrderCell row={row} /> },
    {
      title: 'Сумма 1С',
      key: 'amount',
      align: 'right' as const,
      render: (_: unknown, row: OnecReceiptListItemDto) => (
        <Space direction="vertical" size={0} align="end">
          <Text type={row.isRefund ? 'danger' : undefined}>{onecReceiptSignedAmount(row)}{row.currency && row.currency !== 'KZT' ? ` ${row.currency}` : ''}</Text>
          {onecReceiptHasRefund(row) && <Text type="warning">возврат {formatOnecMoney(row.refundedAmount)}</Text>}
        </Space>
      ),
    },
    { title: 'Платёж в приложении', key: 'payment', render: (_: unknown, row: OnecReceiptListItemDto) => onecReceiptPaymentText(row) },
    { title: 'Состояние', key: 'state', width: 210, render: (_: unknown, row: OnecReceiptListItemDto) => <StateTag row={row} /> },
  ], []);

  if (state.status === 'disabled') {
    return <Alert showIcon type="info" message="Сверка поступлений 1С пока не включена" />;
  }

  const counters = response?.counters;
  const allCount = counters ? ONEC_RECEIPT_GROUPS.reduce((sum, item) => sum + (counters[item.key] ?? 0), 0) : null;
  const line = card?.status === 'ready' ? card.data.line : null;

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag.CheckableTag checked={group === null} onChange={() => { setGroup(null); setPage(1); }}>
          Все{allCount === null ? '' : ` · ${allCount}`}
        </Tag.CheckableTag>
        {ONEC_RECEIPT_GROUPS.map((item) => (
          <Tag.CheckableTag key={item.key} checked={group === item.key} onChange={() => { setGroup(item.key); setPage(1); }}>
            {item.label}{counters ? ` · ${counters[item.key] ?? 0}` : ''}
          </Tag.CheckableTag>
        ))}
      </Space>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          style={{ minWidth: 280 }}
          allowClear
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Номер документа, контрагент, заказ"
        />
        <RangePicker value={dateRange} onChange={(value) => { setDateRange(value); setPage(1); }} format="DD.MM.YYYY" />
        <Select<KindFilter>
          style={{ minWidth: 200 }}
          value={kind}
          onChange={(value) => { setKind(value); setPage(1); }}
          options={[
            { value: 'all', label: 'Поступления и возвраты' },
            { value: 'receipts', label: 'Только поступления' },
            { value: 'refunds', label: 'Только возвраты' },
          ]}
        />
      </Space>

      {state.status === 'error' && <Alert showIcon type="error" message={state.message} style={{ marginBottom: 16 }} />}

      <Table<OnecReceiptListItemDto>
        rowKey="lineId"
        size="small"
        loading={state.status === 'loading'}
        dataSource={rows}
        columns={columns}
        pagination={false}
        onRow={(row) => ({ onClick: () => setOpenLineId(row.lineId), style: { cursor: 'pointer' } })}
        locale={{ emptyText: 'Нет поступлений по выбранным условиям' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Pagination
          current={page}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          pageSizeOptions={PAGE_SIZE_OPTIONS.map(String)}
          onChange={(nextPage, nextSize) => {
            if (nextSize !== pageSize) {
              setPageSize(nextSize);
              setPage(1);
            } else {
              setPage(nextPage);
            }
          }}
          showTotal={(count) => `Всего: ${count}`}
        />
      </div>

      <Drawer
        open={openLineId !== null}
        onClose={() => setOpenLineId(null)}
        width={720}
        title={line ? `${onecReceiptKindLabel(line.kind)} ${line.number}` : 'Поступление 1С'}
        destroyOnClose
      >
        {card?.status === 'loading' && <Spin />}
        {card?.status === 'error' && <Alert showIcon type="error" message={card.message} />}
        {card?.status === 'ready' && line && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Состояние">
                <StateTag row={line} />
                {onecReceiptReasonLabel(line.reason) && <Text type="secondary"> {onecReceiptReasonLabel(line.reason)}</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Дата">{formatDate(line.date)}</Descriptions.Item>
              <Descriptions.Item label="Контрагент">{line.counterpartyName ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Сумма 1С">{onecReceiptSignedAmount(line)} {line.currency ?? ''}</Descriptions.Item>
              <Descriptions.Item label="Заказ"><OrderCell row={line} /></Descriptions.Item>
              {line.erpOrder && (
                <Descriptions.Item label="Заказ в приложении">
                  сумма {formatOnecMoney(line.erpOrder.finalAmount)}, оплачено {formatOnecMoney(line.erpOrder.paidAmount)}
                  {card.data.onecPaid !== null && <>; оплачено по 1С {formatOnecMoney(card.data.onecPaid)}</>}
                </Descriptions.Item>
              )}
              <Descriptions.Item label="Платёж в приложении">{onecReceiptPaymentText(line)}</Descriptions.Item>
            </Descriptions>

            {!line.isRefund && line.erpOrder && (
              <div>
                <Text strong>Платежи заказа</Text>
                <Table
                  rowKey="paymentId"
                  size="small"
                  pagination={false}
                  dataSource={card.data.candidates}
                  locale={{ emptyText: 'У заказа нет платежей' }}
                  columns={[
                    { title: 'Дата', dataIndex: 'paymentDate', render: (value: string) => formatDate(value) },
                    { title: 'Сумма', dataIndex: 'amount', align: 'right' as const, render: (value: string) => formatOnecMoney(value) },
                    { title: 'Тип оплаты', dataIndex: 'typeName', render: (value: string | null) => value ?? '—' },
                    {
                      title: 'Сравнение',
                      key: 'hint',
                      render: (_: unknown, candidate: OnecReceiptCardResponse['candidates'][number]) => (
                        <Space size={4} wrap>
                          <Tag color={candidate.sameAmount ? 'success' : undefined}>{candidate.sameAmount ? 'сумма совпадает' : 'сумма другая'}</Tag>
                          <Tag color={candidate.daysApart <= 3 ? 'success' : undefined}>
                            {candidate.daysApart === 0 ? 'тот же день' : `разница ${candidate.daysApart} дн.`}
                          </Tag>
                          {candidate.matchedTo && <Tag>сверен с {candidate.matchedTo.number ?? 'другим поступлением'}</Tag>}
                        </Space>
                      ),
                    },
                  ]}
                />
              </div>
            )}

            {card.data.refunds.length > 0 && (
              <div>
                <Text strong>Возвраты по этому поступлению</Text>
                <Table
                  rowKey="lineId"
                  size="small"
                  pagination={false}
                  dataSource={card.data.refunds}
                  columns={[
                    { title: 'Дата', dataIndex: 'date', render: (value: string) => formatDate(value) },
                    { title: 'Документ', key: 'doc', render: (_: unknown, refund: OnecReceiptCardResponse['refunds'][number]) => `${onecReceiptKindLabel(refund.kind)} ${refund.number}` },
                    {
                      title: 'Сумма',
                      key: 'amount',
                      align: 'right' as const,
                      render: (_: unknown, refund: OnecReceiptCardResponse['refunds'][number]) =>
                        `−${formatOnecMoney(refund.amount)}${refund.currency && refund.currency !== 'KZT' ? ` ${refund.currency}` : ''}`,
                    },
                    { title: '', key: 'live', render: (_: unknown, refund: OnecReceiptCardResponse['refunds'][number]) => (refund.live ? null : <Tag>не действует</Tag>) },
                  ]}
                />
              </div>
            )}

            {card.data.history.length > 0 && (
              <div>
                <Text strong>История сверки</Text>
                <Table
                  rowKey="matchId"
                  size="small"
                  pagination={false}
                  dataSource={card.data.history}
                  columns={[
                    { title: 'Когда', dataIndex: 'createdAt', render: (value: string) => formatDate(value) },
                    { title: 'Кто', dataIndex: 'createdBy', render: (value: string | null) => value ?? '—' },
                    {
                      title: 'Что',
                      key: 'what',
                      render: (_: unknown, entry: OnecReceiptCardResponse['history'][number]) => {
                        if (entry.kind === 'dismissed') return 'разобрано без связи';
                        if (!entry.payment || !('paymentId' in entry.payment)) return 'сверено с платежом вне вашего доступа';
                        return `сверено с платежом ${formatOnecMoney(entry.payment.amount)} от ${formatDate(entry.payment.paymentDate)}`;
                      },
                    },
                    { title: 'Комментарий', dataIndex: 'note', render: (value: string | null) => value ?? '—' },
                    { title: 'Снято', dataIndex: 'removedAt', render: (value: string | null) => (value ? formatDate(value) : '—') },
                  ]}
                />
              </div>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
}

import { Alert, Space, Tag, Typography } from 'antd';
import React from 'react';
import { Link } from 'react-router-dom';

import type { OnecReceiptListItemDto } from '../../../../api/types/paymentsOnecApi.types';
import { Table } from '../../../../ui/tooltipDelay';
import { formatDate } from '../../../../utils/dateFormat';
import {
  ONEC_RECEIPT_STATE_COLORS, ONEC_RECEIPT_STATE_LABELS, onecReceiptKindLabel, onecReceiptPaymentText,
} from '../../../payments/onecReceipts';
import { onecReceiptCardPath } from '../../../payments/onecReceiptsAccess';
import { orderOnecAmountText, orderOnecStateNotes, orderOnecTruncatedText } from './orderOnecReceipts';
import type { OrderOnecReceiptsState } from './useOrderOnecReceipts';

const { Text } = Typography;

/** Ссылка не должна срабатывать как клик/двойной клик строки или блока (редактирование, переход в форму). */
const stop = (event: React.SyntheticEvent) => event.stopPropagation();

function DocLink({ row }: { row: OnecReceiptListItemDto }) {
  return (
    <Link to={onecReceiptCardPath(row.lineId)} onClick={stop} onDoubleClick={stop}>
      {onecReceiptKindLabel(row.kind)} {row.number}
    </Link>
  );
}

/** Колонка «1С» у платежа заказа: документы 1С, точно сверенные с этим платежом (только просмотр). */
export function OnecPaymentMatchCell({ rows }: { rows: readonly OnecReceiptListItemDto[] | undefined }) {
  if (!rows || rows.length === 0) return <Text type="secondary">—</Text>;
  return (
    <Space direction="vertical" size={0}>
      {rows.map((row) => (
        <span key={row.lineId} style={{ fontSize: 12 }}>
          <DocLink row={row} /> <Text type="secondary">от {formatDate(row.date)}</Text>
        </span>
      ))}
    </Space>
  );
}

function StateCell({ row }: { row: OnecReceiptListItemDto }) {
  return (
    <Space direction="vertical" size={0}>
      <Tag color={ONEC_RECEIPT_STATE_COLORS[row.state]} style={{ marginInlineEnd: 0 }}>{ONEC_RECEIPT_STATE_LABELS[row.state]}</Tag>
      {orderOnecStateNotes(row).map((note) => (
        <Text key={note.kind} type={note.kind === 'changes' ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>{note.text}</Text>
      ))}
    </Space>
  );
}

const columns = [
  { title: 'Дата', dataIndex: 'date', key: 'date', width: 100, render: (value: string) => formatDate(value) },
  {
    title: 'Документ 1С',
    key: 'document',
    render: (_: unknown, row: OnecReceiptListItemDto) => (
      <Space direction="vertical" size={0}>
        <DocLink row={row} />
        {row.refundOf && <Text type="secondary" style={{ fontSize: 12 }}>по поступлению {row.refundOf.number ?? '—'}</Text>}
        {row.counterpartyName && <Text type="secondary" style={{ fontSize: 12 }}>{row.counterpartyName}</Text>}
      </Space>
    ),
  },
  {
    title: 'Сумма',
    key: 'amount',
    width: 130,
    align: 'right' as const,
    render: (_: unknown, row: OnecReceiptListItemDto) => (
      <Text type={row.isRefund ? 'danger' : undefined} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {orderOnecAmountText(row)}
      </Text>
    ),
  },
  { title: 'Состояние', key: 'state', width: 220, render: (_: unknown, row: OnecReceiptListItemDto) => <StateCell row={row} /> },
  { title: 'Платёж в приложении', key: 'payment', render: (_: unknown, row: OnecReceiptListItemDto) => onecReceiptPaymentText(row) },
];

/**
 * Платежи 1С заказа без точной пары с платежом (разбор, «создать», изменились, разобраны, возвраты) — только просмотр;
 * действия сверки — в карточке строки на вкладке «Платежи → Поступления 1С» (ссылка у номера документа).
 */
export function OrderOnecReceiptsTable({ state }: { state: OrderOnecReceiptsState }) {
  if (state.status === 'off') return null;
  if (state.status === 'error') return <Alert showIcon type="warning" message={state.message} style={{ marginTop: 12 }} />;
  const rows = state.status === 'ready' ? state.split.other : [];
  if (state.status === 'ready' && rows.length === 0 && !state.truncated) return null;
  return (
    <section aria-label="Платежи 1С без сопоставления" style={{ marginTop: 12 }} onDoubleClick={stop}>
      <Text style={{ fontSize: 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: 8 }}>
        Платежи 1С без сопоставления{state.status === 'ready' ? ` (${rows.length})` : ''}
      </Text>
      {state.status === 'ready' && state.truncated && (
        <Alert showIcon type="info" style={{ marginBottom: 8 }}
          message={orderOnecTruncatedText(state)} />
      )}
      <Table<OnecReceiptListItemDto>
        rowKey="lineId"
        size="small"
        bordered
        pagination={false}
        loading={state.status === 'loading'}
        dataSource={[...rows]}
        columns={columns}
        locale={{ emptyText: 'Нет' }}
      />
    </section>
  );
}


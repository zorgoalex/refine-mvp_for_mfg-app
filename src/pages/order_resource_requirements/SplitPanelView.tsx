import { Typography, theme } from 'antd';
import type { Key } from 'react';

import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import { ResourceDemandCard, type ResourceCardMode } from './ResourceDemandCard';
import { KindDot, numericStyle, useResourceKindColor } from './ResourceDemandParts';
import {
  RESOURCE_KIND_BY_KEY,
  RESOURCE_KINDS,
  UNIT_LABELS,
  orderDisplayName,
  resourceDemandLines,
  resourceKindTotal,
  type OrderResourceDemandRow,
  type ResourceKind,
} from './resourceKinds';

const compactNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** Вид «Панель»: узкий список заказов слева, потребности выбранного заказа справа. */
export function SplitPanelView({
  rows,
  loading,
  emptyText,
  selectedOrderId,
  onSelectOrder,
  selectedRowKeys,
  onSelectionChange,
  cardMode,
  onCardModeChange,
}: {
  rows: OrderResourceDemandRow[];
  loading: boolean;
  emptyText: string;
  selectedOrderId: number | null;
  onSelectOrder: (orderId: number) => void;
  selectedRowKeys: Key[];
  onSelectionChange: (keys: Key[], rows: OrderResourceDemandRow[]) => void;
  cardMode: ResourceCardMode;
  onCardModeChange: (mode: ResourceCardMode) => void;
}) {
  const { token } = theme.useToken();
  const selected = rows.find((row) => row.orderId === selectedOrderId) ?? rows[0] ?? null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 560px) minmax(0, 1fr)',
        gap: 16,
        alignItems: 'start',
      }}
    >
      <Table<OrderResourceDemandRow>
        rowKey="orderId"
        size="small"
        dataSource={rows}
        loading={loading}
        pagination={false}
        locale={{ emptyText }}
        rowSelection={{
          selectedRowKeys,
          onChange: onSelectionChange,
          preserveSelectedRowKeys: true,
          columnWidth: 40,
        }}
        onRow={(row) => ({
          onClick: () => onSelectOrder(row.orderId),
          style: {
            cursor: 'pointer',
            background: row.orderId === selected?.orderId ? token.controlItemBgActive : undefined,
          },
        })}
      >
        <Table.Column<OrderResourceDemandRow>
          key="order"
          title="Заказ"
          render={(_, row) => (
            <>
              <Typography.Text strong>{orderDisplayName(row)}</Typography.Text>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.clientName || 'Клиент не указан'}</Typography.Text>
              </div>
            </>
          )}
        />
        <Table.Column<OrderResourceDemandRow>
          key="date"
          title="Дата"
          width={70}
          render={(_, row) => (
            <Typography.Text type="secondary" style={{ ...numericStyle, whiteSpace: 'nowrap' }}>
              {row.orderDate ? formatDate(row.orderDate).slice(0, 5) : '—'}
            </Typography.Text>
          )}
        />
        {RESOURCE_KINDS.map((meta) => (
          <Table.Column<OrderResourceDemandRow>
            key={meta.kind}
            title={<span title={meta.label}>{meta.letter}</span>}
            align="right"
            width={88}
            render={(_, row) => <KindNumber row={row} kind={meta.kind} />}
          />
        ))}
      </Table>
      <div
        style={{
          background: token.colorFillAlter,
          borderRadius: token.borderRadiusLG,
          padding: 16,
          minWidth: 0,
        }}
      >
        {selected ? (
          <ResourceDemandCard row={selected} mode={cardMode} onModeChange={onCardModeChange} compact />
        ) : (
          <Typography.Text type="secondary">Выберите заказ в списке слева.</Typography.Text>
        )}
      </div>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <PanelLegend />
      </div>
    </div>
  );
}

function KindNumber({ row, kind }: { row: OrderResourceDemandRow; kind: ResourceKind }) {
  const colorOf = useResourceKindColor();
  const total = resourceKindTotal(resourceDemandLines(row), kind);
  if (total.count === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const hasValue = total.count > total.missingCount;
  return (
    <span style={{ ...numericStyle, whiteSpace: 'nowrap', fontWeight: 600, color: colorOf(kind) }}>
      {hasValue ? compactNumber.format(total.total) : '—'}
      <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 400, marginInlineStart: 2 }}>
        {UNIT_LABELS[RESOURCE_KIND_BY_KEY[kind].unit]}
      </Typography.Text>
      {total.missingCount > 0 && (
        <Typography.Text type="warning" style={{ fontSize: 11, marginInlineStart: 3 }} title={`${total.missingCount} без раскроя`}>
          ●
        </Typography.Text>
      )}
    </span>
  );
}

function PanelLegend() {
  const colorOf = useResourceKindColor();
  return (
    <>
      {RESOURCE_KINDS.map((meta) => (
        <Typography.Text key={meta.kind} type="secondary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <KindDot color={colorOf(meta.kind)} />
          {meta.letter}: {meta.label}
        </Typography.Text>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <Typography.Text type="warning">●</Typography.Text> есть позиции без раскроя
      </Typography.Text>
    </>
  );
}

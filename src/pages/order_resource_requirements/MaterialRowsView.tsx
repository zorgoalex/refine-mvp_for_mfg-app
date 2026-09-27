import { Button, Space, Tag, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';

import type { OrderResourceCapabilitiesDto } from '../../api/types/orderApi.types';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import { ProcurementCheckbox, ProcurementProgressTag } from './ProcurementParts';
import { KindDot, KindTitle, SourceTag, numericStyle, useResourceKindColor } from './ResourceDemandParts';
import {
  RESOURCE_KINDS,
  formatKindTotal,
  formatLineQuantity,
  linesOfKind,
  orderDisplayName,
  resourceDemandLines,
  resourceKindTotal,
  type OrderResourceDemandRow,
  type ResourceDemandLine,
  type ResourceKind,
} from './resourceKinds';

type MaterialRowsItem =
  | { key: string; type: 'group'; row: OrderResourceDemandRow; lines: ResourceDemandLine[] }
  | { key: string; type: 'line'; row: OrderResourceDemandRow; line: ResourceDemandLine };

const BASE_COLUMN_COUNT = 6;

/** Вид «Материалы»: шапка группы — заказ с итогами, под ней строка на каждый материал. */
export function MaterialRowsView({
  rows,
  loading,
  emptyText,
  onOpenCard,
  collapsed,
  onToggleGroup,
  capabilities,
  canManage,
  manageLoading,
  onProcurementChanged,
}: {
  rows: OrderResourceDemandRow[];
  loading: boolean;
  emptyText: string;
  onOpenCard: (row: OrderResourceDemandRow) => void;
  /** Заказы со свёрнутыми материалами; хранится в списке, чтобы работала кнопка «Свернуть все». */
  collapsed: ReadonlySet<number>;
  onToggleGroup: (orderId: number) => void;
  capabilities: OrderResourceCapabilitiesDto;
  canManage: boolean;
  manageLoading: boolean;
  onProcurementChanged: () => void;
}) {
  const colorOf = useResourceKindColor();
  const { token } = theme.useToken();
  const [visibleKinds, setVisibleKinds] = useState<Set<ResourceKind>>(
    () => new Set(RESOURCE_KINDS.map((meta) => meta.kind)),
  );

  const items = useMemo(() => buildMaterialRowsItems(rows, visibleKinds, collapsed), [collapsed, rows, visibleKinds]);
  const columnCount = capabilities.procurement ? BASE_COLUMN_COUNT + 1 : BASE_COLUMN_COUNT;

  const toggleKind = (kind: ResourceKind) => {
    setVisibleKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) {
        if (next.size > 1) next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  };

  const groupCell = (item: MaterialRowsItem) => (item.type === 'group' ? { colSpan: 0 } : {});

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Typography.Text type="secondary">Типы:</Typography.Text>
        {RESOURCE_KINDS.map((meta) => {
          const active = visibleKinds.has(meta.kind);
          return (
            <Button
              key={meta.kind}
              size="small"
              shape="round"
              aria-pressed={active}
              type={active ? 'default' : 'dashed'}
              style={active ? { borderColor: colorOf(meta.kind) } : undefined}
              onClick={() => toggleKind(meta.kind)}
            >
              <KindDot color={active ? colorOf(meta.kind) : token.colorTextQuaternary} />
              <span style={{ marginInlineStart: 6 }}>{meta.shortLabel}</span>
            </Button>
          );
        })}
      </Space>
      <Table<MaterialRowsItem>
        rowKey="key"
        size="small"
        dataSource={items}
        loading={loading}
        pagination={false}
        scroll={{ x: 900 }}
        locale={{ emptyText }}
        onRow={(item) => (item.type === 'group' ? { style: { background: token.colorFillAlter } } : {})}
      >
        <Table.Column<MaterialRowsItem>
          key="kind"
          title="Тип"
          width={150}
          onCell={(item) => (item.type === 'group' ? { colSpan: columnCount } : {})}
          render={(_, item) => (item.type === 'group'
            ? (
              <MaterialGroupHeader
                row={item.row}
                lines={item.lines}
                collapsed={collapsed.has(item.row.orderId)}
                onToggle={() => onToggleGroup(item.row.orderId)}
                onOpenCard={() => onOpenCard(item.row)}
                showProcurement={capabilities.procurement}
              />
            )
            : <span style={{ paddingInlineStart: 24 }}><KindTitle kind={item.line.kind} short /></span>)}
        />
        <Table.Column<MaterialRowsItem>
          key="name"
          title="Материал"
          onCell={groupCell}
          render={(_, item) => (item.type === 'line' ? item.line.name : null)}
        />
        <Table.Column<MaterialRowsItem>
          key="supplier"
          title="Поставщик / производитель"
          onCell={groupCell}
          render={(_, item) => (item.type === 'line'
            ? <Typography.Text type="secondary">{item.line.supplierLabel?.replace(/^[^:]+:\s*/, '') ?? '—'}</Typography.Text>
            : null)}
        />
        <Table.Column<MaterialRowsItem>
          key="quantity"
          title="Количество"
          align="right"
          onCell={groupCell}
          render={(_, item) => (item.type === 'line'
            ? (
              <>
                <Typography.Text strong style={{ ...numericStyle, whiteSpace: 'nowrap' }}>{formatLineQuantity(item.line)}</Typography.Text>
                {item.line.secondaryText && (
                  <div><Typography.Text type="secondary" style={{ ...numericStyle, fontSize: 12 }}>{item.line.secondaryText}</Typography.Text></div>
                )}
              </>
            )
            : null)}
        />
        <Table.Column<MaterialRowsItem>
          key="details"
          title="Деталей"
          align="right"
          width={80}
          onCell={groupCell}
          render={(_, item) => (item.type === 'line' ? <span style={numericStyle}>{item.line.detailsCount}</span> : null)}
        />
        <Table.Column<MaterialRowsItem>
          key="source"
          title="Источник"
          width={120}
          onCell={groupCell}
          render={(_, item) => (item.type === 'line' ? <SourceTag source={item.line.source} /> : null)}
        />
        {capabilities.procurement && (
          <Table.Column<MaterialRowsItem>
            key="procurement"
            title="Закуп"
            width={160}
            onCell={groupCell}
            render={(_, item) => (item.type === 'line'
              ? (
                <ProcurementCheckbox
                  orderId={item.row.orderId}
                  line={item.line}
                  canManage={canManage}
                  manageLoading={manageLoading}
                  onChanged={onProcurementChanged}
                />
              )
              : null)}
          />
        )}
      </Table>
    </Space>
  );
}

function MaterialGroupHeader({
  row,
  lines,
  collapsed,
  onToggle,
  onOpenCard,
  showProcurement,
}: {
  row: OrderResourceDemandRow;
  lines: ResourceDemandLine[];
  collapsed: boolean;
  onToggle: () => void;
  onOpenCard: () => void;
  showProcurement: boolean;
}) {
  const colorOf = useResourceKindColor();
  const presentKinds = RESOURCE_KINDS.filter((meta) => linesOfKind(lines, meta.kind).length > 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Button
        type="text"
        size="small"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Развернуть материалы заказа' : 'Свернуть материалы заказа'}
        onClick={onToggle}
      >
        {collapsed ? '▶' : '▼'}
      </Button>
      <Typography.Link strong onClick={onOpenCard}>{orderDisplayName(row)}</Typography.Link>
      <Typography.Text type="secondary">{row.clientName || 'Клиент не указан'}</Typography.Text>
      <Typography.Text type="secondary" style={numericStyle}>{row.orderDate ? formatDate(row.orderDate) : '—'}</Typography.Text>
      {showProcurement && <ProcurementProgressTag summary={row.procurementSummary} />}
      <span style={{ flex: 1 }} />
      {presentKinds.length === 0 ? (
        <Tag>потребности не рассчитаны</Tag>
      ) : (
        presentKinds.map((meta) => {
          const total = resourceKindTotal(lines, meta.kind);
          return (
            <Tag key={meta.kind} style={{ marginInlineEnd: 0 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <KindDot color={colorOf(meta.kind)} />
                {meta.shortLabel}:{' '}
                <b style={{ ...numericStyle, color: colorOf(meta.kind) }}>{formatKindTotal(total, meta.kind)}</b>
                {total.missingCount > 0 && <span>+{total.missingCount} без раскроя</span>}
              </span>
            </Tag>
          );
        })
      )}
    </div>
  );
}

export function buildMaterialRowsItems(
  rows: OrderResourceDemandRow[],
  visibleKinds: Set<ResourceKind>,
  collapsed: ReadonlySet<number>,
): MaterialRowsItem[] {
  const items: MaterialRowsItem[] = [];
  for (const row of rows) {
    const lines = resourceDemandLines(row);
    items.push({ key: `order:${row.orderId}`, type: 'group', row, lines });
    if (collapsed.has(row.orderId)) continue;
    for (const line of lines) {
      if (visibleKinds.has(line.kind)) {
        items.push({ key: `order:${row.orderId}:${line.resourceKey}`, type: 'line', row, line });
      }
    }
  }
  return items;
}

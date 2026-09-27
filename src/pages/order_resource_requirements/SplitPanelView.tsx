import { Typography, theme } from 'antd';
import type { Key } from 'react';

import type { OrderResourceByMaterialQuery, OrderResourceCapabilitiesDto } from '../../api/types/orderApi.types';
import { Segmented } from '../../ui/Segmented';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import { MaterialAggregateTable, useResourceDemandByMaterial } from './MaterialAggregateView';
import { ProcurementProgressTag } from './ProcurementParts';
import { ResourceDemandCard, type ResourceCardMode } from './ResourceDemandCard';
import { KindDot, numericStyle, useResourceKindColor } from './ResourceDemandParts';
import {
  RESOURCE_KIND_BY_KEY,
  RESOURCE_KINDS,
  UNIT_LABELS,
  orderDisplayName,
  resolvePanelSubMode,
  resourceDemandLines,
  resourceKindTotal,
  type OrderResourceDemandRow,
  type ResourceKind,
} from './resourceKinds';
import { useStoredViewMode } from './useStoredViewMode';

type PanelSubMode = 'orders' | 'materials';
const PANEL_SUB_MODES: readonly PanelSubMode[] = ['orders', 'materials'];
const PANEL_SUB_MODE_OPTIONS = [
  { value: 'orders', label: 'По заказам' },
  { value: 'materials', label: 'По материалам' },
];

// Площадь — до сотых (0,02 м² не должно превращаться в 0), погонные метры — до десятых.
const COMPACT_NUMBER_BY_UNIT = {
  m2: new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }),
  lm: new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }),
} as const;

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
  capabilities,
  canManage,
  manageLoading,
  onProcurementChanged,
  byMaterialQuery,
  refreshRevision,
  clientFiltersActive = false,
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
  capabilities: OrderResourceCapabilitiesDto;
  canManage: boolean;
  manageLoading: boolean;
  onProcurementChanged: () => void;
  /** Фильтры текущего списка — «По материалам» грузит агрегат с теми же условиями. */
  byMaterialQuery: OrderResourceByMaterialQuery;
  refreshRevision: number;
  /** Фильтры списка, которые не передаются в сводку по материалам (заголовки колонок, «Готовые раскрои»). */
  clientFiltersActive?: boolean;
}) {
  const { token } = theme.useToken();
  const selected = rows.find((row) => row.orderId === selectedOrderId) ?? rows[0] ?? null;
  const [storedSubMode, setSubMode] = useStoredViewMode<PanelSubMode>(
    'order-resource-requirements:panel-submode',
    PANEL_SUB_MODES,
    'orders',
  );
  const subMode = resolvePanelSubMode(storedSubMode, capabilities.byMaterial);
  const byMaterialState = useResourceDemandByMaterial(
    byMaterialQuery,
    capabilities.byMaterial && subMode === 'materials',
    refreshRevision,
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {capabilities.byMaterial && (
        <Segmented
          aria-label="Режим панели"
          value={subMode}
          options={PANEL_SUB_MODE_OPTIONS}
          onChange={(value) => setSubMode(value as PanelSubMode)}
        />
      )}
      {subMode === 'materials' ? (
        <MaterialAggregateTable
          state={byMaterialState}
          emptyText={emptyText}
          showProcurement={capabilities.procurement}
          canManage={canManage}
          manageLoading={manageLoading}
          clientFiltersActive={clientFiltersActive}
          onChanged={() => {
            byMaterialState.reload();
            onProcurementChanged();
          }}
        />
      ) : (
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
            {capabilities.procurement && (
              <Table.Column<OrderResourceDemandRow>
                key="procurement"
                title="Закуп"
                align="right"
                width={96}
                render={(_, row) => <ProcurementProgressTag summary={row.procurementSummary} />}
              />
            )}
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
              <ResourceDemandCard
                row={selected}
                mode={cardMode}
                onModeChange={onCardModeChange}
                compact
                capabilities={capabilities}
                canManage={canManage}
                manageLoading={manageLoading}
                onProcurementChanged={onProcurementChanged}
              />
            ) : (
              <Typography.Text type="secondary">Выберите заказ в списке слева.</Typography.Text>
            )}
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <PanelLegend />
          </div>
        </div>
      )}
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
      {hasValue ? COMPACT_NUMBER_BY_UNIT[RESOURCE_KIND_BY_KEY[kind].unit].format(total.total) : '—'}
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

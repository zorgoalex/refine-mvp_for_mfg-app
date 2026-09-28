import { Alert, Checkbox, Space, Tag, Typography, message } from 'antd';
import { Tooltip } from '../../ui/tooltipDelay';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Table } from '../../ui/tooltipDelay';
import { ApiError, isApiError } from '../../api/apiError';
import { ordersApi } from '../../api/ordersApi';
import type {
  OrderResourceByMaterialQuery,
  OrderResourceMaterialAggregateDto,
} from '../../api/types/orderApi.types';
import { KindTitle, numericStyle } from './ResourceDemandParts';
import { canBulkMarkParticipants, formatResourceQuantity, isAggregateCurrent } from './resourceKinds';

export interface MaterialAggregateState {
  data: OrderResourceMaterialAggregateDto[];
  ordersCount: number;
  loading: boolean;
  error: string | null;
  tooMany: boolean;
  reload: () => void;
  /**
   * Данные получены именно для текущих фильтров и сейчас ничего не грузится.
   * Групповая отметка разрешена только тогда (R2 code review): иначе она ушла бы
   * по участникам прежней выборки.
   */
  current: boolean;
  /** Та же проверка в момент клика — по ref, без устаревшего замыкания. */
  isCurrent: () => boolean;
}

/** Сводка «По материалам»: агрегат по всем заказам фильтра (`GET …/by-material`). */
export function useResourceDemandByMaterial(
  query: OrderResourceByMaterialQuery,
  enabled: boolean,
  refreshRevision: number,
): MaterialAggregateState {
  const [data, setData] = useState<OrderResourceMaterialAggregateDto[]>([]);
  const [ordersCount, setOrdersCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tooMany, setTooMany] = useState(false);
  const requestSequence = useRef(0);
  const queryKey = JSON.stringify(query);
  const [dataKey, setDataKey] = useState<string | null>(null);
  const latestKeyRef = useRef(queryKey);
  latestKeyRef.current = queryKey;
  const dataKeyRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(() => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    const requestKey = queryKey;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    setTooMany(false);
    ordersApi.listResourceDemandsByMaterial(query)
      .then((response) => {
        if (requestSequence.current !== requestId) return;
        setData(response.data);
        setOrdersCount(response.ordersCount);
        dataKeyRef.current = requestKey;
        setDataKey(requestKey);
        loadingRef.current = false;
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (requestSequence.current !== requestId) return;
        if (isApiError(loadError, 'ORDER_RESOURCE_BY_MATERIAL_TOO_MANY')) {
          setTooMany(true);
          setData([]);
          setOrdersCount(0);
        } else {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить сводку по материалам.');
        }
        dataKeyRef.current = null;
        setDataKey(null);
        loadingRef.current = false;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  useEffect(() => {
    if (!enabled) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, queryKey, refreshRevision]);

  const isCurrent = useCallback(
    () => !loadingRef.current && dataKeyRef.current !== null && dataKeyRef.current === latestKeyRef.current,
    [],
  );
  return {
    data,
    ordersCount,
    loading,
    error,
    tooMany,
    reload: load,
    current: isAggregateCurrent(loading, dataKey, queryKey),
    isCurrent,
  };
}

/** «По материалам»: тип, материал, поставщик, итог, заказов/деталей, групповая отметка «Закуплено». */
export function MaterialAggregateTable({
  state,
  emptyText,
  showProcurement,
  canManage,
  manageLoading,
  onChanged,
  clientFiltersActive = false,
  periodNote = null,
}: {
  state: MaterialAggregateState;
  emptyText: string;
  /** capabilities.procurement — без него колонка «Закуп» не рендерится вовсе. */
  showProcurement: boolean;
  canManage: boolean;
  manageLoading: boolean;
  onChanged: () => void;
  /**
   * В списке активны фильтры колонок или «Готовые раскрои». Сервер их не знает,
   * поэтому сводка шире списка, а групповая отметка задела бы скрытые заказы.
   */
  clientFiltersActive?: boolean;
  /** Сводка взята за период по умолчанию — показать, какой именно. */
  periodNote?: string | null;
}) {
  if (state.tooMany) {
    return (
      <Alert
        showIcon
        type="warning"
        message="Слишком много заказов для сводки по материалам"
        description="Сузьте период или фильтры, чтобы список стал короче."
      />
    );
  }
  if (state.error) {
    return <Alert showIcon type="error" message="Не удалось обновить сводку по материалам" description={state.error} />;
  }
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
    {periodNote && <Typography.Text type="secondary">{periodNote}</Typography.Text>}
    {clientFiltersActive && (
      <Alert
        showIcon
        type="warning"
        message="Сводка по материалам учитывает только поиск, период и «Есть незакупленное»"
        description="Фильтры колонок и «Готовые раскрои» к ней не применяются, поэтому групповая отметка «Закуплено» отключена. Снимите эти фильтры, чтобы отметить материал сразу во всех заказах."
      />
    )}
    <Table<OrderResourceMaterialAggregateDto>
      rowKey="resourceKey"
      size="small"
      dataSource={state.data}
      loading={state.loading}
      pagination={false}
      locale={{ emptyText }}
    >
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="kind"
        title="Тип"
        width={150}
        render={(_, row) => <KindTitle kind={row.kind} short />}
      />
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="name"
        title="Материал"
        render={(_, row) => row.name}
      />
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="supplier"
        title="Поставщик / производитель"
        render={(_, row) => <Typography.Text type="secondary">{row.supplierName ?? '—'}</Typography.Text>}
      />
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="totalQuantity"
        title="Итого количество"
        align="right"
        render={(_, row) => (
          <Typography.Text strong style={numericStyle}>
            {formatResourceQuantity(row.totalQuantity, row.unit)}
          </Typography.Text>
        )}
      />
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="ordersCount"
        title="Заказов"
        align="right"
        width={90}
        render={(_, row) => <span style={numericStyle}>{row.ordersCount}</span>}
      />
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="detailsCount"
        title="Деталей"
        align="right"
        width={90}
        render={(_, row) => <span style={numericStyle}>{row.detailsCount}</span>}
      />
      <Table.Column<OrderResourceMaterialAggregateDto>
        key="noDataOrders"
        title="Нет раскроя"
        align="right"
        width={100}
        render={(_, row) => (row.noDataOrders > 0
          ? <Tag>{row.noDataOrders} заказов</Tag>
          : <Typography.Text type="secondary">—</Typography.Text>)}
      />
      {showProcurement && (
        <Table.Column<OrderResourceMaterialAggregateDto>
          key="procurement"
          title="Закуп"
          width={200}
          render={(_, row) => (
            <MaterialGroupProcurementCheckbox
              aggregate={row}
              canManage={canManage}
              manageLoading={manageLoading}
              onChanged={onChanged}
              blockedReason={clientFiltersActive
                ? 'Снимите фильтры колонок и «Готовые раскрои»'
                : !state.current ? 'Сводка обновляется по новым фильтрам' : null}
              isCurrent={state.isCurrent}
            />
          )}
        />
      )}
    </Table>
    </Space>
  );
}

function MaterialGroupProcurementCheckbox({
  aggregate,
  canManage,
  manageLoading,
  onChanged,
  blockedReason,
  isCurrent,
}: {
  aggregate: OrderResourceMaterialAggregateDto;
  canManage: boolean;
  manageLoading: boolean;
  onChanged: () => void;
  blockedReason: string | null;
  isCurrent: () => boolean;
}) {
  const [pending, setPending] = useState(false);
  const allPurchased = aggregate.ordersCount > 0 && aggregate.purchasedOrders >= aggregate.ordersCount;
  const eligible = canBulkMarkParticipants(aggregate.participants.length);
  const disabled = manageLoading || !canManage || pending || !eligible || blockedReason !== null;

  const handleChange = async () => {
    // Повторная проверка в момент клика: фильтры могли смениться между рендером и нажатием.
    if (!isCurrent()) {
      message.warning('Сводка обновляется по новым фильтрам. Дождитесь загрузки и повторите.');
      return;
    }
    setPending(true);
    try {
      await ordersApi.bulkSetResourceProcurement({
        resourceKey: aggregate.resourceKey,
        purchased: !allPurchased,
        items: aggregate.participants.map((participant) => ({
          orderId: participant.orderId,
          expectedVersion: participant.version,
          expectedDemandFingerprint: participant.demandFingerprint,
        })),
      });
      onChanged();
    } catch (error) {
      if (isApiError(error, 'PROCUREMENT_BULK_CONFLICT')) {
        message.warning(error.message);
      } else if (error instanceof ApiError) {
        message.error(error.message || 'Не удалось изменить групповую отметку «Закуплено»');
      } else {
        message.error('Не удалось изменить групповую отметку «Закуплено»');
      }
      onChanged();
    } finally {
      setPending(false);
    }
  };

  const checkbox = (
    <Checkbox checked={allPurchased} disabled={disabled} onChange={() => void handleChange()} />
  );

  return (
    <Space size={6}>
      <Tooltip title={blockedReason ?? (!eligible ? 'слишком много заказов — сузьте фильтр' : undefined)}>
        <span>{checkbox}</span>
      </Tooltip>
      <Typography.Text>Закуплено {aggregate.purchasedOrders} из {aggregate.ordersCount}</Typography.Text>
    </Space>
  );
}

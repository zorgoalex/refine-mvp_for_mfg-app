import { Table } from '../../../../ui/tooltipDelay';
// Order Materials Tab
// Displays aggregated data for materials and films

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Row, Col, Space, Typography } from 'antd';
import { useList, useOrderAsyncReadGuard } from '../../../../query/orderLifecycleQueries';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { resolveDetailMaterialName } from '../../../../utils/materialDisplayName';
import { can } from '../../../../utils/permissions';
import { cutApi } from '../../../../api/cutApi';
import type { CutJobDto } from '../../../../api/types/cutApi.types';
import { useCutDetailLastReady } from '../../useCutDetailLastReady';
import { computeOrderBathFilmUsage } from '../../../cut/cutFilmUsage';
import { buildCutJobNameById, CutJobLinks } from '../../CutJobLinks';
import { buildOrderFilmMaterialRows, buildOrderSheetMaterialRows } from '../../orderMaterialsSummary';
import { businessOrderDetails } from '../../../../utils/orderDetailRows';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryApi } from '../../../../api/inventoryApi';
import { featureFlags } from '../../../../config/featureFlags';
import { filmStockAvailability, ORDER_FILM_STOCK_REFRESH, orderFilmStockKey } from '../../../inventory/filmStock';

const { Text } = Typography;

export const OrderMaterialsTab: React.FC = () => {
  const { details, hdfDetails, header } = useOrderFormStore();
  const inventoryViewAllowed = featureFlags.inventory && can('inventory.view');
  const stockEnabled = inventoryViewAllowed && Number.isInteger(header.order_id) && (header.order_id ?? 0) > 0;
  const filmStockQuery = useQuery({
    queryKey: orderFilmStockKey(header.order_id),
    queryFn: () => inventoryApi.orderFilmStock(header.order_id!),
    enabled: stockEnabled,
    ...ORDER_FILM_STOCK_REFRESH,
  });
  // «Обновить»: тот же ключ читает и таблица деталей — обновляются обе.
  const queryClient = useQueryClient();
  const refreshStock = () => queryClient.invalidateQueries({ queryKey: orderFilmStockKey(header.order_id) });
  const stockUpdatedAt = filmStockQuery.dataUpdatedAt > 0
    ? new Date(filmStockQuery.dataUpdatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  const stockByFilmId = useMemo(
    () => new Map((filmStockQuery.data?.items ?? []).map((item) => [item.filmId, item])),
    [filmStockQuery.data],
  );
  const businessDetails = useMemo(
    () => businessOrderDetails(details),
    [details],
  );
  const detailIds = useMemo(
    () => businessDetails.map((detail) => detail.detail_id).filter((id): id is number => Number.isInteger(id) && id > 0),
    [businessDetails],
  );
  const cutViewAllowed = can('cut.view');
  const cutJobMaps = useCutDetailLastReady({
    enabled: cutViewAllowed,
    detailIds,
    orderId: header.order_id ?? null,
  });
  const { bathCutJobByDetailId } = cutJobMaps;
  const latestCutJobIds = useMemo(
    () => [...new Set([...bathCutJobByDetailId.values()].map((ref) => ref.cutJobId))].sort((a, b) => a - b),
    [bathCutJobByDetailId],
  );
  const latestCutJobIdsKey = latestCutJobIds.join(',');
  const cutJobReadGuard = useOrderAsyncReadGuard(
    `materials:${header.order_id ?? 'unsaved'}:${latestCutJobIdsKey}`,
  );
  const cutJobsScopeKey = `${cutJobReadGuard.authNamespace}|order:${header.order_id ?? 'unsaved'}|jobs:${latestCutJobIdsKey}`;
  const [cutJobsState, setCutJobsState] = useState<{
    scopeKey: string;
    jobs: CutJobDto[];
    loading: boolean;
  }>(() => ({ scopeKey: cutJobsScopeKey, jobs: [], loading: false }));
  const cutJobs = cutJobsState.scopeKey === cutJobsScopeKey
    ? cutJobsState.jobs
    : [];
  const cutJobsLoading = cutJobsState.scopeKey === cutJobsScopeKey && cutJobsState.loading;

  // Загружаем справочники — gate: skip when no detail carries a legacy material_id (Variant B normal case)
  const hasLegacyMaterialIds = businessDetails.some((d) => d.material_id != null);
  const { data: materialsData } = useList({
    resource: 'materials',
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: hasLegacyMaterialIds },
  });

  // Активные и неактивные: у старых заказов плёнка могла стать объединённым дублем.
  const { data: filmsData } = useList({
    resource: 'films',
    pagination: { pageSize: 10000 },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
  });

  // Создаем lookup maps
  const materialsMap = useMemo(() => {
    const map: Record<number, string> = {};
    (materialsData?.data || []).forEach((m: any) => {
      map[m.material_id] = m.material_name;
    });
    return map;
  }, [materialsData]);

  const filmsMap = useMemo(() => {
    const map: Record<number, string> = {};
    (filmsData?.data || []).forEach((f: any) => {
      map[f.film_id] = f.film_name;
    });
    return map;
  }, [filmsData]);

  const filmNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const [id, name] of Object.entries(filmsMap)) {
      map.set(Number(id), name);
    }
    return map;
  }, [filmsMap]);

  useEffect(() => {
    let cancelled = false;
    if (!cutJobReadGuard.active) {
      return () => {
        cancelled = true;
      };
    }
    if (!cutViewAllowed || latestCutJobIds.length === 0) {
      setCutJobsState({ scopeKey: cutJobsScopeKey, jobs: [], loading: false });
      return () => {
        cancelled = true;
      };
    }
    const token = cutJobReadGuard.capture();
    if (!token) return undefined;
    setCutJobsState({ scopeKey: cutJobsScopeKey, jobs: [], loading: true });
    Promise.all(
      latestCutJobIds.map(async (cutJobId) => {
        try {
          return await cutApi.get(cutJobId);
        } catch {
          return null;
        }
      }),
    ).then((jobs) => {
      if (!cancelled && cutJobReadGuard.isCurrent(token)) {
        setCutJobsState({
          scopeKey: cutJobsScopeKey,
          jobs: jobs.filter((job): job is CutJobDto => job !== null),
          loading: false,
        });
      }
    }).finally(() => {
      if (!cancelled && cutJobReadGuard.isCurrent(token)) {
        setCutJobsState((current) => (
          current.scopeKey === cutJobsScopeKey
            ? { ...current, loading: false }
            : current
        ));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    cutJobReadGuard.active,
    cutJobReadGuard.capture,
    cutJobReadGuard.isCurrent,
    cutJobsScopeKey,
    cutViewAllowed,
    latestCutJobIds,
    latestCutJobIdsKey,
  ]);

  const bathFilmUsage = useMemo(
    () => computeOrderBathFilmUsage(businessDetails, cutJobs, filmNameById),
    [businessDetails, cutJobs, filmNameById],
  );
  const cutJobNameById = useMemo(() => buildCutJobNameById(cutJobs), [cutJobs]);
  const filmMaterialRows = useMemo(
    () => buildOrderFilmMaterialRows(businessDetails, bathFilmUsage, filmNameById),
    [bathFilmUsage, businessDetails, filmNameById],
  );
  const sheetMaterialRows = useMemo(
    () => buildOrderSheetMaterialRows(
      businessDetails,
      (detail) => resolveDetailMaterialName(detail, undefined, materialsMap),
      hdfDetails,
    ),
    [businessDetails, hdfDetails, materialsMap],
  );

  const sheetMaterialColumns = [
    {
      title: 'Материал',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Кол-во м²',
      dataIndex: 'totalArea',
      key: 'totalArea',
      align: 'right' as const,
      render: (value: number) => formatNumber(value, 2),
    },
    {
      title: 'Кол-во деталей',
      dataIndex: 'detailsCount',
      key: 'detailsCount',
      align: 'center' as const,
    },
  ];

  const filmMaterialColumns = [
    {
      title: 'Пленка',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Кол-во м²',
      dataIndex: 'totalArea',
      key: 'totalArea',
      align: 'right' as const,
      render: (value: number) => formatNumber(value, 2),
    },
    {
      title: 'Кол-во деталей',
      dataIndex: 'detailsCount',
      key: 'detailsCount',
      align: 'center' as const,
    },
    {
      title: 'Пог. м',
      dataIndex: 'bathLinearMeters',
      key: 'bathLinearMeters',
      align: 'right' as const,
      render: (value: number) => value > 0 ? formatNumber(value, 1) : '—',
    },
    {
      title: 'Листы',
      dataIndex: 'bathSheets',
      key: 'bathSheets',
      align: 'center' as const,
      render: (value: number) => value > 0 ? value : '—',
    },
    {
      title: 'Раскрои',
      dataIndex: 'cutJobIds',
      key: 'cutJobIds',
      render: (value: number[]) => (
        <CutJobLinks cutJobIds={value} cutJobNameById={cutJobNameById} />
      ),
    },
    ...(inventoryViewAllowed ? [
      {
        title: 'На складе, пог. м',
        key: 'stockLm',
        align: 'right' as const,
        render: (_: unknown, row: (typeof filmMaterialRows)[number]) => {
          const item = row.filmId === null ? undefined : stockByFilmId.get(row.filmId);
          return item?.stockLm == null ? '—' : formatNumber(item.stockLm, 2);
        },
      },
      {
        title: 'Хватает',
        key: 'stockStatus',
        render: (_: unknown, row: (typeof filmMaterialRows)[number]) => filmStockAvailability(row.filmId === null ? undefined : stockByFilmId.get(row.filmId)?.status),
      },
    ] : []),
  ];

  return (
    <div style={{ padding: '16px 0' }}>
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ fontSize: 14 }}>
          Материалы заказа
        </Text>
      </div>
      <Row gutter={24}>
        <Col xs={24} lg={12}>
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ fontSize: 14 }}>
              Пленка
            </Text>
            {inventoryViewAllowed && <div><Space size={8} wrap>
              <Text type="secondary">Остаток на складе, без резерва{stockUpdatedAt ? ` · обновлено в ${stockUpdatedAt}` : ''}</Text>
              {stockEnabled
                ? <Button size="small" loading={filmStockQuery.isFetching} onClick={() => void refreshStock()}>Обновить остатки</Button>
                : <Text type="secondary">· появится после сохранения заказа</Text>}
              {filmStockQuery.isError && <Text type="danger">не удалось получить остатки</Text>}
            </Space></div>}
          </div>
          <Table
            dataSource={filmMaterialRows}
            columns={filmMaterialColumns}
            rowKey="key"
            size="small"
            pagination={false}
            bordered
            loading={cutJobsLoading}
            scroll={{ x: inventoryViewAllowed ? 900 : 680 }}
            locale={{
              emptyText: cutViewAllowed ? 'Нет данных по пленке' : 'Нет доступа к данным раскроя',
            }}
            summary={(data) => {
              const totalArea = data.reduce((sum, item) => sum + item.totalArea, 0);
              const totalDetails = data.reduce((sum, item) => sum + item.detailsCount, 0);
              const totalMeters = data.reduce((sum, item) => sum + item.bathLinearMeters, 0);
              const totalSheets = data.reduce((sum, item) => sum + item.bathSheets, 0);

              return (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}>
                    <Text strong style={{ fontSize: '1.1em' }}>Итого:</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <Text strong style={{ fontSize: '1.1em' }}>{formatNumber(totalArea, 2)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="center">
                    <Text strong style={{ fontSize: '1.1em' }}>{totalDetails}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">
                    <Text strong style={{ fontSize: '1.1em' }}>{totalMeters > 0 ? formatNumber(totalMeters, 1) : '—'}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="center">
                    <Text strong style={{ fontSize: '1.1em' }}>{totalSheets > 0 ? totalSheets : '—'}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} />
                  {inventoryViewAllowed && <><Table.Summary.Cell index={6} /><Table.Summary.Cell index={7} /></>}
                </Table.Summary.Row>
              );
            }}
          />
        </Col>

        <Col xs={24} lg={12}>
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ fontSize: 14 }}>
              Листовые материалы
            </Text>
          </div>
          <Table
            dataSource={sheetMaterialRows}
            columns={sheetMaterialColumns}
            rowKey="key"
            size="small"
            pagination={false}
            bordered
            locale={{
              emptyText: 'Нет данных по листовым материалам',
            }}
            summary={(data) => {
              const totalArea = data.reduce((sum, item) => sum + item.totalArea, 0);
              const totalDetails = data.reduce((sum, item) => sum + item.detailsCount, 0);

              return (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}>
                    <Text strong style={{ fontSize: '1.1em' }}>Итого:</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <Text strong style={{ fontSize: '1.1em' }}>{formatNumber(totalArea, 2)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="center">
                    <Text strong style={{ fontSize: '1.1em' }}>{totalDetails}</Text>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              );
            }}
          />
        </Col>
      </Row>
    </div>
  );
};

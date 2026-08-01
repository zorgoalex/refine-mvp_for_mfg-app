// Order Materials Tab
// Displays aggregated data for materials and films

import React, { useEffect, useMemo, useState } from 'react';
import { Row, Col, Table, Typography } from 'antd';
import { useList } from '@refinedev/core';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { resolveDetailMaterialName } from '../../../../utils/materialDisplayName';
import { calculateOrderTotalArea } from '../../../../utils/orderArea';
import type { OrderDetail } from '../../../../types/orders';
import { can } from '../../../../utils/permissions';
import { cutApi } from '../../../../api/cutApi';
import type { CutJobDto } from '../../../../api/types/cutApi.types';
import { useCutDetailLastReady } from '../../useCutDetailLastReady';
import { computeOrderBathFilmUsage, formatFilmLinearMeters } from '../../../cut/cutFilmUsage';

const { Text } = Typography;

interface MaterialAggregation {
  id: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  areaDetails: OrderDetail[];
}

interface FilmAggregation {
  id: number;
  name: string;
  totalArea: number;
  detailsCount: number;
  areaDetails: OrderDetail[];
}

export const OrderMaterialsTab: React.FC = () => {
  const { details, header } = useOrderFormStore();
  const detailIds = useMemo(
    () => details.map((detail) => detail.detail_id).filter((id): id is number => Number.isInteger(id) && id > 0),
    [details],
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
  const [cutJobs, setCutJobs] = useState<CutJobDto[]>([]);
  const [cutJobsLoading, setCutJobsLoading] = useState(false);

  // Загружаем справочники — gate: skip when no detail carries a legacy material_id (Variant B normal case)
  const hasLegacyMaterialIds = details.some((d) => d.material_id != null);
  const { data: materialsData } = useList({
    resource: 'materials',
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: hasLegacyMaterialIds },
  });

  const { data: filmsData } = useList({
    resource: 'films',
    pagination: { pageSize: 10000 },
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
    if (!cutViewAllowed || latestCutJobIds.length === 0) {
      setCutJobs([]);
      setCutJobsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setCutJobsLoading(true);
    Promise.all(
      latestCutJobIds.map(async (cutJobId) => {
        try {
          return await cutApi.get(cutJobId);
        } catch {
          return null;
        }
      }),
    ).then((jobs) => {
      if (!cancelled) setCutJobs(jobs.filter((job): job is CutJobDto => job !== null));
    }).finally(() => {
      if (!cancelled) setCutJobsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cutViewAllowed, latestCutJobIds, latestCutJobIdsKey]);

  // Агрегация по материалам
  const materialsAggregation = useMemo(() => {
    const aggregation: Record<number, MaterialAggregation> = {};

    details.forEach((detail) => {
      const sheetTypeId = detail.sheet_material_type_id;
      if (!sheetTypeId) return;

      if (!aggregation[sheetTypeId]) {
        aggregation[sheetTypeId] = {
          id: sheetTypeId,
          name:
            resolveDetailMaterialName(detail, undefined, materialsMap) ||
            `ID: ${sheetTypeId}`,
          totalArea: 0,
          detailsCount: 0,
          areaDetails: [],
        };
      }

      aggregation[sheetTypeId].areaDetails.push(detail);
      aggregation[sheetTypeId].detailsCount += 1;
    });

    return Object.values(aggregation)
      .map((item) => ({ ...item, totalArea: calculateOrderTotalArea(item.areaDetails) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [details, materialsMap]);

  // Агрегация по пленкам
  const filmsAggregation = useMemo(() => {
    const aggregation: Record<number, FilmAggregation> = {};

    details.forEach((detail) => {
      const filmId = detail.film_id;
      if (!filmId) return;

      if (!aggregation[filmId]) {
        aggregation[filmId] = {
          id: filmId,
          name: filmsMap[filmId] || `ID: ${filmId}`,
          totalArea: 0,
          detailsCount: 0,
          areaDetails: [],
        };
      }

      aggregation[filmId].areaDetails.push(detail);
      aggregation[filmId].detailsCount += 1;
    });

    return Object.values(aggregation)
      .map((item) => ({ ...item, totalArea: calculateOrderTotalArea(item.areaDetails) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [details, filmsMap]);

  const bathFilmUsage = useMemo(
    () => computeOrderBathFilmUsage(details, cutJobs, filmNameById),
    [cutJobs, details, filmNameById],
  );

  const materialsColumns = [
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

  const filmsColumns = [
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
  ];

  const bathFilmUsageColumns = [
    {
      title: 'Пленка',
      dataIndex: 'filmName',
      key: 'filmName',
      render: (value: string | null) => value?.trim() || 'Пленка не указана',
    },
    {
      title: 'Пог. м',
      dataIndex: 'linearMeters',
      key: 'linearMeters',
      align: 'right' as const,
      render: (value: number) => formatFilmLinearMeters(value),
    },
    {
      title: 'Листы',
      dataIndex: 'sheets',
      key: 'sheets',
      align: 'center' as const,
    },
    {
      title: 'Раскрои',
      dataIndex: 'cutJobIds',
      key: 'cutJobIds',
      render: (value: number[]) => value.map((id) => `#${id}`).join(', '),
    },
  ];

  return (
    <div style={{ padding: '16px 0' }}>
      <Row gutter={24}>
        {/* Таблица материалов */}
        <Col span={12}>
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ fontSize: 14 }}>
              Расчет материалов
            </Text>
          </div>
          <Table
            dataSource={materialsAggregation}
            columns={materialsColumns}
            rowKey="id"
            size="small"
            pagination={false}
            bordered
            locale={{
              emptyText: 'Нет данных по материалам',
            }}
            summary={(data) => {
              const totalArea = calculateOrderTotalArea(details.filter((detail) => detail.sheet_material_type_id != null));
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

        {/* Таблица пленок */}
        <Col span={12}>
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ fontSize: 14 }}>
              Расчет пленок
            </Text>
          </div>
          <Table
            dataSource={filmsAggregation}
            columns={filmsColumns}
            rowKey="id"
            size="small"
            pagination={false}
            bordered
            locale={{
              emptyText: 'Нет данных по пленкам',
            }}
            summary={(data) => {
              const totalArea = calculateOrderTotalArea(details.filter((detail) => detail.film_id != null));
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
      <div style={{ marginTop: 24 }}>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ fontSize: 14 }}>
            Материалы по раскрою ванны
          </Text>
        </div>
        <Table
          dataSource={bathFilmUsage}
          columns={bathFilmUsageColumns}
          rowKey={(row) => row.filmId ?? row.filmName ?? 'no-film'}
          size="small"
          pagination={false}
          bordered
          loading={cutJobsLoading}
          locale={{
            emptyText: cutViewAllowed ? 'Нет данных по раскрою ванны' : 'Нет доступа к данным раскроя',
          }}
          summary={(data) => {
            const totalMeters = data.reduce((sum, item) => sum + item.linearMeters, 0);
            const totalSheets = data.reduce((sum, item) => sum + item.sheets, 0);

            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}>
                  <Text strong style={{ fontSize: '1.1em' }}>Итого:</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <Text strong style={{ fontSize: '1.1em' }}>{formatFilmLinearMeters(totalMeters)}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="center">
                  <Text strong style={{ fontSize: '1.1em' }}>{totalSheets}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} />
              </Table.Summary.Row>
            );
          }}
        />
      </div>
    </div>
  );
};

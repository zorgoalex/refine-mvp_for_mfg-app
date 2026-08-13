import { Table } from '../../../../ui/tooltipDelay';
// Order Materials Tab
// Displays aggregated data for materials and films

import React, { useEffect, useMemo, useState } from 'react';
import { Row, Col, Typography } from 'antd';
import { useList } from '@refinedev/core';
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

const { Text } = Typography;

export const OrderMaterialsTab: React.FC = () => {
  const { details, hdfDetails, header } = useOrderFormStore();
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

  const bathFilmUsage = useMemo(
    () => computeOrderBathFilmUsage(details, cutJobs, filmNameById),
    [cutJobs, details, filmNameById],
  );
  const cutJobNameById = useMemo(() => buildCutJobNameById(cutJobs), [cutJobs]);
  const filmMaterialRows = useMemo(
    () => buildOrderFilmMaterialRows(details, bathFilmUsage, filmNameById),
    [bathFilmUsage, details, filmNameById],
  );
  const sheetMaterialRows = useMemo(
    () => buildOrderSheetMaterialRows(
      details,
      (detail) => resolveDetailMaterialName(detail, undefined, materialsMap),
      hdfDetails,
    ),
    [details, hdfDetails, materialsMap],
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
          </div>
          <Table
            dataSource={filmMaterialRows}
            columns={filmMaterialColumns}
            rowKey="key"
            size="small"
            pagination={false}
            bordered
            loading={cutJobsLoading}
            scroll={{ x: 680 }}
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

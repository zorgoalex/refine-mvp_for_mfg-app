// Order Materials Tab
// Displays aggregated data for materials and films

import React, { useMemo } from 'react';
import { Row, Col, Table, Typography } from 'antd';
import { useList } from '@refinedev/core';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';

const { Text } = Typography;

interface MaterialAggregation {
  id: number;
  name: string;
  totalArea: number;
  detailsCount: number;
}

interface FilmAggregation {
  id: number;
  name: string;
  totalArea: number;
  detailsCount: number;
}

export const OrderMaterialsTab: React.FC = () => {
  const { details } = useOrderFormStore();

  // Загружаем справочники
  const { data: materialsData } = useList({
    resource: 'materials',
    pagination: { pageSize: 10000 },
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

  // Агрегация по материалам
  const materialsAggregation = useMemo(() => {
    const aggregation: Record<number, MaterialAggregation> = {};

    details.forEach((detail) => {
      const materialId = detail.material_id;
      if (!materialId) return;

      const area = detail.area || 0;

      if (!aggregation[materialId]) {
        aggregation[materialId] = {
          id: materialId,
          name: materialsMap[materialId] || `ID: ${materialId}`,
          totalArea: 0,
          detailsCount: 0,
        };
      }

      aggregation[materialId].totalArea += area;
      aggregation[materialId].detailsCount += 1;
    });

    return Object.values(aggregation).sort((a, b) => a.name.localeCompare(b.name));
  }, [details, materialsMap]);

  // Агрегация по пленкам
  const filmsAggregation = useMemo(() => {
    const aggregation: Record<number, FilmAggregation> = {};

    details.forEach((detail) => {
      const filmId = detail.film_id;
      if (!filmId) return;

      const area = detail.area || 0;

      if (!aggregation[filmId]) {
        aggregation[filmId] = {
          id: filmId,
          name: filmsMap[filmId] || `ID: ${filmId}`,
          totalArea: 0,
          detailsCount: 0,
        };
      }

      aggregation[filmId].totalArea += area;
      aggregation[filmId].detailsCount += 1;
    });

    return Object.values(aggregation).sort((a, b) => a.name.localeCompare(b.name));
  }, [details, filmsMap]);

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

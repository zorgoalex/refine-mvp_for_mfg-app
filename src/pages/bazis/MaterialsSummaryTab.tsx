import React, { useEffect, useState } from 'react';
import { Alert, Col, Descriptions, Row, Space, Spin, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { bazisApi } from '../../api/bazisApi';
import type {
  BazisHardwareSummary,
  BazisPanelsMaterialSummary,
  BazisRawMaterialUsage,
  BazisRevisionMaterialsSummary,
} from '../../api/types/bazisApi.types';

interface MaterialsSummaryTabProps {
  revisionId: number;
}

const panelColumns: ColumnsType<BazisPanelsMaterialSummary> = [
  {
    title: 'Материал',
    dataIndex: 'materialName',
    key: 'materialName',
    render: (value: string | null) => value ?? '—',
  },
  {
    title: 'Маппинг',
    dataIndex: 'mappingTargetKind',
    key: 'mappingTargetKind',
    width: 170,
    render: renderPanelMappingTag,
  },
  {
    title: 'Панелей',
    dataIndex: 'panelCount',
    key: 'panelCount',
    width: 120,
  },
  {
    title: 'Кол-во',
    dataIndex: 'totalQuantity',
    key: 'totalQuantity',
    width: 120,
  },
  {
    title: 'Площадь, м²',
    dataIndex: 'totalAreaM2',
    key: 'totalAreaM2',
    width: 140,
    render: (value: number) => value.toFixed(2),
  },
];

const hardwareColumns: ColumnsType<BazisHardwareSummary> = [
  {
    title: 'Наименование',
    dataIndex: 'name',
    key: 'name',
    render: (value: string | null) => value ?? '—',
  },
  {
    title: 'Кол-во',
    dataIndex: 'totalQuantity',
    key: 'totalQuantity',
    width: 120,
  },
];

const rawMaterialColumns: ColumnsType<BazisRawMaterialUsage> = [
  {
    title: 'Наименование',
    dataIndex: 'name',
    key: 'name',
  },
  {
    title: 'Вхождений',
    dataIndex: 'usageCount',
    key: 'usageCount',
    width: 120,
  },
];

export const MaterialsSummaryTab: React.FC<MaterialsSummaryTabProps> = ({ revisionId }) => {
  const [data, setData] = useState<BazisRevisionMaterialsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadSummary = async () => {
      setLoading(true);
      setErrorText(null);
      try {
        const response = await bazisApi.getMaterialsSummary(revisionId);
        if (!cancelled) {
          setData(response);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить сводку материалов');
          setData(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSummary();

    return () => {
      cancelled = true;
    };
  }, [revisionId]);

  if (errorText) {
    return <Alert type="warning" showIcon message={errorText} />;
  }

  if (loading || data == null) {
    return <Spin />;
  }

  const summary = data.summary;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="Всего узлов">{summary.totalNodes ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Панелей">{summary.panels ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Фурнитуры">{summary.hardware ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Сборок">{summary.assemblies ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Блоков">{summary.blocks ?? 0}</Descriptions.Item>
        <Descriptions.Item label="Уникальных материалов">{summary.uniqueMaterials ?? 0}</Descriptions.Item>
      </Descriptions>

      <Table<BazisPanelsMaterialSummary>
        rowKey={(record) => `${record.materialName ?? 'empty'}-${record.mappingTargetKind ?? 'null'}`}
        title={() => 'Панели по материалам'}
        size="small"
        pagination={data.panelsByMaterial.length <= 50 ? false : { pageSize: 50 }}
        columns={panelColumns}
        dataSource={data.panelsByMaterial}
        locale={{ emptyText: 'Нет данных' }}
      />

      <Table<BazisHardwareSummary>
        rowKey={(record) => record.name ?? 'empty'}
        title={() => 'Фурнитура'}
        size="small"
        pagination={data.hardwareByName.length <= 50 ? false : { pageSize: 50 }}
        columns={hardwareColumns}
        dataSource={data.hardwareByName}
        locale={{ emptyText: 'Нет данных' }}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Table<BazisRawMaterialUsage>
            rowKey={(record) => record.name}
            title={() => 'Кромки'}
            size="small"
            pagination={data.edgesByName.length <= 50 ? false : { pageSize: 50 }}
            columns={rawMaterialColumns}
            dataSource={data.edgesByName}
            locale={{ emptyText: 'Нет данных' }}
          />
        </Col>
        <Col xs={24} md={12}>
          <Table<BazisRawMaterialUsage>
            rowKey={(record) => record.name}
            title={() => 'Плёнки'}
            size="small"
            pagination={data.filmsByName.length <= 50 ? false : { pageSize: 50 }}
            columns={rawMaterialColumns}
            dataSource={data.filmsByName}
            locale={{ emptyText: 'Нет данных' }}
          />
        </Col>
      </Row>
    </Space>
  );
};

function renderPanelMappingTag(value: string | null): React.ReactNode {
  if (value === 'sheet') {
    return <Tag color="green">лист</Tag>;
  }

  if (value === 'ignore') {
    return <Tag>игнор</Tag>;
  }

  if (value == null) {
    return <Tag color="red">не сопоставлен</Tag>;
  }

  return <Tag>{value}</Tag>;
}

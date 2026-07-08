import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Collapse, Descriptions, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { bazisApi } from '../../api/bazisApi';
import type { BazisNodeCard as BazisNodeCardData, BazisNodeOrderLink } from '../../api/types/bazisApi.types';
import { parseNodeRaw, type RawEdgeEntry, type RawFaceEntry, type RawKeyValue } from './parseNodeRaw';

const { Text } = Typography;

interface NodeCardProps {
  nodeId: number | null;
}

interface KeyValueRow {
  key: string;
  parameter: string;
  value: string;
}

const keyValueColumns: ColumnsType<KeyValueRow> = [
  {
    title: 'Параметр',
    dataIndex: 'parameter',
    key: 'parameter',
    width: '40%',
  },
  {
    title: 'Значение',
    dataIndex: 'value',
    key: 'value',
  },
];

export const NodeCard: React.FC<NodeCardProps> = ({ nodeId }) => {
  const [card, setCard] = useState<BazisNodeCardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (nodeId == null) {
      setCard(null);
      setErrorText(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadCard = async () => {
      setLoading(true);
      setErrorText(null);
      setCard(null);
      try {
        const response = await bazisApi.getNodeCard(nodeId);
        if (!cancelled) {
          setCard(response);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить карточку узла');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadCard();

    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const sections = useMemo(() => (
    card ? parseNodeRaw(card.rawJson) : null
  ), [card]);

  if (nodeId == null) {
    return <Empty description="Выберите узел в дереве" />;
  }

  if (errorText) {
    return <Alert type="warning" showIcon message={errorText} />;
  }

  if (loading || card == null || sections == null) {
    return <Spin />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="Тип">{card.objectType ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Вид узла">{card.nodeKind || '—'}</Descriptions.Item>
        <Descriptions.Item label="Наименование">{card.name ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Обозначение">{card.designation ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Позиция">{card.position ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Код детали">{card.detailCode ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Кол-во">{formatNumber(card.quantity)}</Descriptions.Item>
        <Descriptions.Item label="Кол-во с учётом вхождений">{formatNumber(card.cumulativeQuantity)}</Descriptions.Item>
        <Descriptions.Item label="Длина">{formatMillimeters(card.lengthMm)}</Descriptions.Item>
        <Descriptions.Item label="Ширина">{formatMillimeters(card.widthMm)}</Descriptions.Item>
        <Descriptions.Item label="Высота">{formatMillimeters(card.heightMm)}</Descriptions.Item>
        <Descriptions.Item label="Толщина">{formatMillimeters(card.thicknessMm)}</Descriptions.Item>
        <Descriptions.Item label="Цена">{formatNumber(card.price)}</Descriptions.Item>
        <Descriptions.Item label="Прямоугольная">{formatBoolean(card.isRectangular)}</Descriptions.Item>
        <Descriptions.Item label="Ориентация текстуры">{card.textureOrientation ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Материал">{card.mainMaterialName ?? '—'}</Descriptions.Item>
      </Descriptions>

      {card.orderLinks.length > 0 ? (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Text strong>Заказы</Text>
          <Space wrap>
            {card.orderLinks.map((link) => (
              <Space key={`${link.orderId}-${link.orderDetailId ?? 'none'}-${link.mappingKind}`} size="small">
                <Link to={`/orders/show/${link.orderId}`}>#{link.orderId}</Link>
                {renderOrderTag(link)}
              </Space>
            ))}
          </Space>
        </Space>
      ) : null}

      <Collapse>
        <Collapse.Panel key="edges" header={`Кромки (${sections.edges.length})`}>
          {renderGroupedSideEntries(sections.edges, 'Сторона')}
        </Collapse.Panel>
        <Collapse.Panel key="faces" header={`Пласти (${sections.faces.length})`}>
          {renderGroupedSideEntries(sections.faces, 'Сторона')}
        </Collapse.Panel>
        <Collapse.Panel key="holes" header={`Отверстия (${sections.holes.length})`}>
          {renderIndexedTables(sections.holes, 'Отверстие')}
        </Collapse.Panel>
        <Collapse.Panel key="properties" header={`Свойства (${sections.properties.length})`}>
          {renderSingleTable(sections.properties)}
        </Collapse.Panel>
        <Collapse.Panel key="operations" header={`Операции (${sections.operations.length})`}>
          {renderIndexedTables(sections.operations, 'Операция')}
        </Collapse.Panel>
        <Collapse.Panel key="scalars" header={`Прочее (raw, ${sections.scalars.length})`}>
          {renderSingleTable(sections.scalars)}
        </Collapse.Panel>
      </Collapse>
    </Space>
  );
};

function renderOrderTag(link: BazisNodeOrderLink): React.ReactNode {
  if (link.mappingKind === 'created') {
    return <Tag color="green">создан</Tag>;
  }

  if (link.mappingKind === 'ignored') {
    return <Tag>игнор</Tag>;
  }

  if (link.mappingKind === 'manual') {
    return <Tag color="blue">вручную</Tag>;
  }

  return <Tag>{link.mappingKind}</Tag>;
}

function renderGroupedSideEntries(
  entries: Array<RawEdgeEntry | RawFaceEntry>,
  titlePrefix: string,
): React.ReactNode {
  if (entries.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных" />;
  }

  const bySide = new Map<number, RawKeyValue[][]>();
  entries.forEach((entry) => {
    const current = bySide.get(entry.side) ?? [];
    current.push(entry.fields);
    bySide.set(entry.side, current);
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {Array.from(bySide.entries())
        .sort(([left], [right]) => left - right)
        .map(([side, sideEntries]) => (
          <Space key={side} direction="vertical" size="small" style={{ width: '100%' }}>
            <Text strong>{`${titlePrefix} ${side}`}</Text>
            {sideEntries.map((fields, index) => (
              <Table<KeyValueRow>
                key={`${side}-${index}`}
                size="small"
                pagination={false}
                columns={keyValueColumns}
                dataSource={toTableRows(fields, `${side}-${index}`)}
                locale={{ emptyText: 'Нет данных' }}
              />
            ))}
          </Space>
        ))}
    </Space>
  );
}

function renderIndexedTables(entries: RawKeyValue[][], titlePrefix: string): React.ReactNode {
  if (entries.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных" />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {entries.map((fields, index) => (
        <Space key={`${titlePrefix}-${index + 1}`} direction="vertical" size="small" style={{ width: '100%' }}>
          <Text strong>{`${titlePrefix} ${index + 1}`}</Text>
          <Table<KeyValueRow>
            size="small"
            pagination={false}
            columns={keyValueColumns}
            dataSource={toTableRows(fields, `${titlePrefix}-${index}`)}
            locale={{ emptyText: 'Нет данных' }}
          />
        </Space>
      ))}
    </Space>
  );
}

function renderSingleTable(fields: RawKeyValue[]): React.ReactNode {
  if (fields.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет данных" />;
  }

  return (
    <Table<KeyValueRow>
      size="small"
      pagination={false}
      columns={keyValueColumns}
      dataSource={toTableRows(fields, 'single')}
      locale={{ emptyText: 'Нет данных' }}
    />
  );
}

function toTableRows(fields: RawKeyValue[], prefix: string): KeyValueRow[] {
  return fields.map((field, index) => ({
    key: `${prefix}-${field.key}-${index}`,
    parameter: field.key,
    value: field.value || '—',
  }));
}

function formatBoolean(value: boolean | null): string {
  if (value == null) {
    return '—';
  }

  return value ? 'Да' : 'Нет';
}

function formatMillimeters(value: number | null): string {
  if (value == null) {
    return '—';
  }

  return `${formatNumberValue(value)} мм`;
}

function formatNumber(value: number | null): string {
  if (value == null) {
    return '—';
  }

  return formatNumberValue(value);
}

function formatNumberValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toLocaleString('ru-RU');
}

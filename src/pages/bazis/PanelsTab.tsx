// Главный экран Базис-проекта: панели ревизии (с любой глубины дерева),
// сгруппированные по материалу и размерам (уникальные позиции). Группа
// разворачивается как Excel-группировка: вложенные панели рендерятся детьми
// таблицы со сдвигом. Выбор панели раскрывает под списком её полную карточку
// (развёрнута по умолчанию) и спойлеры всех блоков/сборок, в которые она
// входит (свёрнуты; карточка предка грузится лениво при раскрытии).

import React, { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ApartmentOutlined } from '@ant-design/icons';
import { Button, Collapse, Empty, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { NodeCard } from './NodeCard';
import { groupPanelRows, type PanelGroupRow, type PanelLike } from './panelGrouping';
import { NODE_KIND_LABELS_RU, nodePathTitle, type RevisionData } from './useRevisionData';

const { Panel } = Collapse;
const { Text } = Typography;

interface PanelsTabProps {
  data: RevisionData;
  selectedId: number | null;
  onSelect: (nodeId: number | null) => void;
  onGoToTree: (nodeId: number) => void;
}

interface PanelChildRow extends PanelLike {
  rowType: 'panel';
  key: number;
}

interface PanelGroupTableRow extends Omit<PanelGroupRow, 'children'> {
  rowType: 'group';
  children: PanelChildRow[];
}

type PanelsTableRow = PanelGroupTableRow | PanelChildRow;

export const PanelsTab: React.FC<PanelsTabProps> = ({ data, selectedId, onSelect, onGoToTree }) => {
  const { nodes, byId, ancestorsOf } = data;
  const [expandedKeys, setExpandedKeys] = useState<readonly React.Key[]>([]);

  const groupRows = useMemo<PanelGroupTableRow[]>(() => {
    const panels: PanelLike[] = nodes
      .filter((node) => node.objectType === 'Панель')
      .map((node) => ({
        ...node,
        pathTitle: nodePathTitle(ancestorsOf(node.bazisNodeId)),
      }));
    return groupPanelRows(panels).map((group) => ({
      ...group,
      rowType: 'group' as const,
      children: group.children.map((panel) => ({
        ...panel,
        rowType: 'panel' as const,
        key: panel.bazisNodeId,
      })),
    }));
  }, [ancestorsOf, nodes]);

  const columns = useMemo<ColumnsType<PanelsTableRow>>(
    () => [
      {
        title: '№',
        key: 'seq',
        width: 70,
        render: (_, row) => (row.rowType === 'group' ? row.groupSeq : null),
      },
      {
        title: 'Размеры, мм',
        key: 'size',
        width: 150,
        render: (_, row) => formatSize(row),
      },
      {
        title: 'Кол-во',
        key: 'quantity',
        width: 80,
        render: (_, row) =>
          row.rowType === 'group' ? (
            <Text strong>{row.totalQuantity ?? '—'}</Text>
          ) : (
            row.quantity ?? row.cumulativeQuantity ?? '—'
          ),
      },
      {
        title: 'Материал',
        key: 'material',
        width: 210,
        render: (_, row) => row.mainMaterialName || '—',
      },
      {
        title: 'Наименование',
        key: 'name',
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? row.names.join(' / ') || '—' : row.name?.trim() || '—',
      },
      {
        title: 'Расположение',
        key: 'path',
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? (
            <Text type="secondary">{`вхождений: ${row.children.length}`}</Text>
          ) : (
            row.pathTitle
          ),
      },
      {
        title: 'Заказ',
        key: 'orders',
        width: 160,
        render: (_, row) =>
          row.orders.length > 0 ? (
            <Space wrap size={4}>
              {row.orders.map((order) => (
                <RouterLink
                  key={order.orderId}
                  to={`/orders/show/${order.orderId}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  {order.orderName?.trim() || `#${order.orderId}`}
                </RouterLink>
              ))}
            </Space>
          ) : (
            '—'
          ),
      },
      {
        title: '',
        key: 'actions',
        width: 56,
        render: (_, row) =>
          row.rowType === 'panel' ? (
            <Tooltip title="Показать в дереве">
              <Button
                type="text"
                size="small"
                icon={<ApartmentOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  onGoToTree(row.bazisNodeId);
                }}
              />
            </Tooltip>
          ) : null,
      },
    ],
    [onGoToTree],
  );

  if (groupRows.length === 0) {
    return <Empty description="В ревизии нет панелей" />;
  }

  const selectedAncestors = selectedId != null ? ancestorsOf(selectedId) : [];
  const selectedPanel = selectedId != null ? byId.get(selectedId) : null;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Table<PanelsTableRow>
        size="small"
        columns={columns}
        dataSource={groupRows}
        pagination={false}
        // ~10 строк по 39px + шапка; содержимое скроллится внутри блока
        scroll={{ y: 390 }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: setExpandedKeys,
          indentSize: 24,
        }}
        rowClassName={(row) =>
          row.rowType === 'panel' && row.bazisNodeId === selectedId ? 'ant-table-row-selected' : ''
        }
        onRow={(row) => ({
          onClick: () => {
            if (row.rowType === 'group') {
              // Клик по строке группы = развернуть/свернуть (как Excel-группировка)
              setExpandedKeys((keys) =>
                keys.includes(row.key) ? keys.filter((key) => key !== row.key) : [...keys, row.key],
              );
            } else {
              onSelect(row.bazisNodeId);
            }
          },
          style: { cursor: 'pointer' },
        })}
      />

      {selectedId != null && selectedPanel ? (
        // key: смена панели пересоздаёт Collapse — спойлеры возвращаются в свёрнутое
        // состояние, раскрыта только карточка самой панели
        <Collapse key={selectedId} defaultActiveKey={['panel']}>
          <Panel key="panel" header={`Панель: ${selectedPanel.name?.trim() || '—'}`}>
            <NodeCard nodeId={selectedId} />
          </Panel>
          {selectedAncestors.map((ancestor) => (
            <Panel
              key={ancestor.bazisNodeId}
              header={`${NODE_KIND_LABELS_RU[ancestor.nodeKind] ?? ancestor.nodeKind}: ${ancestor.name?.trim() || '—'}`}
            >
              <NodeCard nodeId={ancestor.bazisNodeId} />
            </Panel>
          ))}
        </Collapse>
      ) : (
        <Text type="secondary">Выберите панель в списке, чтобы посмотреть подробности.</Text>
      )}
    </Space>
  );
};

function formatSize(row: Pick<BazisTreeNode, 'lengthMm' | 'widthMm' | 'thicknessMm'>): string {
  const parts = [row.lengthMm, row.widthMm, row.thicknessMm]
    .map((value) => (value != null ? String(Math.round(value)) : null));
  if (parts[0] == null && parts[1] == null) {
    return '—';
  }
  return parts.filter(Boolean).join(' × ');
}

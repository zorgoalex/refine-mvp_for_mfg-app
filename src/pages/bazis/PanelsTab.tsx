// Главный экран Базис-проекта: панели ревизии (с любой глубины дерева).
// По умолчанию сгруппированы по материалу и размерам (уникальные позиции);
// чекбокс «Группировать» переключает на плоский список. Группа
// разворачивается как Excel-группировка: вложенные панели рендерятся детьми
// таблицы со сдвигом. Колонки Материал/Наименование/Изделие/Заказ имеют
// выпадающие мультиселект-фильтры. Выбор панели раскрывает под списком её полную
// карточку (развёрнута по умолчанию) и спойлеры всех блоков/сборок, в
// которые она входит (свёрнуты; карточка предка грузится лениво).

import React, { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ApartmentOutlined } from '@ant-design/icons';
import { Button, Checkbox, Collapse, Empty, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FilterDropdownProps } from 'antd/es/table/interface';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { NodeCard } from './NodeCard';
import {
  buildPanelFilterOptions,
  findGroupKeyByPanelId,
  groupPanelRows,
  panelComparators,
  panelFilterPredicate,
  PANEL_FILTER_NONE,
  summarizeVisibleRows,
  type PanelFilterField,
  type PanelFilterOption,
  type PanelGroupRow,
  type PanelLike,
} from './panelGrouping';
import {
  emptySelection,
  groupCheckState,
  pruneSelection,
  selectionSummary,
  toggleGroup,
  togglePanel,
  type PanelSelectionState,
} from './panelSelection';
import { NODE_KIND_LABELS_RU, nodePathTitle, type RevisionData } from './useRevisionData';
import './panels.css';

const { Panel } = Collapse;
const { Text } = Typography;

interface PanelsTabProps {
  data: RevisionData;
  bazisOrderNo: string | null;
  selectedId: number | null;
  /** Инкрементируется на каждый внешний goToPanel — форсирует авто-раскрытие
   * группы даже при повторной навигации на ту же панель. */
  focusToken: number;
  onSelect: (nodeId: number | null) => void;
  onGoToTree: (nodeId: number) => void;
}

interface PanelChildRow extends PanelLike {
  rowType: 'panel';
  key: number;
  /** Порядковый номер в плоском режиме (в группировке у детей номера нет). */
  flatSeq?: number;
}

interface PanelGroupTableRow extends Omit<PanelGroupRow, 'children'> {
  rowType: 'group';
  children: PanelChildRow[];
}

type PanelsTableRow = PanelGroupTableRow | PanelChildRow;

const BUSY_SELECTED_ROW_STYLE: React.CSSProperties = {
  backgroundColor: '#fff2e8',
};

const noop = () => {};

/** Кастомный выпадающий фильтр колонки: мультиселект значений + «Включить
 * все» / «Сбросить» / «Отключить все». Каждое действие применяется сразу
 * (confirm с closeDropdown: false) — список остаётся развёрнутым, в т.ч.
 * после «Отключить все» (пустой выбор в antd = фильтр выключен, поэтому
 * «ничего не показывать» кодируется сентинелом PANEL_FILTER_NONE). */
const PanelFilterDropdown: React.FC<FilterDropdownProps & { options: PanelFilterOption[] }> = ({
  options,
  selectedKeys,
  setSelectedKeys,
  confirm,
  clearFilters,
}) => {
  const checked = selectedKeys.filter((key) => key !== PANEL_FILTER_NONE).map(String);

  const apply = (keys: React.Key[]) => {
    setSelectedKeys(keys);
    confirm({ closeDropdown: false });
  };

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
      <Space size={4} wrap>
        <Button size="small" onClick={() => apply(options.map((option) => option.value))}>
          Включить все
        </Button>
        <Button
          size="small"
          onClick={() => {
            clearFilters?.();
            confirm({ closeDropdown: false });
          }}
        >
          Сбросить
        </Button>
        <Button size="small" onClick={() => apply([PANEL_FILTER_NONE])}>
          Отключить все
        </Button>
      </Space>
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {options.map((option) => (
          <Checkbox
            key={option.value}
            checked={checked.includes(option.value)}
            onChange={(event) => {
              const next = event.target.checked
                ? [...checked, option.value]
                : checked.filter((value) => value !== option.value);
              apply(next.length > 0 ? next : [PANEL_FILTER_NONE]);
            }}
          >
            {option.label}
          </Checkbox>
        ))}
      </div>
    </div>
  );
};

export const PanelsTab: React.FC<PanelsTabProps> = ({
  data,
  bazisOrderNo,
  selectedId,
  focusToken,
  onSelect,
  onGoToTree,
}) => {
  const { nodes, byId, ancestorsOf } = data;
  const [expandedKeys, setExpandedKeys] = useState<readonly React.Key[]>([]);
  const [grouped, setGrouped] = useState(true);
  const [selection, setSelection] = useState<PanelSelectionState>(() => emptySelection());
  const fallbackBazisOrderNo = normalizeText(bazisOrderNo);

  const panels = useMemo<PanelLike[]>(
    () =>
      nodes
        .filter((node) => node.objectType === 'Панель')
        .map((node) => {
          const ancestors = ancestorsOf(node.bazisNodeId);
          const rootAncestor = ancestors.at(-1) ?? null;
          return {
            ...node,
            pathTitle: nodePathTitle(ancestors),
            productName: normalizeText(rootAncestor?.name),
            productOrderNo: normalizeText(rootAncestor?.productOrderNo) ?? fallbackBazisOrderNo,
          };
        }),
    [ancestorsOf, fallbackBazisOrderNo, nodes],
  );

  const groupRows = useMemo<PanelGroupTableRow[]>(
    () =>
      groupPanelRows(panels).map((group) => ({
        ...group,
        rowType: 'group' as const,
        children: group.children.map((panel) => ({
          ...panel,
          rowType: 'panel' as const,
          key: panel.bazisNodeId,
        })),
      })),
    [panels],
  );

  const flatRows = useMemo<PanelChildRow[]>(
    () =>
      panels.map((panel, index) => ({
        ...panel,
        rowType: 'panel' as const,
        key: panel.bazisNodeId,
        flatSeq: index + 1,
      })),
    [panels],
  );

  const filterOptions = useMemo(() => buildPanelFilterOptions(panels), [panels]);
  const alivePanelIds = useMemo(() => new Set(panels.map((panel) => panel.bazisNodeId)), [panels]);
  const selectionStats = useMemo(() => selectionSummary(selection, groupRows), [groupRows, selection]);
  const selectionPossible = useMemo(
    () => groupRows.some((group) => group.children.some((panel) => panel.orders.length === 0)),
    [groupRows],
  );

  useEffect(() => {
    setSelection((current) => pruneSelection(current, alivePanelIds));
  }, [alivePanelIds]);

  // Выбор панели может прийти извне (goToPanel из вкладок Фурнитура/Операции/
  // Смета) — авто-раскрываем группу выбранной панели, иначе она останется
  // скрытой в свёрнутой группе. focusToken в deps: повторный goToPanel на ту же
  // панель после ручного сворачивания группы тоже должен её раскрыть.
  useEffect(() => {
    if (selectedId == null || !grouped) {
      return;
    }
    const groupKey = findGroupKeyByPanelId(groupRows, selectedId);
    if (groupKey != null) {
      setExpandedKeys((keys) => (keys.includes(groupKey) ? keys : [...keys, groupKey]));
    }
  }, [focusToken, grouped, groupRows, selectedId]);

  const columns = useMemo<ColumnsType<PanelsTableRow>>(() => {
    const filterProps = (field: PanelFilterField, options: PanelFilterOption[]) => ({
      filterDropdown: (props: FilterDropdownProps) => (
        <PanelFilterDropdown {...props} options={options} />
      ),
      onFilter: (value: string | number | boolean, row: PanelsTableRow) =>
        panelFilterPredicate(field, value, row),
    });

    return [
      {
        title: '',
        key: 'selection',
        width: 52,
        render: (_, row) => {
          if (row.rowType === 'group') {
            const state = groupCheckState(selection, row);
            const hasFreePanels = row.children.some((panel) => panel.orders.length === 0);
            const hasSelectedPanels = row.children.some((panel) => selection.selected.has(panel.bazisNodeId));
            return (
              <Checkbox
                checked={state === 'checked'}
                indeterminate={state === 'indeterminate'}
                disabled={!hasFreePanels && !hasSelectedPanels}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  setSelection((current) => toggleGroup(current, row, event.target.checked));
                }}
              />
            );
          }

          return (
            <Checkbox
              checked={selection.selected.has(row.bazisNodeId)}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                event.stopPropagation();
                setSelection((current) => togglePanel(current, row.bazisNodeId));
              }}
            />
          );
        },
      },
      {
        title: '№',
        key: 'seq',
        width: 70,
        sorter: panelComparators.seq,
        render: (_, row) => (row.rowType === 'group' ? row.groupSeq : row.flatSeq ?? null),
      },
      {
        title: 'Размеры, мм',
        key: 'size',
        width: 150,
        sorter: panelComparators.size,
        render: (_, row) => formatSize(row),
      },
      {
        title: 'Кол-во',
        key: 'quantity',
        width: 80,
        sorter: panelComparators.quantity,
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
        sorter: panelComparators.material,
        ...filterProps('material', filterOptions.materials),
        render: (_, row) => row.mainMaterialName || '—',
      },
      {
        title: 'Наименование',
        key: 'name',
        ellipsis: true,
        sorter: panelComparators.name,
        ...filterProps('name', filterOptions.names),
        render: (_, row) =>
          row.rowType === 'group' ? row.names.join(' / ') || '—' : row.name?.trim() || '—',
      },
      {
        title: 'Обозначение',
        key: 'designation',
        width: 180,
        ellipsis: true,
        sorter: panelComparators.designation,
        render: (_, row) =>
          row.rowType === 'group' ? row.designations.join(', ') || '—' : row.designation?.trim() || '—',
      },
      {
        title: 'Изделие',
        key: 'productName',
        width: 180,
        ellipsis: true,
        sorter: panelComparators.product,
        ...filterProps('productName', filterOptions.productNames),
        render: (_, row) =>
          row.rowType === 'group' ? row.productNames.join(', ') || '—' : row.productName || '—',
      },
      {
        title: 'Базис-заказ',
        key: 'productOrderNo',
        width: 160,
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? row.orderNos.join(', ') || '—' : row.productOrderNo || '—',
      },
      {
        title: 'Расположение',
        key: 'path',
        ellipsis: true,
        sorter: panelComparators.location,
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
        sorter: panelComparators.order,
        ...filterProps('order', filterOptions.orders),
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
    ];
  }, [filterOptions, onGoToTree, selection]);

  if (groupRows.length === 0) {
    return <Empty description="В ревизии нет панелей" />;
  }

  const selectedAncestors = selectedId != null ? ancestorsOf(selectedId) : [];
  const selectedPanel = selectedId != null ? byId.get(selectedId) : null;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space size="middle" align="center" wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Checkbox checked={grouped} onChange={(event) => setGrouped(event.target.checked)}>
          Группировать
        </Checkbox>
        {selectionPossible ? (
          <Space size="middle" wrap>
            <Text>
              Выбрано: {selectionStats.positions} позиций / {selectionStats.panels} панелей
              {selectionStats.excludedBusy > 0 ? ` (исключено ${selectionStats.excludedBusy} — уже в заказе)` : ''}
            </Text>
            <Button disabled={selectionStats.panels === 0} onClick={noop}>
              В новый заказ
            </Button>
            <Button disabled={selectionStats.panels === 0} onClick={noop}>
              В существующий заказ
            </Button>
          </Space>
        ) : null}
      </Space>

      <Table<PanelsTableRow>
        className="bazis-panels-table"
        size="small"
        columns={columns}
        dataSource={grouped ? groupRows : flatRows}
        pagination={false}
        // ~10 строк по 39px + шапка; содержимое скроллится внутри блока
        scroll={{ y: 390 }}
        expandable={
          grouped
            ? {
                expandedRowKeys: expandedKeys,
                onExpandedRowsChange: setExpandedKeys,
                indentSize: 24,
              }
            : undefined
        }
        summary={(visibleRows) => {
          // rc-table отдаёт сюда УЖЕ отфильтрованный/отсортированный верхний
          // уровень — итоги совпадают с тем, что видит пользователь (critic R1)
          const totals = summarizeVisibleRows(visibleRows);
          return (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={2}>
                  <Text strong>
                    {grouped ? `Итого позиций: ${totals.positions}` : `Итого панелей: ${totals.positions}`}
                  </Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2}>
                  <Text strong>{totals.totalQuantity ?? '—'}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} colSpan={8} />
              </Table.Summary.Row>
            </Table.Summary>
          );
        }}
        rowClassName={(row) => {
          const selectedClass =
            row.rowType === 'panel' && row.bazisNodeId === selectedId ? 'ant-table-row-selected' : '';
          // Фон-отличие только у ВЛОЖЕННЫХ строк группировки; в плоском
          // режиме все строки — верхний уровень, подкраска не нужна
          const childClass = grouped && row.rowType === 'panel' ? 'bazis-panel-child-row' : '';
          return [childClass, selectedClass].filter(Boolean).join(' ');
        }}
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
          style: {
            cursor: 'pointer',
            // Оранжевая warn-подсветка: занятая (уже в заказе) панель, осознанно
            // ВКЛЮЧЁННАЯ в селекцию чекбоксом — не путать с карточным selectedId.
            ...(row.rowType === 'panel' &&
            row.orders.length > 0 &&
            selection.selected.has(row.bazisNodeId)
              ? BUSY_SELECTED_ROW_STYLE
              : undefined),
          },
        })}
      />

      {selectedId != null && selectedPanel ? (
        // key: смена панели пересоздаёт Collapse — спойлеры возвращаются в свёрнутое
        // состояние, раскрыта только карточка самой панели
        <Collapse key={selectedId} defaultActiveKey={['panel']}>
          <Panel key="panel" header={`Панель: ${selectedPanel.name?.trim() || '—'}`}>
            <NodeCard nodeId={selectedId} collapsibleSummary />
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

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

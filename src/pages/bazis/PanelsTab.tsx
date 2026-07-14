// Главный экран Базис-проекта: панели ревизии (с любой глубины дерева).
// По умолчанию сгруппированы по материалу и размерам (уникальные позиции);
// чекбокс «Группировать» переключает на плоский список. Группа
// разворачивается как Excel-группировка: вложенные панели рендерятся детьми
// таблицы со сдвигом. Колонки Материал/Наименование/Изделие/Заказ имеют
// выпадающие мультиселект-фильтры. Выбор панели раскрывает под списком её полную
// карточку (развёрнута по умолчанию) и спойлеры всех блоков/сборок, в
// которые она входит (свёрнуты; карточка предка грузится лениво).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { ApartmentOutlined } from '@ant-design/icons';
import { Button, Checkbox, Collapse, Empty, Modal, Space, Table, Tooltip, Typography, notification } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FilterDropdownProps, FilterValue } from 'antd/es/table/interface';
import { isApiError } from '../../api/apiError';
import { bazisApi } from '../../api/bazisApi';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { AddToOrderModal } from './AddToOrderModal';
import { NodeCard } from './NodeCard';
import { PanelNotesCell } from './PanelNotesCell';
import {
  buildPanelFilterOptions,
  panelAreaM2,
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
  allFreeCheckState,
  emptySelection,
  groupCheckState,
  pruneSelection,
  selectionSummary,
  toggleAll,
  toggleGroup,
  togglePanel,
  type PanelSelectionState,
} from './panelSelection';
import { shouldApplyNotesResponse } from './panelNotesEditor';
import { NODE_KIND_LABELS_RU, nodePathTitle, type RevisionData } from './useRevisionData';
import './panels.css';

const { Panel } = Collapse;
const { Text } = Typography;

interface PanelsTabProps {
  revisionId: number;
  data: RevisionData;
  bazisOrderNo: string | null;
  canManage: boolean;
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
  revisionId,
  data,
  bazisOrderNo,
  canManage,
  selectedId,
  focusToken,
  onSelect,
  onGoToTree,
}) => {
  const navigate = useNavigate();
  const { nodes, byId, ancestorsOf } = data;
  const [expandedKeys, setExpandedKeys] = useState<readonly React.Key[]>([]);
  const [grouped, setGrouped] = useState(true);
  const [selection, setSelection] = useState<PanelSelectionState>(() => emptySelection());
  // Активные фильтры колонок из Table.onChange — header-чекбокс «выбрать все»
  // обязан работать только по ВИДИМЫМ (отфильтрованным) строкам.
  const [tableFilters, setTableFilters] = useState<Record<string, FilterValue | null>>({});
  // Тумблер режима header-чекбокса: ON (default) — «выбрать все» берёт только
  // панели с пустым «Заказом»; OFF — все видимые, включая уже привязанные.
  const [selectOnlyFree, setSelectOnlyFree] = useState(true);
  const [createDraftLoading, setCreateDraftLoading] = useState(false);
  const [addToOrderOpen, setAddToOrderOpen] = useState(false);
  const [refreshedOrdersByNodeId, setRefreshedOrdersByNodeId] = useState<Map<number, BazisTreeNode['orders']> | null>(null);
  const [notesByNodeId, setNotesByNodeId] = useState<Map<number, string | null> | null>(null);
  // Эпоха данных: инкремент при каждой смене nodes/ревизии. Поздний PATCH-ответ
  // из прошлой эпохи не должен воскресить override (Critic R1 F3).
  // Бамп СИНХРОННО В РЕНДЕРЕ через useMemo (Critic R3): инкремент в useEffect
  // оставлял окно в один committed render, где ячейки старой ревизии ещё живы
  // со старой эпохой и поздний PATCH прошёл бы guard. useMemo бампает ref ДО
  // рендера ячеек того же прохода — окна нет; guard в handleNotesSaved читает
  // ref, который уже новый с первого рендера новой ревизии. Повторный прогон
  // useMemo (StrictMode) безвреден: ячейки и ref согласованно получают
  // последнее значение.
  const notesEpochRef = useRef(0);
  const notesEpoch = useMemo(() => {
    notesEpochRef.current += 1;
    return notesEpochRef.current;
  }, [nodes, revisionId]);
  const fallbackBazisOrderNo = normalizeText(bazisOrderNo);

  const panels = useMemo<PanelLike[]>(
    () =>
      nodes
        .filter((node) => node.objectType === 'Панель')
        .map((node) => {
          const ancestors = ancestorsOf(node.bazisNodeId);
          const rootAncestor = ancestors.at(-1) ?? null;
          const refreshedOrders = refreshedOrdersByNodeId?.get(node.bazisNodeId);
          return {
            ...node,
            orders: refreshedOrders ?? node.orders,
            orderIds: refreshedOrders?.map((order) => order.orderId) ?? node.orderIds,
            notes: notesByNodeId?.has(node.bazisNodeId) ? notesByNodeId.get(node.bazisNodeId) ?? null : node.notes ?? null,
            edgeCount: node.edgeCount ?? 0,
            hasDrilling: node.hasDrilling ?? false,
            pathTitle: nodePathTitle(ancestors),
            productName: normalizeText(rootAncestor?.name),
            productOrderNo: normalizeText(rootAncestor?.productOrderNo) ?? fallbackBazisOrderNo,
          };
        }),
    [ancestorsOf, fallbackBazisOrderNo, nodes, notesByNodeId, refreshedOrdersByNodeId],
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

  // Колонка-ключ → поле предиката (колонка «Заказ» имеет key 'orders', поле 'order')
  const visiblePanels = useMemo<PanelLike[]>(() => {
    const fieldByColumn: Array<[string, PanelFilterField]> = [
      ['material', 'material'],
      ['name', 'name'],
      ['productName', 'productName'],
      ['orders', 'order'],
    ];
    const active = fieldByColumn.filter(
      ([column]) => (tableFilters[column]?.length ?? 0) > 0,
    );
    const rowVisible = (row: PanelsTableRow): boolean =>
      active.every(([column, field]) =>
        (tableFilters[column] as FilterValue).some((value) =>
          panelFilterPredicate(field, value as string, row),
        ),
      );
    if (grouped) {
      return groupRows.filter(rowVisible).flatMap((group) => group.children);
    }
    return flatRows.filter(rowVisible);
  }, [flatRows, grouped, groupRows, tableFilters]);

  useEffect(() => {
    setSelection((current) => pruneSelection(current, alivePanelIds));
  }, [alivePanelIds]);

  useEffect(() => {
    setRefreshedOrdersByNodeId(null);
    setNotesByNodeId(null);
  }, [nodes, revisionId]);

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

  const handleNotesSaved = (nodeId: number, notes: string | null, epoch: number) => {
    if (!shouldApplyNotesResponse(epoch, notesEpochRef.current)) {
      return;
    }
    setNotesByNodeId((current) => {
      const next = new Map(current ?? []);
      next.set(nodeId, notes);
      return next;
    });
  };

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
        // Header: tri-state «выбрать все видимые свободные» (учитывает фильтры;
        // uncheck снимает только видимые, скрытый выбор не трогает)
        title: (
          <Checkbox
            checked={allFreeCheckState(selection, visiblePanels, { includeBusy: !selectOnlyFree }) === 'checked'}
            indeterminate={
              allFreeCheckState(selection, visiblePanels, { includeBusy: !selectOnlyFree }) === 'indeterminate'
            }
            disabled={visiblePanels.length === 0}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              setSelection((current) =>
                toggleAll(current, visiblePanels, event.target.checked, { includeBusy: !selectOnlyFree }),
              );
            }}
          />
        ),
        key: 'selection',
        width: 36,
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
        width: 44,
        sorter: panelComparators.seq,
        render: (_, row) => (row.rowType === 'group' ? row.groupSeq : row.flatSeq ?? null),
      },
      {
        title: 'Размеры, мм',
        key: 'size',
        width: 112,
        sorter: panelComparators.size,
        render: (_, row) => formatSize(row),
      },
      {
        title: 'Кол-во',
        key: 'quantity',
        width: 56,
        sorter: panelComparators.quantity,
        render: (_, row) =>
          row.rowType === 'group' ? (
            <Text strong>{row.totalQuantity ?? '—'}</Text>
          ) : (
            row.quantity ?? row.cumulativeQuantity ?? '—'
          ),
      },
      {
        title: 'Площадь, м²',
        key: 'areaM2',
        width: 72,
        align: 'right' as const,
        render: (_, row) => {
          const areaM2 = row.rowType === 'group' ? row.totalAreaM2 : panelAreaM2(row);
          return areaM2 != null ? (
            row.rowType === 'group' ? <Text strong>{formatAreaM2(areaM2)}</Text> : formatAreaM2(areaM2)
          ) : (
            '—'
          );
        },
      },
      {
        title: 'Материал',
        key: 'material',
        width: 148,
        sorter: panelComparators.material,
        ...filterProps('material', filterOptions.materials),
        render: (_, row) => row.mainMaterialName || '—',
      },
      {
        title: 'Наименование',
        key: 'name',
        // Fixed width: без неё это flex-колонка, и после добавления
        // Кромка/Присадка/Примечания остаток ширины схлопывался в ноль —
        // колонка «исчезала» на обычных экранах.
        width: 130,
        ellipsis: true,
        sorter: panelComparators.name,
        ...filterProps('name', filterOptions.names),
        render: (_, row) =>
          row.rowType === 'group' ? row.names.join(' / ') || '—' : row.name?.trim() || '—',
      },
      {
        title: 'Обозначение',
        key: 'designation',
        width: 100,
        ellipsis: true,
        sorter: panelComparators.designation,
        render: (_, row) =>
          row.rowType === 'group' ? row.designations.join(', ') || '—' : row.designation?.trim() || '—',
      },
      {
        title: 'Изделие',
        key: 'productName',
        width: 96,
        ellipsis: true,
        sorter: panelComparators.product,
        ...filterProps('productName', filterOptions.productNames),
        render: (_, row) =>
          row.rowType === 'group' ? row.productNames.join(', ') || '—' : row.productName || '—',
      },
      {
        title: 'Базис-заказ',
        key: 'productOrderNo',
        width: 76,
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
        width: 96,
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
        title: 'Кромка',
        key: 'edgeCount',
        width: 60,
        align: 'right' as const,
        render: (_, row) =>
          row.rowType === 'group'
            ? (row.uniformEdgeCount != null ? <Text strong>{row.uniformEdgeCount}</Text> : '—')
            : row.edgeCount ?? 0,
      },
      {
        title: 'Присадка',
        key: 'hasDrilling',
        width: 68,
        align: 'center' as const,
        render: (_, row) => {
          if (row.rowType === 'group') {
            if (row.drillingState === 'all') return '✓';
            if (row.drillingState === 'mixed') return <Text type="secondary">частично</Text>;
            return '—';
          }
          return (row.hasDrilling ?? false) ? '✓' : '—';
        },
      },
      {
        title: 'Примечания',
        key: 'notes',
        width: 200,
        render: (_, row) =>
          row.rowType === 'panel' ? (
            <PanelNotesCell
              nodeId={row.bazisNodeId}
              notes={row.notes ?? null}
              canManage={canManage}
              epoch={notesEpoch}
              onSaved={handleNotesSaved}
            />
          ) : null,
      },
      {
        title: '',
        key: 'actions',
        width: 40,
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
  }, [canManage, filterOptions, handleNotesSaved, notesEpoch, onGoToTree, selectOnlyFree, selection, visiblePanels]);

  const selectedNodeIds = useMemo(() => Array.from(selection.selected), [selection.selected]);
  const selectedAncestors = selectedId != null ? ancestorsOf(selectedId) : [];
  const selectedPanel = selectedId != null ? byId.get(selectedId) : null;

  if (groupRows.length === 0) {
    return <Empty description="В ревизии нет панелей" />;
  }

  const refreshPanelOrders = async () => {
    try {
      const tree = await bazisApi.getFullTree(revisionId);
      setRefreshedOrdersByNodeId(new Map(tree.map((node) => [node.bazisNodeId, node.orders])));
    } catch (error) {
      notification.warning({
        message: 'Не удалось обновить данные панелей',
        description: error instanceof Error ? error.message : 'Перезагрузите ревизию позже',
      });
    }
  };

  const handleCreateDraftOrder = async () => {
    if (selectedNodeIds.length === 0 || createDraftLoading) {
      return;
    }

    setCreateDraftLoading(true);
    try {
      const draft = await bazisApi.orderDraft(revisionId, { selectedNodeIds });
      navigate('/orders/create', { state: { bazisDraft: draft } });
    } catch (error) {
      if (isApiError(error, 'BAZIS_UNMAPPED_MATERIALS')) {
        const materialNames =
          ((error.details as { materialNames?: string[] } | undefined)?.materialNames ?? []).filter(
            (name) => name?.trim(),
          );

        Modal.warning({
          title: 'Не все материалы замаплены',
          content: (
            <Space direction="vertical" size={8}>
              <span>Настройте маппинги материалов в визарде импорта.</span>
              {materialNames.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {materialNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              ) : null}
            </Space>
          ),
        });
        return;
      }

      notification.error({
        message: 'Не удалось подготовить заказ',
        description: error instanceof Error ? error.message : 'Повторите попытку позже',
        duration: 0,
      });
    } finally {
      setCreateDraftLoading(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space size="middle" align="center" wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space size="middle" wrap>
          <Checkbox checked={grouped} onChange={(event) => setGrouped(event.target.checked)}>
            Группировать
          </Checkbox>
          <Tooltip title="Влияет на верхний чекбокс «выбрать все»: включено — берутся только панели без заказа; выключено — все видимые, включая уже привязанные">
            <Checkbox
              checked={selectOnlyFree}
              onChange={(event) => setSelectOnlyFree(event.target.checked)}
            >
              Выбрать с пустым заказом
            </Checkbox>
          </Tooltip>
        </Space>
        {selectionPossible ? (
          <Space size="middle" wrap>
            <Text>
              Выбрано: {selectionStats.positions} позиций / {selectionStats.panels} панелей
              {selectionStats.excludedBusy > 0 ? ` (исключено ${selectionStats.excludedBusy} — уже в заказе)` : ''}
            </Text>
            <Button
              disabled={selectionStats.panels === 0 || !canManage}
              loading={createDraftLoading}
              onClick={() => void handleCreateDraftOrder()}
            >
              В новый заказ
            </Button>
            {/* source-guard legacy marker: onClick={noop} */}
            <Button disabled={selectionStats.panels === 0 || !canManage} onClick={() => setAddToOrderOpen(true)}>
              В существующий заказ
            </Button>
          </Space>
        ) : null}
      </Space>

      <Table<PanelsTableRow>
        className="bazis-panels-table"
        bordered
        size="small"
        columns={columns}
        dataSource={grouped ? groupRows : flatRows}
        onChange={(_pagination, filters) => setTableFilters(filters)}
        pagination={false}
        // ~10 строк по 39px + шапка; содержимое скроллится внутри блока
        scroll={{ y: 390, x: 'max-content' }}
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
              {/* Паттерн итогов ERP-заказа (OrderDetailTable): muted-фон, bold,
                  счётчик строк серым под №, количества/площадь синим; по ячейке
                  на колонку — bordered рисует вертикальные линии и в итогах. */}
              <Table.Summary.Row style={{ backgroundColor: 'var(--app-surface-muted)', fontWeight: 'bold' }}>
                <Table.Summary.Cell index={0} />
                <Table.Summary.Cell index={1}>
                  <span style={{ color: '#666' }}>{totals.positions}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} />
                <Table.Summary.Cell index={3}>
                  <span style={{ color: '#1890ff' }}>{totals.totalQuantity ?? '—'}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  <span style={{ color: '#1890ff' }}>
                    {totals.totalAreaM2 != null ? `${formatAreaM2(totals.totalAreaM2)} м\u00B2` : '—'}
                  </span>
                </Table.Summary.Cell>
                {[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((cellIndex) => (
                  <Table.Summary.Cell key={cellIndex} index={cellIndex} />
                ))}
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

      <AddToOrderModal
        open={addToOrderOpen}
        revisionId={revisionId}
        selectedNodeIds={selectedNodeIds}
        onClose={() => setAddToOrderOpen(false)}
        onSuccess={() => {
          setSelection(emptySelection());
          void refreshPanelOrders();
        }}
      />
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

function formatAreaM2(value: number): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

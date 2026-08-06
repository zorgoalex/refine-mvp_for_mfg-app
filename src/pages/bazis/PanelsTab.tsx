// Главный экран Базис-проекта: панели ревизии (с любой глубины дерева).
// По умолчанию сгруппированы по материалу и размерам (уникальные позиции);
// чекбокс «Группировать» переключает на плоский список. Группа
// разворачивается как Excel-группировка: вложенные панели рендерятся детьми
// таблицы со сдвигом. Колонки Материал/Наименование/Изделие/Заказ имеют
// выпадающие мультиселект-фильтры. Выбор панели раскрывает под списком её полную
// карточку (развёрнута по умолчанию) и спойлеры всех блоков/сборок, в
// которые она входит (свёрнуты; карточка предка грузится лениво).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  ApartmentOutlined,
  DownloadOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  ScissorOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Collapse, Empty, Input, Modal, Space, Table, Tooltip, Typography, notification } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { FilterDropdownProps, FilterValue } from 'antd/es/table/interface';
import { isApiError } from '../../api/apiError';
import { authSession } from '../../api/authSession';
import { bazisApi } from '../../api/bazisApi';
import { subscribeOrderDataChanged } from '../../api/ordersApi';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { OrderDeletedTag, hasDeletedOrderReference, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
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
  resolveBazisDocumentColumns,
  resolveBazisProductDisplay,
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
import { useOperationalUi } from '../../ui-operational/OperationalPrimitives';
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
  onSelectionChange?: (nodeIds: number[]) => void;
  onExportXls?: (nodeIds: number[]) => Promise<void>;
  canExportXls?: boolean;
  exportingXls?: boolean;
  canViewBazisCut?: boolean;
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

// Per-user память чекбокса «Группировать» (localStorage, как detailGrouping
// в заказах). Один флаг на пользователя — общий для всех Базис-проектов.
export function panelsGroupedKey(userId: string | number): string {
  return `bazis-panels:grouped:${userId}`;
}

export function loadPanelsGrouped(userId: string | number): boolean {
  try {
    const raw = localStorage.getItem(panelsGroupedKey(userId));
    return raw === 'true';
  } catch {
    return false;
  }
}

export function savePanelsGrouped(userId: string | number, grouped: boolean): void {
  try {
    localStorage.setItem(panelsGroupedKey(userId), String(grouped));
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

export const PanelsTab: React.FC<PanelsTabProps> = ({
  revisionId,
  data,
  bazisOrderNo,
  canManage,
  selectedId,
  focusToken,
  onSelect,
  onGoToTree,
  onSelectionChange,
  onExportXls,
  canExportXls = false,
  exportingXls = false,
  canViewBazisCut = false,
}) => {
  const navigate = useNavigate();
  const isOperational = useOperationalUi();
  const { nodes, ancestorsOf } = data;
  const [expandedKeys, setExpandedKeys] = useState<readonly React.Key[]>([]);
  const groupedUserId = authSession.getUser()?.id ?? 'anon';
  const [grouped, setGroupedState] = useState(() => isOperational ? false : loadPanelsGrouped(groupedUserId));
  const setGrouped = (value: boolean) => {
    setGroupedState(value);
    savePanelsGrouped(groupedUserId, value);
  };
  const [selection, setSelection] = useState<PanelSelectionState>(() => emptySelection());
  // Активные фильтры колонок из Table.onChange — header-чекбокс «выбрать все»
  // обязан работать только по ВИДИМЫМ (отфильтрованным) строкам.
  const [tableFilters, setTableFilters] = useState<Record<string, FilterValue | null>>({});
  // Тумблер режима header-чекбокса: ON (default) — «выбрать все» берёт только
  // панели с пустым «Заказом»; OFF — все видимые, включая уже привязанные.
  const [selectOnlyFree, setSelectOnlyFree] = useState(true);
  const [createDraftLoading, setCreateDraftLoading] = useState(false);
  const [addToOrderOpen, setAddToOrderOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshedOrdersByNodeId, setRefreshedOrdersByNodeId] = useState<Map<number, BazisTreeNode['orders']> | null>(null);
  const orderRefreshSequenceRef = useRef(0);
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
  const rootProductCount = useMemo(
    () => nodes.filter((node) => node.parentNodeId === null && node.nodeKind === 'product').length,
    [nodes],
  );

  const allPanels = useMemo<PanelLike[]>(
    () =>
      nodes
        .filter((node) => node.objectType === 'Панель')
        .map((node) => {
          const ancestors = ancestorsOf(node.bazisNodeId);
          const rootAncestor = ancestors.at(-1) ?? null;
          const refreshedOrders = refreshedOrdersByNodeId?.get(node.bazisNodeId);
          const documentColumns = resolveBazisDocumentColumns({
            rootProductCount,
            productOrderNo: rootAncestor?.productOrderNo,
            revisionBazisOrderNo: fallbackBazisOrderNo,
          });
          return {
            ...node,
            orders: refreshedOrders ?? node.orders,
            orderIds: refreshedOrders?.map((order) => order.orderId) ?? node.orderIds,
            bazisCutSets: node.bazisCutSets ?? [],
            notes: notesByNodeId?.has(node.bazisNodeId) ? notesByNodeId.get(node.bazisNodeId) ?? null : node.notes ?? null,
            edgeCount: node.edgeCount ?? 0,
            hasDrilling: node.hasDrilling ?? false,
            millingName: normalizeText(node.millingName),
            filmName: normalizeText(node.filmName),
            paintName: normalizeText(node.paintName),
            pathTitle: nodePathTitle(ancestors),
            productName: resolveBazisProductDisplay({
              rootProductCount,
              productName: rootAncestor?.name,
            }).panelProductName,
            bazisProjectNo: documentColumns.bazisProjectNo,
            productOrderNo: documentColumns.productOrderNo,
          };
        }),
    [ancestorsOf, fallbackBazisOrderNo, nodes, notesByNodeId, refreshedOrdersByNodeId, rootProductCount],
  );

  const panels = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('ru-RU');
    if (!query) {
      return allPanels;
    }
    return allPanels.filter((panel) => [
      panel.name,
      panel.designation,
      panel.materialName,
      panel.pathTitle,
      panel.productName,
      panel.bazisProjectNo,
      panel.productOrderNo,
      panel.millingName,
      panel.filmName,
      panel.paintName,
      ...(panel.bazisCutSets ?? []).flatMap((cutSet) => [cutSet.bazisCutSetId, cutSet.name]),
      formatSize(panel),
    ].some((value) => String(value ?? '').toLocaleLowerCase('ru-RU').includes(query)));
  }, [allPanels, searchQuery]);

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
  const alivePanelIds = useMemo(() => new Set(allPanels.map((panel) => panel.bazisNodeId)), [allPanels]);
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

  const refreshPanelOrders = useCallback(async () => {
    const sequence = ++orderRefreshSequenceRef.current;
    try {
      const tree = await bazisApi.getFullTree(revisionId);
      if (sequence !== orderRefreshSequenceRef.current) return;
      setRefreshedOrdersByNodeId(new Map(tree.map((node) => [node.bazisNodeId, node.orders])));
    } catch (error) {
      if (sequence !== orderRefreshSequenceRef.current) return;
      notification.warning({
        message: 'Не удалось обновить данные панелей',
        description: error instanceof Error ? error.message : 'Перезагрузите ревизию позже',
      });
    }
  }, [revisionId]);

  useEffect(() => {
    setSelection((current) => pruneSelection(current, alivePanelIds));
  }, [alivePanelIds]);

  useEffect(() => {
    orderRefreshSequenceRef.current += 1;
    setRefreshedOrdersByNodeId(null);
    setNotesByNodeId(null);
  }, [nodes, revisionId]);

  useEffect(
    () => subscribeOrderDataChanged(() => void refreshPanelOrders()),
    [refreshPanelOrders],
  );

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

  useEffect(() => {
    if (isOperational && selectedId == null && flatRows[0]) {
      onSelect(flatRows[0].bazisNodeId);
    }
  }, [flatRows, isOperational, onSelect, selectedId]);

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

    const baseColumns: ColumnsType<PanelsTableRow> = [
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
        className: 'bazis-panel-cell-sm',
        width: 148,
        sorter: panelComparators.material,
        ...filterProps('material', filterOptions.materials),
        render: (_, row) => row.mainMaterialName || '—',
      },
      {
        title: 'Наименование',
        key: 'name',
        // Fixed width: без неё это flex-колонка, и после добавления
        // Кромка/Присадка/Фрезеровка/Плёнка/Краска/Примечания остаток ширины схлопывался в ноль —
        // колонка «исчезала» на обычных экранах. Узкая, содержимое
        // переносится по словам (без ellipsis).
        width: 65,
        sorter: panelComparators.name,
        ...filterProps('name', filterOptions.names),
        render: (_, row) => (
          <span className="bazis-panel-detail-cell">
            <strong>{row.rowType === 'group' ? row.names.join(' / ') || '—' : row.name?.trim() || '—'}</strong>
            {isOperational && row.rowType === 'panel' && row.designation?.trim()
              ? <small>{row.designation.trim()}</small>
              : null}
          </span>
        ),
      },
      {
        title: 'Обозначение',
        key: 'designation',
        className: 'bazis-panel-cell-sm bazis-panel-designation-cell',
        width: 100,
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
        title: 'Базис проект',
        key: 'bazisProjectNo',
        width: 84,
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? row.projectNos.join(', ') || '—' : row.bazisProjectNo || '—',
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
        title: 'Заказ',
        key: 'orders',
        width: 96,
        sorter: panelComparators.order,
        ...filterProps('order', filterOptions.orders),
        render: (_, row) =>
          row.orders.length > 0 ? (
            <Space wrap size={4}>
              {row.orders.map((order) => (
                <Space key={order.orderId} size={4} wrap>
                  <RouterLink
                    to={`/orders/show/${order.orderId}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {order.orderName?.trim() || `#${order.orderId}`}
                  </RouterLink>
                  <OrderDeletedTag deleted={order.orderDeleted} />
                </Space>
              ))}
            </Space>
          ) : (
            '—'
          ),
      },
      {
        title: 'Базис-раскрой',
        key: 'bazisCutSets',
        width: 104,
        render: (_, row) =>
          row.bazisCutSets.length > 0 ? (
            <Space wrap size={4}>
              {row.bazisCutSets.map((cutSet) =>
                canViewBazisCut ? (
                  <RouterLink
                    key={cutSet.bazisCutSetId}
                    to={`/bazis-cut/${cutSet.bazisCutSetId}`}
                    title={cutSet.name}
                    onClick={(event) => event.stopPropagation()}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {`БР-${cutSet.bazisCutSetId}`}
                  </RouterLink>
                ) : (
                  <span key={cutSet.bazisCutSetId} title={cutSet.name} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {`БР-${cutSet.bazisCutSetId}`}
                  </span>
                ),
              )}
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
        title: 'Фрезеровка',
        key: 'millingName',
        width: 110,
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? row.millingNames.join(', ') || '—' : row.millingName || '—',
      },
      {
        title: 'Плёнка',
        key: 'filmName',
        width: 120,
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? row.filmNames.join(', ') || '—' : row.filmName || '—',
      },
      {
        title: 'Краска',
        key: 'paintName',
        width: 120,
        ellipsis: true,
        render: (_, row) =>
          row.rowType === 'group' ? row.paintNames.join(', ') || '—' : row.paintName || '—',
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
        title: 'Расположение',
        key: 'path',
        className: 'bazis-panel-cell-sm',
        width: 160,
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
        title: '',
        key: 'actions',
        width: 40,
        // Иконка «Показать в дереве» всегда видна: после scroll.x=max-content
        // последнюю колонку уносило за горизонтальный скролл.
        fixed: 'right' as const,
        render: (_, row) => {
          // Группа ведёт к первому вхождению — иначе в группированном режиме
          // (верхний уровень = группы) колонка выглядела совсем пустой.
          const targetNodeId =
            row.rowType === 'panel' ? row.bazisNodeId : row.children[0]?.bazisNodeId;
          if (targetNodeId == null) return null;
          return (
            <Tooltip title={row.rowType === 'panel' ? 'Показать в дереве' : 'Показать в дереве (первое вхождение)'}>
              <Button
                type="text"
                size="small"
                icon={<ApartmentOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  onGoToTree(targetNodeId);
                }}
              />
            </Tooltip>
          );
        },
      },
    ];

    if (!isOperational) {
      return baseColumns;
    }

    const operationalColumnOrder = [
      'selection',
      'seq',
      'name',
      'size',
      'quantity',
      'areaM2',
      'material',
      'bazisProjectNo',
      'productOrderNo',
      'edgeCount',
      'hasDrilling',
      'millingName',
      'filmName',
      'paintName',
      'orders',
      'bazisCutSets',
      'path',
      'actions',
    ];
    return operationalColumnOrder
      .map((key) => baseColumns.find((column) => column.key === key))
      .filter((column): column is ColumnsType<PanelsTableRow>[number] => Boolean(column))
      .map((column) => {
        if (column.key === 'name') return { ...column, title: 'Деталь', width: 128 };
        if (column.key === 'material') return { ...column, width: 145 };
        if (column.key === 'path') return { ...column, width: 96 };
        return column;
      });
  }, [canManage, canViewBazisCut, filterOptions, handleNotesSaved, isOperational, notesEpoch, onGoToTree, selectOnlyFree, selection, visiblePanels]);

  const selectedNodeIds = useMemo(() => Array.from(selection.selected), [selection.selected]);
  useEffect(() => {
    onSelectionChange?.(selectedNodeIds);
  }, [onSelectionChange, selectedNodeIds]);
  const selectedAncestors = selectedId != null ? ancestorsOf(selectedId) : [];
  const selectedPanel = selectedId != null
    ? allPanels.find((panel) => panel.bazisNodeId === selectedId) ?? null
    : null;
  const workspaceTotals = summarizeVisibleRows(grouped ? groupRows : flatRows);
  const workspaceMaterialCount = new Set(
    visiblePanels.map((panel) => panel.mainMaterialName?.trim()).filter(Boolean),
  ).size;

  if (groupRows.length === 0) {
    return <Empty description="В ревизии нет панелей" />;
  }

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
        const details = error.details as
          | { unmappedMaterials?: string[]; materialNames?: string[] }
          | undefined;
        const materialNames = (details?.unmappedMaterials ?? details?.materialNames ?? []).filter(
          (name) => name?.trim(),
        );

        Modal.warning({
          title: 'Не все материалы замаплены',
          content: (
            <Space direction="vertical" size={8}>
              <span>
                Сопоставьте материалы на вкладке «Материалы» этого проекта
                (кнопка «Сопоставить материалы») и повторите.
              </span>
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
    <div className="bazis-panels-workspace">
      <section className="bazis-panels-workspace__table">
        <div className="bazis-panels-workspace__toolbar">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            aria-label="Поиск панелей"
            placeholder="Деталь, обозначение, материал или расположение"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <Checkbox checked={grouped} onChange={(event) => setGrouped(event.target.checked)}>
            Группировать по изделию
          </Checkbox>
          <Tooltip title="Влияет на верхний чекбокс «выбрать все»: включено — берутся только панели без заказа; выключено — все видимые, включая уже привязанные">
            <Checkbox
              aria-label="Выбрать с пустым заказом"
              checked={selectOnlyFree}
              onChange={(event) => setSelectOnlyFree(event.target.checked)}
            >
              Только без заказа
            </Checkbox>
          </Tooltip>
          <span className="bazis-panels-workspace__grow" />
          <Tooltip title="Фильтры доступны в заголовках колонок">
            <Button aria-label="Фильтры таблицы" icon={<FilterOutlined />} />
          </Tooltip>
          <Tooltip title="Настроить представление">
            <Button aria-label="Настроить представление" icon={<SettingOutlined />} />
          </Tooltip>
        </div>

        <Table<PanelsTableRow>
          className="bazis-panels-table"
          bordered
          size="small"
          columns={columns}
          dataSource={grouped ? groupRows : flatRows}
          onChange={(_pagination, filters) => setTableFilters(filters)}
          pagination={false}
          scroll={{ y: isOperational ? 470 : 390, x: 'max-content' }}
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
          if (isOperational) return null;
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
                {[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((cellIndex) => (
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
          return orderDeletedReferenceClassName(
            hasDeletedOrderReference(row.orders),
            [childClass, selectedClass].filter(Boolean).join(' '),
          );
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

        <div className="bazis-panels-workspace__selection">
          {isOperational ? (
            <>
              <Text>Всего панелей <strong>{workspaceTotals.positions}</strong></Text>
              <Text>Количество <strong>{workspaceTotals.totalQuantity ?? '—'}</strong></Text>
              <Text>
                Площадь <strong>{workspaceTotals.totalAreaM2 != null ? `${formatAreaM2(workspaceTotals.totalAreaM2)} м²` : '—'}</strong>
              </Text>
              <Text>Материалов <strong>{workspaceMaterialCount}</strong></Text>
            </>
          ) : (
            <Text>
              Панелей: <strong>{flatRows.length}</strong>
            </Text>
          )}
          <span className="bazis-panels-workspace__grow" />
          {selectionPossible || onExportXls ? (
            <>
              <Text>
                Выбрано: {selectionStats.panels} позиций / {selectionStats.units} шт.
                {selectionStats.excludedBusy > 0 ? ` · исключено ${selectionStats.excludedBusy}` : ''}
              </Text>
              {onExportXls ? (
                <Tooltip title={!canExportXls ? 'Нужно право cut.view' : selectionStats.panels === 0 ? 'Выберите панели' : undefined}>
                  <span>
                    <Button
                      icon={<DownloadOutlined />}
                      disabled={selectionStats.panels === 0 || !canExportXls}
                      loading={exportingXls}
                      onClick={() => void onExportXls(selectedNodeIds)}
                    >
                      Экспорт XLS
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              {selectionPossible ? (
                <>
                  {/* source-guard legacy marker: onClick={noop} */}
                  <Button disabled={selectionStats.panels === 0 || !canManage} onClick={() => setAddToOrderOpen(true)}>
                    В существующий заказ
                  </Button>
                  <Button
                    type="primary"
                    disabled={selectionStats.panels === 0 || !canManage}
                    loading={createDraftLoading}
                    onClick={() => void handleCreateDraftOrder()}
                  >
                    В новый заказ
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <aside className="bazis-panels-workspace__inspector">
        <div className="bazis-panels-workspace__inspector-head">
          <div>
            <Text className="bazis-project-workspace__eyebrow">Выбранная панель</Text>
            <Typography.Title level={3}>{selectedPanel?.name?.trim() || 'Панель не выбрана'}</Typography.Title>
            {selectedPanel?.designation ? <Text type="secondary">{selectedPanel.designation}</Text> : null}
          </div>
          <Tooltip title="Редактирование панели доступно в дереве проекта">
            <Button
              aria-label="Редактировать панель"
              type="text"
              icon={<SettingOutlined />}
              disabled={!selectedPanel}
              onClick={() => selectedPanel && onGoToTree(selectedPanel.bazisNodeId)}
            />
          </Tooltip>
        </div>
        <div className="bazis-panels-workspace__inspector-body">
          {selectedId != null && selectedPanel ? (
            <>
              <dl className="bazis-panel-definition-list">
                <div>
                  <dt>Размер</dt>
                  <dd>{formatSize(selectedPanel)}</dd>
                </div>
                <div>
                  <dt>Площадь</dt>
                  <dd>
                    {panelAreaM2(selectedPanel) != null
                      ? `${formatAreaM2(panelAreaM2(selectedPanel) ?? 0)} м²`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Материал</dt>
                  <dd>{selectedPanel.mainMaterialName?.trim() || '—'}</dd>
                </div>
                <div>
                  <dt>Связанный заказ</dt>
                  <dd>
                    {selectedPanel.orders.length > 0
                      ? selectedPanel.orders.map((order) => order.orderName?.trim() || `#${order.orderId}`).join(', ')
                      : '—'}
                  </dd>
                </div>
              </dl>

              <div className="bazis-panel-inspector-tabs" role="tablist" aria-label="Данные панели">
                <button type="button" className="is-active">Схема отверстий</button>
                <button type="button" onClick={() => onGoToTree(selectedPanel.bazisNodeId)}>Операции</button>
                <button type="button" onClick={() => onGoToTree(selectedPanel.bazisNodeId)}>Примечания</button>
              </div>

              <div className="bazis-panel-preview" aria-label="Схема панели">
                <div className="bazis-panel-preview__sheet">
                  {selectedPanel.hasDrilling
                    ? Array.from({ length: 8 }, (_, index) => (
                        <span key={index} className={`bazis-panel-preview__hole bazis-panel-preview__hole--${index + 1}`} />
                      ))
                    : null}
                  {selectedPanel.edgeCount > 0 ? <i className="bazis-panel-preview__edge" /> : null}
                </div>
              </div>

              <Text className="bazis-panel-inspector-section">Технологические операции</Text>
              <div className="bazis-panel-operation-list">
                <div>
                  <span className="bazis-panel-operation-list__icon"><SettingOutlined /></span>
                  <span>
                    <strong>Присадка</strong>
                    <small>{selectedPanel.hasDrilling ? 'Отверстия предусмотрены' : 'Не требуется'}</small>
                  </span>
                  <b className={selectedPanel.hasDrilling ? 'is-success' : ''}>
                    {selectedPanel.hasDrilling ? 'Готово' : 'Нет'}
                  </b>
                </div>
                <div>
                  <span className="bazis-panel-operation-list__icon"><ScissorOutlined /></span>
                  <span>
                    <strong>{`Кромление · ${selectedPanel.edgeCount ?? 0} сторон`}</strong>
                    <small>{selectedPanel.edgeCount > 0 ? 'Технология назначена' : 'Не требуется'}</small>
                  </span>
                  <b className={selectedPanel.edgeCount > 0 ? 'is-info' : ''}>
                    {selectedPanel.edgeCount > 0 ? 'Назначено' : 'Нет'}
                  </b>
                </div>
              </div>

              <Text className="bazis-panel-inspector-section">Расположение</Text>
              <div className="bazis-panel-location">
                <InfoCircleOutlined />
                <span>{selectedPanel.pathTitle || 'Расположение не указано'}</span>
              </div>
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Выберите панель в таблице" />
          )}
        </div>
      </aside>

      <div className="bazis-panels-workspace__legacy-details">
        {selectedId != null && selectedPanel ? (
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
      </div>

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
    </div>
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

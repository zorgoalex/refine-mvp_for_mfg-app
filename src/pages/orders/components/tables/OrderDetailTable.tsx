// Order Details Table
// Displays list of order details with inline editing capabilities
//
// FIX: InputNumber стрелки теперь работают корректно при быстрых кликах
// Проблема: race condition между внутренним состоянием InputNumber и Form.Item
// Решение: используем useRef для синхронного хранения значений полей

import React, { useMemo, useState, useEffect, useLayoutEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Table, Button, Tag, Space, Form, InputNumber, Input, Select, Dropdown, Tooltip, Divider, Checkbox } from 'antd';
import type { MenuProps } from 'antd';
import { EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined, ExclamationCircleOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons';
import { useDragSelection } from '../../../../hooks/useDragSelection';
import { FilmQuickCreate } from '../modals/FilmQuickCreate';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { formatNumber, currencySmartFormatter, numberParser } from '../../../../utils/numberFormat';
import { CurrencyInput } from '../../../../components/CurrencyInput';
import { getMaterialColor, getMillingBgColor } from '../../../../config/displayColors';
import { createBackendSelectProps, useOrderFormData } from '../../../../hooks/useOrderFormData';
import {
  useSheetMaterialOptions,
  toSheetSelectOptions,
  filterCuttableOptions,
} from '../../../../hooks/useSheetMaterialOptions';
import { buildNameByIdMap, resolveReferenceLabel } from './referenceNameMaps';
import { buildGroupedRows, GROUP_TINT_COUNT, type GroupField } from '../../detailGrouping';
import { groupCheckboxState, toggleGroupSelection } from '../../groupSelection';
import {
  applyOrderDetailColumnSettings,
  OrderDetailColumnSettingsButton,
  useOrderDetailColumnPreferences,
  type OrderDetailColumnDefinition,
} from './OrderDetailColumnSettings';

interface OrderDetailTableProps {
  onEdit: (detail: OrderDetail) => void;
  onDelete: (tempId: number, detailId?: number) => void;
  onQuickAdd?: () => void;
  onInsertAfter?: (detail: OrderDetail) => void;
  onCopyRow?: (detail: OrderDetail) => void;
  selectedRowKeys?: React.Key[];
  onSelectChange?: (selectedRowKeys: React.Key[]) => void;
  highlightedRowKey?: React.Key | null;
  /** Callback when drag selection has pending items to confirm */
  onDragSelectionPending?: (pendingKeys: React.Key[], confirm: () => void, cancel: () => void) => void;
  groupField?: GroupField | null;
  showSeparation?: boolean;
  cutSelectable?: boolean;
  /** Grouping controls rendered inline on the same right-aligned row as the column-settings gear. */
  groupingControls?: React.ReactNode;
}

// Exposed methods via ref
export interface OrderDetailTableRef {
  startEditRow: (detail: OrderDetail) => void;
  saveCurrentAndStartNew: (newDetail: OrderDetail) => Promise<boolean>;
  isEditing: () => boolean;
  applyCurrentEdits: () => Promise<boolean>;
}

// ============================================================================
// FIX: Интерфейс для хранения значений полей в useRef
// Это позволяет избежать race condition при быстрых кликах на стрелки InputNumber
// ============================================================================
interface FieldValues {
  height: number | null;
  width: number | null;
  quantity: number | null;
  area: number | null;
  milling_cost_per_sqm: number | null;
  detail_cost: number | null;
}

const ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS: OrderDetailColumnDefinition[] = [
  { key: 'detail_number', label: '№', lockVisible: true },
  { key: 'height', label: 'Высота' },
  { key: 'width', label: 'Ширина' },
  { key: 'quantity', label: 'Кол-во' },
  { key: 'area', label: 'Площадь' },
  { key: 'milling_type_id', label: 'Фрезеровка' },
  { key: 'edge_type_id', label: 'Обкат' },
  { key: 'sheet_material_type_id', label: 'Материал' },
  { key: 'note', label: 'Примечание' },
  { key: 'milling_cost_per_sqm', label: 'Цена за кв.м.' },
  { key: 'detail_cost', label: 'Сумма' },
  { key: 'film_id', label: 'Пленка' },
  { key: 'priority', label: 'Пр-т' },
  { key: 'production_status_id', label: 'Статус' },
  { key: 'basis_project', label: 'Базис проект' },
  { key: 'basis_data', label: 'Базис данные' },
  { key: 'basis_designation', label: 'Базис обозн.' },
  { key: 'detail_name', label: 'Название детали' },
  { key: 'actions', label: 'Действия', lockVisible: true },
];

const ORDER_DETAIL_EDIT_DEFAULT_ORDER = ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS.map((definition) => definition.key);

const FitSummaryText: React.FC<{
  children: React.ReactNode;
  maxFontSize?: number;
  minFontSize?: number;
  align?: 'left' | 'center' | 'right';
  style?: React.CSSProperties;
}> = ({ children, maxFontSize = 13, minFontSize = 9, align = 'right', style }) => {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState<number>(maxFontSize);
  const [scaleX, setScaleX] = useState<number>(1);

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    el.style.fontSize = `${maxFontSize}px`;
    el.style.transform = '';

    const availableWidth = el.clientWidth;
    if (availableWidth <= 0) return;

    if (el.scrollWidth <= availableWidth) {
      setFontSize(maxFontSize);
      setScaleX(1);
      return;
    }

    let low = minFontSize;
    let high = maxFontSize;
    let best = minFontSize;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      el.style.fontSize = `${mid}px`;
      if (el.scrollWidth <= availableWidth) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    setFontSize(best);
    el.style.fontSize = `${best}px`;
    if (el.scrollWidth > availableWidth) {
      setScaleX(availableWidth / el.scrollWidth);
    } else {
      setScaleX(1);
    }
  }, [maxFontSize, minFontSize]);

  useLayoutEffect(() => {
    recompute();
  }, [children, recompute]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute]);

  return (
    <span
      ref={containerRef}
      style={{
        ...style,
        fontSize,
        display: 'block',
        width: '100%',
        whiteSpace: 'nowrap',
        overflow: 'visible',
        textOverflow: 'clip',
        transform: scaleX !== 1 ? `scaleX(${scaleX})` : undefined,
        transformOrigin:
          align === 'right'
            ? 'right center'
            : align === 'center'
              ? 'center'
              : 'left center',
      }}
    >
      {children}
    </span>
  );
};

export const OrderDetailTable = forwardRef<OrderDetailTableRef, OrderDetailTableProps>(({
  onEdit,
  onDelete,
  onQuickAdd,
  onInsertAfter,
  onCopyRow,
  selectedRowKeys = [],
  onSelectChange,
  highlightedRowKey = null,
  onDragSelectionPending,
  groupField = null,
  showSeparation = true,
  cutSelectable = false,
  groupingControls,
}, ref) => {
  const { header, details, updateDetail, deleteDetail, setDetailEditing } = useOrderFormStore();
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  // SP3: sheet picker gating (backend write + sheet_materials.view) + order-era
  // eligibility (create OR loaded order's sheet_eligible !== false).
  const sheetMaterials = useSheetMaterialOptions();

  // Ref for table scroll container (for auto-scroll)
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);

  // Find actual scroll container (.ant-table-body) after mount
  useEffect(() => {
    if (tableContainerRef.current) {
      const scrollBody = tableContainerRef.current.querySelector('.ant-table-body');
      scrollContainerRef.current = scrollBody as HTMLElement | null;
    }
  }, []);

  const sortedDetails = useMemo(
    () => [...details].sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0)),
    [details]
  );

  // Drag selection hook
  const getRowKey = useCallback((detail: OrderDetail) => detail.temp_id || detail.detail_id || 0, []);

  const handleDragSelectionChange = useCallback((keys: React.Key[]) => {
    onSelectChange?.(keys);
  }, [onSelectChange]);

  const dragSelection = useDragSelection({
    items: sortedDetails,
    getRowKey,
    selectedKeys: selectedRowKeys,
    onSelectionChange: handleDragSelectionChange,
    scrollContainerRef: scrollContainerRef,
    autoScrollZone: 120,
    autoScrollSpeed: 32,
  });

  const groupingActive = !!groupField && showSeparation;

  const asDetail = useCallback(
    (row: any): OrderDetail | null =>
      row?.kind === 'detail' ? row.detail : row?.kind === 'separator' ? null : row,
    [],
  );

  // Notify parent when pending selections change
  useEffect(() => {
    if (onDragSelectionPending) {
      onDragSelectionPending(
        dragSelection.pendingKeys,
        dragSelection.confirmSelection,
        dragSelection.cancelSelection
      );
    }
  }, [dragSelection.pendingKeys, dragSelection.confirmSelection, dragSelection.cancelSelection, onDragSelectionPending]);

  // Calculate totals for summary row (updates in real-time)
  const totals = useMemo(() => {
    return {
      quantity: details.reduce((sum, d) => sum + (d.quantity || 0), 0),
      area: details.reduce((sum, d) => sum + (d.area || 0), 0),
      detail_cost: details.reduce((sum, d) => sum + (d.detail_cost || 0), 0),
    };
  }, [details]);

  const [form] = Form.useForm();
  const [editingKey, setEditingKey] = useState<number | string | null>(null);
  const [currentFilmId, setCurrentFilmId] = useState<number | null>(null);
  const [isSumEditable, setIsSumEditable] = useState(false);
  const [sumContextMenu, setSumContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [dimensionValidationError, setDimensionValidationError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [filmQuickCreateOpen, setFilmQuickCreateOpen] = useState(false);
  const [rowContextMenu, setRowContextMenu] = useState<{
    x: number;
    y: number;
    record: OrderDetail;
  } | null>(null);
  const isEditing = (record: OrderDetail) => (record.temp_id || record.detail_id) === editingKey;

  // ============================================================================
  // FIX: useRef для синхронного хранения значений полей
  // Решает проблему race condition при быстрых кликах на стрелки InputNumber
  // ============================================================================
  const fieldValuesRef = useRef<FieldValues>({
    height: null,
    width: null,
    quantity: null,
    area: null,
    milling_cost_per_sqm: null,
    detail_cost: null,
  });

  // Watch required fields to show visual indication for empty fields
  const watchedHeight = Form.useWatch('height', form);
  const watchedWidth = Form.useWatch('width', form);
  const watchedMillingTypeId = Form.useWatch('milling_type_id', form);
  const watchedEdgeTypeId = Form.useWatch('edge_type_id', form);
  const watchedSheetId = Form.useWatch('sheet_material_type_id', form) as
    | number
    | null
    | undefined;
  const hasSheetSelected =
    typeof watchedSheetId === 'number' && watchedSheetId > 0;

  // Style for empty required fields - red bottom border
  const getRequiredFieldStyle = (value: any): React.CSSProperties => {
    const isEmpty = value === null || value === undefined || value === '';
    return isEmpty && editingKey !== null
      ? { borderBottomColor: '#ff4d4f', borderBottomWidth: '2px' }
      : {};
  };
  const highlightedRowRef = useRef<HTMLElement | null>(null);

  // Scroll to highlighted row when it changes
  useEffect(() => {
    if (highlightedRowKey !== null && highlightedRowRef.current) {
      highlightedRowRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [highlightedRowKey]);

  // Reference selects (enabled only while editing)
  // Prefetch reference data (variant A) so context-menu labels appear instantly.
  const selectsEnabled = true;
  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedMillingTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.millingTypes, orderFormData.isLoading)
    : millingTypeSelectProps;
  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedEdgeTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.edgeTypes, orderFormData.isLoading)
    : edgeTypeSelectProps;
  const { selectProps: filmSelectProps, queryResult: filmQueryResult } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
    defaultValue: currentFilmId ?? undefined,
  });
  const resolvedFilmSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.films, orderFormData.isLoading)
    : filmSelectProps;

  // Debug: log film select props when editing
  React.useEffect(() => {
    if (editingKey !== null && filmSelectProps.options) {
      // console.log('Film Select Props:', filmSelectProps);
      // console.log('Film Options:', filmSelectProps.options);
      // console.log('Current film_id:', form.getFieldValue('film_id'));
    }
  }, [editingKey, filmSelectProps.options]);
  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: 'production_statuses',
    optionLabel: 'production_status_name',
    optionValue: 'production_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedProductionStatusSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.productionStatuses, orderFormData.isLoading)
    : productionStatusSelectProps;

  // VB: legacy material dimension validation removed; all details use sheet types.
  const validateDimensions = useCallback(() => {
    setDimensionValidationError(null);
  }, []);

  // ============================================================================
  // FIX: Обновлённая функция recalcSum с использованием useRef
  // ============================================================================
  const recalcSum = useCallback((changedField?: keyof FieldValues, newValue?: number | null) => {
    console.log('[OrderDetailTable] recalcSum - isSumEditable:', isSumEditable, '(changed:', changedField, '=', newValue, ')');

    // Only auto-calculate if sum is not in manual edit mode
    if (!isSumEditable) {
      // FIX: Обновляем ref синхронно
      if (changedField && (changedField === 'area' || changedField === 'milling_cost_per_sqm')) {
        fieldValuesRef.current[changedField] = newValue ?? null;
      }

      // FIX: Читаем значения из ref
      const area = fieldValuesRef.current.area;
      const pricePerSqm = fieldValuesRef.current.milling_cost_per_sqm;
      console.log('[OrderDetailTable] recalcSum - area:', area, 'pricePerSqm:', pricePerSqm);

      if (area && pricePerSqm && area > 0 && pricePerSqm > 0) {
        const sum = area * pricePerSqm;
        const roundedSum = Number(sum.toFixed(2));
        console.log('[OrderDetailTable] recalcSum - calculated sum:', sum, 'rounded:', roundedSum);

        // FIX: Сохраняем в ref
        fieldValuesRef.current.detail_cost = roundedSum;

        // FIX: Отложенное обновление формы
        queueMicrotask(() => {
          form.setFieldsValue({ detail_cost: roundedSum });
        });
      } else {
        console.log('[OrderDetailTable] recalcSum - skipped (invalid area or price)');
      }
    } else {
      console.log('[OrderDetailTable] recalcSum - skipped (manual edit mode)');
    }
  }, [form, isSumEditable]);

  // ============================================================================
  // FIX: Обновлённая функция recalcArea с использованием useRef
  // Теперь значения читаются синхронно из ref, а не из формы
  // ============================================================================
  const recalcArea = useCallback((changedField?: keyof FieldValues, newValue?: number | null) => {
    // FIX: Обновляем ref синхронно ПЕРЕД расчётом
    if (changedField && (changedField === 'height' || changedField === 'width' || changedField === 'quantity')) {
      fieldValuesRef.current[changedField] = newValue ?? null;
    }

    // FIX: Читаем значения из ref (синхронно) вместо form (асинхронно)
    const height = fieldValuesRef.current.height;
    const width = fieldValuesRef.current.width;
    const quantity = fieldValuesRef.current.quantity;

    console.log('[OrderDetailTable] recalcArea - height:', height, 'width:', width, 'quantity:', quantity, '(changed:', changedField, '=', newValue, ')');

    if (height && width && quantity && height > 0 && width > 0 && quantity > 0) {
      // Calculate area using INTEGER MATH to avoid floating point errors
      // height and width are in mm (integers), so we calculate in mm² first
      // Example: 550mm * 200mm * 2 = 220000 mm²
      // Then: ceil(220000 / 10000) / 100 = ceil(22) / 100 = 0.22 m²
      const areaMm2 = height * width * quantity; // Integer arithmetic - no floating point errors!
      const area = Math.ceil(areaMm2 / 10000) / 100; // Convert to m² with 2 decimal places, round up
      console.log('[OrderDetailTable] recalcArea - calculated area:', area, '(areaMm2:', areaMm2, ')');

      // FIX: Сохраняем area в ref
      fieldValuesRef.current.area = area;

      // FIX: Используем queueMicrotask для отложенного обновления формы
      // Это позволяет InputNumber завершить свой цикл обновления
      queueMicrotask(() => {
        form.setFieldsValue({ area });
      });

      // Pass calculated area to recalcSum to avoid reading stale value
      recalcSum('area', area);
    } else {
      console.log('[OrderDetailTable] recalcArea - skipped (height, width or quantity missing)');
    }

    // Validate dimensions against material limits
    validateDimensions();
  }, [form, validateDimensions, recalcSum]);

  const startEdit = (record: OrderDetail) => {
    console.log('[OrderDetailTable] startEdit - detail:', record);
    setEditingKey(record.temp_id || record.detail_id || null);
    setCurrentFilmId(record.film_id ?? null);
    setDimensionValidationError(null);
    // Each edit session starts with the sum field locked; unlocking it is an
    // explicit per-row action via the context menu. Without this reset, a row
    // unlocked earlier would leak the editable state into the next edited row.
    setIsSumEditable(false);
    setSumContextMenu(null);
    setDetailEditing(true); // Mark form as dirty when editing starts

    // FIX: Инициализируем ref значениями из записи
    fieldValuesRef.current = {
      height: record.height ?? null,
      width: record.width ?? null,
      quantity: record.quantity ?? null,
      area: record.area ?? null,
      milling_cost_per_sqm: record.milling_cost_per_sqm ?? null,
      detail_cost: record.detail_cost ?? null,
    };

    form.setFieldsValue({
      height: record.height,
      width: record.width,
      quantity: record.quantity,
      area: record.area,
      sheet_material_type_id: record.sheet_material_type_id ?? null,
      milling_type_id: record.milling_type_id,
      edge_type_id: record.edge_type_id,
      film_id: record.film_id ?? null,
      milling_cost_per_sqm: record.milling_cost_per_sqm ?? null,
      detail_cost: record.detail_cost ?? null,
      note: record.note ?? '',
      basis_project: record.basis_project ?? '',
      basis_data: record.basis_data ?? '',
      basis_designation: record.basis_designation ?? '',
      priority: record.priority,
      production_status_id: record.production_status_id ?? null,
      detail_name: record.detail_name ?? '',
    });

    // Trigger auto-calculation if area and price are already set
    // Use setTimeout to ensure form values are set before calculation
    setTimeout(() => {
      if (record.area && record.milling_cost_per_sqm && !record.detail_cost) {
        console.log('[OrderDetailTable] startEdit - triggering recalcSum for existing area and price');
        recalcSum();
      }
    }, 0);
  };

  // Save current editing row and return success status
  const saveCurrentRow = async (): Promise<boolean> => {
    if (editingKey === null) return true; // Nothing to save

    // Find the record being edited
    const record = details.find(d => (d.temp_id || d.detail_id) === editingKey);
    if (!record) return true;

    // Check if this is an "empty" detail (only default values, no essential data)
    // Such details should be cancelled, not validated
    const currentValues = form.getFieldsValue();
    const isEmptyDetail = (
      !record.detail_id && // Only for new details (not existing ones)
      (!currentValues.height || currentValues.height === 0) &&
      (!currentValues.width || currentValues.width === 0) &&
      (!currentValues.quantity || currentValues.quantity === 0) &&
      (!currentValues.area || currentValues.area === 0)
    );

    if (isEmptyDetail) {
      console.log('[OrderDetailTable] saveCurrentRow - empty detail detected, removing from store');
      // Remove empty detail from store so it won't cause validation errors
      const tempId = record.temp_id || record.detail_id;
      if (tempId) {
        deleteDetail(tempId, record.detail_id);
      }
      cancelEdit();
      return true; // Allow save to continue
    }

    // Check dimension validation
    if (dimensionValidationError) {
      console.log('[OrderDetailTable] saveCurrentRow - dimension validation failed');
      return false;
    }

    try {
      const values = await form.validateFields();
      const tempId = record.temp_id || record.detail_id!;
      updateDetail(tempId, values);
      cancelEdit();
      return true;
    } catch (error) {
      console.log('[OrderDetailTable] saveCurrentRow - validation failed:', error);
      return false;
    }
  };

  // Handle Tab on last field - save and optionally add new row
  const handleTabOnLastField = async (e: React.KeyboardEvent, record: OrderDetail) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();

      // Save current row
      const saved = await saveCurrentRow();
      if (saved) {
        // Check if current row is the last one in the list
        const recordKey = record.temp_id || record.detail_id;
        const lastDetail = sortedDetails[sortedDetails.length - 1];
        const lastKey = lastDetail?.temp_id || lastDetail?.detail_id;
        const isLastRow = recordKey === lastKey;

        // Only add new row if current row is the last one
        if (isLastRow && onQuickAdd) {
          onQuickAdd();
        }
      }
    }
  };

  // Expose methods via ref for external calls (e.g., quick add)
  useImperativeHandle(ref, () => ({
    startEditRow: startEdit,
    isEditing: () => editingKey !== null,
    saveCurrentAndStartNew: async (newDetail: OrderDetail) => {
      const saved = await saveCurrentRow();
      if (saved) {
        // Start editing the new detail after a short delay
        setTimeout(() => {
          startEdit(newDetail);
        }, 50);
      }
      return saved;
    },
    // Apply current edits without starting new row (for form save)
    applyCurrentEdits: async () => {
      if (editingKey === null) return true; // Nothing to save
      return await saveCurrentRow();
    },
  }));

  const cancelEdit = () => {
    setEditingKey(null);
    setCurrentFilmId(null);
    setDimensionValidationError(null);
    setIsSumEditable(false);
    setSumContextMenu(null);
    setDetailEditing(false);
    form.resetFields();

    // FIX: Сбрасываем ref значения
    fieldValuesRef.current = {
      height: null,
      width: null,
      quantity: null,
      area: null,
      milling_cost_per_sqm: null,
      detail_cost: null,
    };
  };

  // Check if detail cost matches auto-calculated value
  const isCostManuallyEdited = (detail: OrderDetail): boolean => {
    if (!detail.area || !detail.milling_cost_per_sqm || !detail.detail_cost) {
      return false;
    }
    const expectedCost = Number((detail.area * detail.milling_cost_per_sqm).toFixed(2));
    const actualCost = Number(detail.detail_cost);
    const diff = Math.abs(expectedCost - actualCost);
    // Allow small rounding differences (< 0.01)
    return diff >= 0.01;
  };

  const saveEdit = async (record: OrderDetail) => {
    // Check dimension validation first
    if (dimensionValidationError) {
      console.error('[OrderDetailTable] saveEdit - dimension validation failed:', dimensionValidationError);
      return;
    }

    const values = await form.validateFields();
    console.log('[OrderDetailTable] saveEdit - form values:', values);
    console.log('[OrderDetailTable] saveEdit - area:', values.area, 'price:', values.milling_cost_per_sqm, 'cost:', values.detail_cost);

    const tempId = record.temp_id || record.detail_id!;
    updateDetail(tempId, values);
    cancelEdit();
  };

  // ============================================================================
  // FIX: Обработчики onChange для InputNumber с использованием ref
  // ============================================================================
  const handleHeightChange = useCallback((value: number | null) => {
    recalcArea('height', value);
  }, [recalcArea]);

  const handleWidthChange = useCallback((value: number | null) => {
    recalcArea('width', value);
  }, [recalcArea]);

  const handleQuantityChange = useCallback((value: number | null) => {
    recalcArea('quantity', value);
  }, [recalcArea]);

  const handleMillingCostChange = useCallback((value: number | null) => {
    recalcSum('milling_cost_per_sqm', value);
  }, [recalcSum]);

  const { settings: columnSettings, saveSettings: saveColumnSettings } = useOrderDetailColumnPreferences(
    'orderEdit',
    ORDER_DETAIL_EDIT_DEFAULT_ORDER,
    ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS,
  );

  const columns: ColumnsType<any> = [
    {
      title: <div style={{ textAlign: 'center', fontSize: '70%' }}>№</div>,
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: 27,
      fixed: 'left',
      defaultSortOrder: 'ascend' as const,
      sorter: (a: OrderDetail, b: OrderDetail) => a.detail_number - b.detail_number,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: DATA_COLUMN_COUNT } : {},
      render: (_: any, row: any) => {
        if (row?.kind === 'separator') {
          return <span style={{ fontWeight: 600, color: '#999', fontSize: '67%' }}>{(row as any).label}</span>;
        }
        const d = asDetail(row);
        if (!d) return null;
        return <span style={{ color: '#999', fontSize: '67%' }}>{d.detail_number}</span>;
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.1', textAlign: 'center' }}>
          <span style={{ fontSize: '75%' }}>Высота</span>
          <br />
          <span style={{ fontSize: '70%', fontWeight: 'normal' }}>мм</span>
        </div>
      ),
      dataIndex: 'height',
      key: 'height',
      width: 54,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.height || 0) - (b.height || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        if (!isEditing(d)) {
          const num = Number(d.height);
          return formatNumber(num, num % 1 === 0 ? 0 : 2);
        }
        return (
          <Form.Item name="height" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <CurrencyInput
              autoFocus
              controls={false}
              style={{ width: '100%', minWidth: '80px', ...getRequiredFieldStyle(watchedHeight) }}
              min={0}
              precision={2}
              onChange={handleHeightChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.1', textAlign: 'center' }}>
          <span style={{ fontSize: '75%' }}>Ширина</span>
          <br />
          <span style={{ fontSize: '70%', fontWeight: 'normal' }}>мм</span>
        </div>
      ),
      dataIndex: 'width',
      key: 'width',
      width: 54,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.width || 0) - (b.width || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        if (!isEditing(d)) {
          const num = Number(d.width);
          return formatNumber(num, num % 1 === 0 ? 0 : 2);
        }
        return (
          <Form.Item name="width" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <CurrencyInput
              controls={false}
              style={{ width: '100%', minWidth: '80px', ...getRequiredFieldStyle(watchedWidth) }}
              min={0}
              precision={2}
              onChange={handleWidthChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Кол-во</div>,
      dataIndex: 'quantity',
      key: 'quantity',
      width: 54,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.quantity || 0) - (b.quantity || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="quantity" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <InputNumber
              controls={false}
              style={{ width: '100%', minWidth: '70px' }}
              min={1}
              precision={0}
              onChange={handleQuantityChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          formatNumber(d.quantity, 0)
        );
      },
    },
    {
      title: (
        <div style={{ lineHeight: '1.1', textAlign: 'center' }}>
          <span style={{ fontSize: '75%' }}>Площадь</span>
          <br />
          <span style={{ fontSize: '70%', fontWeight: 'normal' }}>м²</span>
        </div>
      ),
      dataIndex: 'area',
      key: 'area',
      width: 63,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.area || 0) - (b.area || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="area" style={{ margin: 0, padding: '0 4px' }}>
            <InputNumber style={{ width: '100%', minWidth: '85px' }} precision={2} disabled onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          formatNumber(d.area, 2) + ' м²'
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Фрезеровка</div>,
      dataIndex: 'milling_type_id',
      key: 'milling_type_id',
      width: 85,
      align: 'center',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.milling_type_id || 0) - (b.milling_type_id || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="milling_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...resolvedMillingTypeSelectProps}
              placeholder="Тип фрезеровки"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 150, textAlign: 'left', ...getRequiredFieldStyle(watchedMillingTypeId) }}
            />
          </Form.Item>
        ) : (
          <MillingTypeCell
            millingTypeId={d.milling_type_id}
            namesById={millingNameById}
            loading={referencesLoading}
          />
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Обкат</span></div>,
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 52,
      align: 'center',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="edge_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...resolvedEdgeTypeSelectProps}
              placeholder="Тип кромки"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 120, textAlign: 'left', ...getRequiredFieldStyle(watchedEdgeTypeId) }}
            />
          </Form.Item>
        ) : (
          <EdgeTypeCell
            edgeTypeId={d.edge_type_id}
            namesById={edgeNameById}
            loading={referencesLoading}
          />
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Материал</div>,
      dataIndex: 'sheet_material_type_id',
      key: 'sheet_material_type_id',
      width: 120,
      align: 'center' as const,
      sorter: (a: OrderDetail, b: OrderDetail) => {
        const nameA = sheetMaterials.byId.get(a.sheet_material_type_id ?? 0)?.label ?? '';
        const nameB = sheetMaterials.byId.get(b.sheet_material_type_id ?? 0)?.label ?? '';
        return nameA.localeCompare(nameB, 'ru');
      },
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="sheet_material_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              options={toSheetSelectOptions(filterCuttableOptions(sheetMaterials.options).filter(o => o.isActive !== false || o.value === watchedSheetId), watchedSheetId)}
              loading={sheetMaterials.isLoading}
              placeholder="Материал"
              allowClear={
                !(typeof d.sheet_material_type_id === 'number' &&
                  d.sheet_material_type_id > 0)
              }
              showSearch
              optionFilterProp="label"
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 160, textAlign: 'left' }}
            />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>
            {d.sheet_material_type_id ? (sheetMaterials.byId.get(d.sheet_material_type_id)?.label ?? '') : ''}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Примечание</div>,
      dataIndex: 'note',
      key: 'note',
      width: 100,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="note" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Примечание" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{d.note || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Цена за кв.м.</div>,
      dataIndex: 'milling_cost_per_sqm',
      key: 'milling_cost_per_sqm',
      width: 70,
      align: 'right',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="milling_cost_per_sqm" style={{ margin: 0, padding: '0 4px' }}>
            <InputNumber
              controls={false}
              style={{ width: '100%', minWidth: '90px' }}
              precision={2}
              min={0}
              formatter={currencySmartFormatter}
              parser={numberParser}
              onChange={handleMillingCostChange}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          <span>
            {d.milling_cost_per_sqm !== null && d.milling_cost_per_sqm !== undefined ? formatNumber(d.milling_cost_per_sqm, 2) : '—'}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Сумма</div>,
      dataIndex: 'detail_cost',
      key: 'detail_cost',
      width: 70,
      align: 'right',
      sorter: (a: OrderDetail, b: OrderDetail) => (a.detail_cost || 0) - (b.detail_cost || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        if (isEditing(d)) {
          return (
            <Form.Item
              name="detail_cost"
              style={{ margin: 0, padding: '0 4px' }}
            >
              <InputNumber
                controls={false}
                style={{ width: '100%', minWidth: '90px' }}
                precision={2}
                min={0}
                formatter={currencySmartFormatter}
                parser={numberParser}
                disabled={!isSumEditable}
                onContextMenu={(e) => {
                  if (!isSumEditable) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSumContextMenu({ x: e.clientX, y: e.clientY });
                  }
                }}
                onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
              />
            </Form.Item>
          );
        }
        const value = d.detail_cost;
        const hasValue = value !== null && value !== undefined;
        const manualOverride = isCostManuallyEdited(d);
        const color = !hasValue
          ? '#d32029'
          : manualOverride
          ? '#ad4e00'
          : undefined;
        const fontWeight = manualOverride || !hasValue ? 600 : undefined;
        const title = !hasValue
          ? 'Сумма не рассчитана'
          : manualOverride
          ? 'Значение отличается от авторасчета'
          : undefined;

        return (
          <span style={{ color, fontWeight }} title={title}>
            {hasValue ? formatNumber(value, 2) : '—'}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Пленка</div>,
      dataIndex: 'film_id',
      key: 'film_id',
      width: 120,
      sorter: (a: OrderDetail, b: OrderDetail) => (a.film_id || 0) - (b.film_id || 0),
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="film_id" style={{ margin: 0, padding: '0 4px' }}>
            <Select
              {...resolvedFilmSelectProps}
              allowClear
              placeholder="Плёнка"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 200, textAlign: 'left' }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  handleTabOnLastField(e, d);
                }
              }}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: '8px 0' }} />
                  <Button
                    type="text"
                    icon={<PlusOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFilmQuickCreateOpen(true);
                    }}
                    style={{ width: '100%', textAlign: 'left', color: '#1890ff' }}
                  >
                    Создать плёнку
                  </Button>
                </>
              )}
            />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '11px' }}>
            {d.film_id ? (
              <FilmCell
                filmId={d.film_id}
                namesById={filmNameById}
                loading={referencesLoading}
              />
            ) : '—'}
          </span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Пр-т</div>,
      dataIndex: 'priority',
      key: 'priority',
      width: 35,
      align: 'center',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="priority" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <InputNumber
              controls={false}
              style={{ width: '100%', minWidth: '60px' }}
              min={1}
              max={999}
              tabIndex={-1}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          formatNumber(d.priority, 0)
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Статус</div>,
      dataIndex: 'production_status_id',
      key: 'production_status_id',
      width: 120,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="production_status_id" style={{ margin: 0, padding: '0 4px' }}>
            <Select
              {...resolvedProductionStatusSelectProps}
              allowClear
              placeholder="Статус"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 150, textAlign: 'left' }}
              tabIndex={-1}
            />
          </Form.Item>
        ) : (
          d.production_status_id ? (
            <ProductionStatusCell
              statusId={d.production_status_id}
              namesById={productionStatusNameById}
              loading={referencesLoading}
            />
          ) : <Tag>Не назначен</Tag>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис проект</div>,
      dataIndex: 'basis_project',
      key: 'basis_project',
      width: 120,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="basis_project" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Базис проект" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{d.basis_project || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис данные</div>,
      dataIndex: 'basis_data',
      key: 'basis_data',
      width: 160,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="basis_data" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Номер/Обозначение/Наименование" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{d.basis_data || ''}</span>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Базис обозн.</div>,
      dataIndex: 'basis_designation',
      key: 'basis_designation',
      width: 90,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="basis_designation" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Обозн." onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{d.basis_designation || ''}</span>
        );
      },
    },
    {
      title: (
        <div style={{ whiteSpace: 'normal', lineHeight: '1.2', textAlign: 'center' }}>
          Название<br />детали
        </div>
      ),
      dataIndex: 'detail_name',
      key: 'detail_name',
      width: 100,
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return isEditing(d) ? (
          <Form.Item name="detail_name" style={{ margin: 0, padding: '0 4px' }}>
            <Input
              placeholder="Название детали"
              tabIndex={-1}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
            />
          </Form.Item>
        ) : (
          d.detail_name || '—'
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Действия</span></div>,
      key: 'actions',
      width: 40,
      fixed: 'right',
      onCell: (row: any) => row?.kind === 'separator' ? { colSpan: 0 } : {},
      render: (_: any, row: any) => {
        const d = asDetail(row);
        if (!d) return null;
        return (
          <Space size={2}>
            {isEditing(d) ? (
              <>
                {dimensionValidationError && (
                  <Tooltip title={dimensionValidationError}>
                    <ExclamationCircleOutlined style={{ fontSize: '14px', color: '#ff4d4f', marginRight: '4px' }} />
                  </Tooltip>
                )}
                <Button
                  type="text"
                  size="small"
                  icon={<CheckOutlined style={{ fontSize: '16px', color: dimensionValidationError ? 'var(--app-border)' : '#52c41a' }} />}
                  onClick={() => saveEdit(d)}
                  style={{ padding: '0 4px' }}
                  disabled={!!dimensionValidationError}
                />
              </>
            ) : (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined style={{ fontSize: '12px' }} />}
                onClick={() => startEdit(d)}
                style={{ padding: '0 4px' }}
              />
            )}
          </Space>
        );
      },
    },
  ];

  const visibleColumns = useMemo(
    () => applyOrderDetailColumnSettings(columns, columnSettings),
    [columns, columnSettings],
  );

  // Number of visible data columns (excl. AntD-injected selection column).
  // Used to set colSpan on separator rows so they span the full width.
  const DATA_COLUMN_COUNT = visibleColumns.length;

  // Plain conditional — no memo — so render closures (isEditing, lookup maps,
  // Form watches) are always fresh. A stale memo on [groupingActive] would
  // freeze the closures captured at activation, breaking inline editing.
  const renderedColumns = groupingActive
    ? visibleColumns.map((col: any) => {
        const { sorter, defaultSortOrder, sortOrder, ...rest } = col;
        return rest;
      })
    : visibleColumns;

  const rowSelection = onSelectChange
    ? {
        selectedRowKeys,
        onChange: (keys: React.Key[]) =>
          onSelectChange(keys.filter((k) => typeof k !== 'string' || !k.startsWith('__sep__'))),
        columnWidth: 24,
        getCheckboxProps: (row: any) =>
          row?.kind === 'separator' ? { disabled: true, style: { display: 'none' } } : {},
        renderCell: (_c: boolean, row: any, _i: number, node: React.ReactNode) => {
          if (row?.kind !== 'separator') return node;
          if (!cutSelectable) return null;
          const state = groupCheckboxState(selectedRowKeys, row.selectionKeys);
          if (state === 'empty') return null;
          return (
            <Checkbox
              checked={state === 'checked'}
              indeterminate={state === 'indeterminate'}
              onChange={() => onSelectChange?.(toggleGroupSelection(selectedRowKeys, row.selectionKeys))}
            />
          );
        },
      }
    : undefined;

  const closeRowContextMenu = useCallback(() => {
    setRowContextMenu(null);
  }, []);

  const truncateText = useCallback((value: string, maxLength: number): string => {
    const text = (value || '').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1).trimEnd() + '…';
  }, []);

  const renderMenuValue = useCallback((value: string, maxLength = 42): React.ReactNode => {
    const text = (value || '').trim();
    const short = truncateText(text, maxLength);
    if (short === text) return <span>{text}</span>;
    return (
      <Tooltip title={text}>
        <span>{short}</span>
      </Tooltip>
    );
  }, [truncateText]);

  const getOptionsMap = useCallback(
    (options?: any[]) => buildNameByIdMap(options as any[] | undefined),
    [],
  );

  const sheetNameById = useMemo(
    () => new Map(sheetMaterials.options.map(o => [o.value as number, o.label])),
    [sheetMaterials.options]
  );
  const millingNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.millingTypeNameById
        : getOptionsMap(millingTypeSelectProps.options as any[] | undefined),
    [
      getOptionsMap,
      millingTypeSelectProps.options,
      orderFormData.references.millingTypeNameById,
      useBackendReferences,
    ]
  );
  const edgeNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.edgeTypeNameById
        : getOptionsMap(edgeTypeSelectProps.options as any[] | undefined),
    [
      edgeTypeSelectProps.options,
      getOptionsMap,
      orderFormData.references.edgeTypeNameById,
      useBackendReferences,
    ]
  );
  const filmNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.filmNameById
        : getOptionsMap(filmSelectProps.options as any[] | undefined),
    [
      filmSelectProps.options,
      getOptionsMap,
      orderFormData.references.filmNameById,
      useBackendReferences,
    ]
  );

  const productionStatusNameById = useMemo(
    () =>
      useBackendReferences
        ? orderFormData.references.productionStatusNameById
        : getOptionsMap(productionStatusSelectProps.options as any[] | undefined),
    [
      getOptionsMap,
      orderFormData.references.productionStatusNameById,
      productionStatusSelectProps.options,
      useBackendReferences,
    ]
  );

  // One readiness flag: backend mode uses useOrderFormData; legacy mode uses the
  // already-loaded select queries. While loading, an unresolved id shows a
  // neutral placeholder instead of "Не найден".
  const referencesLoading = useBackendReferences
    ? orderFormData.isLoading
    : !millingTypeSelectProps.options;

  const groupLabelOf = useCallback((sample: any, field: string) => {
    switch (field) {
      case 'milling': return millingNameById.get(sample.milling_type_id) || '—';
      case 'material': return sheetNameById.get(sample.sheet_material_type_id) || '—';
      case 'film': return sample.film_id != null ? (filmNameById.get(sample.film_id) || '—') : '—';
      case 'edge': return edgeNameById.get(sample.edge_type_id) || '—';
      case 'price': return sample.milling_cost_per_sqm != null ? String(sample.milling_cost_per_sqm) : '—';
      case 'note': return (sample.note || '').trim() || '—';
      default: return '—';
    }
  }, [millingNameById, sheetNameById, filmNameById, edgeNameById]);

  const tableRows = useMemo(
    () => (groupingActive
      ? buildGroupedRows(sortedDetails, groupField!, {
          includeLeadingSeparator: cutSelectable,
          groupKeyOf: (dd: any) => (dd.detail_id != null ? (dd.temp_id ?? dd.detail_id) : null),
          groupLabelOf,
        })
      : sortedDetails),
    [groupingActive, sortedDetails, groupField, cutSelectable, groupLabelOf],
  );

  const selectRows = useCallback((predicate: (detail: OrderDetail) => boolean) => {
    if (!onSelectChange) return;
    const keys = sortedDetails.filter(predicate).map(getRowKey);
    onSelectChange(keys);
    closeRowContextMenu();
  }, [closeRowContextMenu, getRowKey, onSelectChange, sortedDetails]);

  const uniqueIds = useCallback((items: OrderDetail[], getId: (d: OrderDetail) => number | null | undefined) => {
    const set = new Set<number>();
    for (const item of items) {
      const value = getId(item);
      if (value === null || value === undefined) continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) continue;
      set.add(num);
    }
    return Array.from(set);
  }, []);

  const uniqueStrings = useCallback((items: OrderDetail[], getValue: (d: OrderDetail) => string | null | undefined) => {
    const set = new Set<string>();
    for (const item of items) {
      const value = (getValue(item) || '').trim();
      if (!value) continue;
      set.add(value);
    }
    return Array.from(set);
  }, []);

  const uniquePrices = useCallback((items: OrderDetail[]) => {
    const set = new Set<string>();
    for (const item of items) {
      const value = item.milling_cost_per_sqm;
      if (value === null || value === undefined) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      set.add(num.toFixed(2));
    }
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, []);

  const selectionAggregates = useMemo(() => {
    const millingIds = uniqueIds(sortedDetails, d => d.milling_type_id);
    const sheetTypeIds = uniqueIds(sortedDetails, d => d.sheet_material_type_id);
    const filmIds = uniqueIds(sortedDetails, d => d.film_id ?? null);
    const edgeIds = uniqueIds(sortedDetails, d => d.edge_type_id);
    const prices = uniquePrices(sortedDetails);
    const noteValues = uniqueStrings(sortedDetails, d => d.note ?? null).sort((a, b) => a.localeCompare(b, 'ru'));

    return {
      millingIds,
      materialIds: sheetTypeIds,
      filmIds,
      edgeIds,
      prices,
      noteValues,
      hasEmptyMilling: sortedDetails.some(d => {
        const value = d.milling_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyMaterial: sortedDetails.some(d => {
        const value = d.sheet_material_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyFilm: sortedDetails.some(d => {
        const value = d.film_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyEdge: sortedDetails.some(d => {
        const value = d.edge_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      }),
      hasEmptyPrice: sortedDetails.some(d => {
        const value = d.milling_cost_per_sqm;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num);
      }),
      hasEmptyNote: sortedDetails.some(d => !(d.note || '').trim()),
      hasPrisadka: sortedDetails.some(d => (d.note || '').includes('Присадка')),
      hasChernovoy: sortedDetails.some(d => (d.note || '').includes('Черновой')),
    };
  }, [sortedDetails, uniqueIds, uniquePrices, uniqueStrings]);

  const noteValueKeyToValue = useMemo(() => {
    const map = new Map<string, string>();
    selectionAggregates.noteValues.forEach((value, index) => {
      map.set(`select:note:value#${index}`, value);
    });
    return map;
  }, [selectionAggregates.noteValues]);

  const selectionMenuItems: MenuProps['items'] = useMemo(() => {
    const sortByLabel = (ids: number[], map: Map<number, string>) =>
      ids
        .map(id => ({ id, label: map.get(id) || `ID: ${id}` }))
        .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
        .map(x => x.id);

    const buildValueItems = (
      emptyKey: string,
      hasEmptyValue: boolean,
      values: Array<{ key: string; label: React.ReactNode }>
    ): MenuProps['items'] => {
      const items: MenuProps['items'] = [];
      if (hasEmptyValue) {
        items.push({ key: `${emptyKey}:empty`, label: '—' });
      }
      items.push(...values);
      if (items.length === 0) {
        return [{ key: `${emptyKey}:none`, label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }];
      }
      return items;
    };

    const millingItems = buildValueItems(
      'select:milling',
      selectionAggregates.hasEmptyMilling,
      sortByLabel(selectionAggregates.millingIds, millingNameById).map(id => ({
        key: `select:milling:${id}`,
        label: renderMenuValue(millingNameById.get(id) || `ID: ${id}`),
      }))
    );

    const materialItems = buildValueItems(
      'select:material',
      selectionAggregates.hasEmptyMaterial,
      sortByLabel(selectionAggregates.materialIds, sheetNameById).map(id => ({
        key: `select:material:${id}`,
        label: renderMenuValue(sheetNameById.get(id) || `ID: ${id}`),
      }))
    );

    const filmItems = buildValueItems(
      'select:film',
      selectionAggregates.hasEmptyFilm,
      sortByLabel(selectionAggregates.filmIds, filmNameById).map(id => ({
        key: `select:film:${id}`,
        label: renderMenuValue(filmNameById.get(id) || `ID: ${id}`, 36),
      }))
    );

    const edgeItems = buildValueItems(
      'select:edge',
      selectionAggregates.hasEmptyEdge,
      sortByLabel(selectionAggregates.edgeIds, edgeNameById).map(id => ({
        key: `select:edge:${id}`,
        label: renderMenuValue(edgeNameById.get(id) || `ID: ${id}`),
      }))
    );

    const priceItems = buildValueItems(
      'select:price',
      selectionAggregates.hasEmptyPrice,
      selectionAggregates.prices.map(value => ({
        key: `select:price:${value}`,
        label: renderMenuValue(value),
      }))
    );

    const noteItems: MenuProps['items'] = [];
    if (selectionAggregates.hasEmptyNote) {
      noteItems.push({ key: 'select:note:empty', label: '—' });
    }
    if (selectionAggregates.hasPrisadka) {
      noteItems.push({ key: 'select:note:contains:prisadka', label: renderMenuValue('Присадка') });
    }
    if (selectionAggregates.hasChernovoy) {
      noteItems.push({ key: 'select:note:contains:chernovoy', label: renderMenuValue('Черновой') });
    }
    for (const [key, value] of noteValueKeyToValue.entries()) {
      noteItems.push({ key, label: renderMenuValue(value, 44) });
    }

    const categories: MenuProps['items'] = [
      { key: 'select:category:milling', label: 'по фрезеровке', children: millingItems },
      { key: 'select:category:materials', label: 'по материалам', children: materialItems },
      { key: 'select:category:films', label: 'по пленкам', children: filmItems },
      { key: 'select:category:edges', label: 'по обкату', children: edgeItems },
      { key: 'select:category:prices', label: 'по ценам', children: priceItems },
      { key: 'select:category:notes', label: 'по примечанию', children: noteItems.length ? noteItems : [{ key: 'select:note:none', label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }] },
    ];

    return [
      { key: 'action:insert', label: 'Вставить строку', icon: <PlusOutlined style={{ color: '#1890ff' }} /> },
      { key: 'action:copy', label: 'Скопировать строку', icon: <CopyOutlined style={{ color: '#52c41a' }} /> },
      { type: 'divider' as const },
      { key: 'select', label: 'Выделить', children: categories, disabled: !onSelectChange || sortedDetails.length === 0 },
      { type: 'divider' as const },
      { key: 'action:delete', label: 'Удалить строку', icon: <DeleteOutlined />, danger: true },
    ];
  }, [
    edgeNameById,
    filmNameById,
    sheetNameById,
    millingNameById,
    noteValueKeyToValue,
    onSelectChange,
    renderMenuValue,
    selectionAggregates.edgeIds,
    selectionAggregates.filmIds,
    selectionAggregates.hasChernovoy,
    selectionAggregates.hasEmptyEdge,
    selectionAggregates.hasEmptyFilm,
    selectionAggregates.hasEmptyMaterial,
    selectionAggregates.hasEmptyMilling,
    selectionAggregates.hasEmptyNote,
    selectionAggregates.hasEmptyPrice,
    selectionAggregates.hasPrisadka,
    selectionAggregates.materialIds,
    selectionAggregates.millingIds,
    selectionAggregates.prices,
    sortedDetails.length,
  ]);

  const handleContextMenuClick: MenuProps['onClick'] = useCallback((info) => {
    const key = String(info.key);

    if (key === 'action:insert') {
      if (rowContextMenu?.record) {
        onInsertAfter?.(rowContextMenu.record);
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'action:copy') {
      if (rowContextMenu?.record) {
        onCopyRow?.(rowContextMenu.record);
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'action:delete') {
      if (rowContextMenu?.record) {
        const tempId = rowContextMenu.record.temp_id || rowContextMenu.record.detail_id;
        if (tempId) {
          onDelete(tempId, rowContextMenu.record.detail_id);
        }
      }
      closeRowContextMenu();
      return;
    }

    if (key === 'select:milling:empty') {
      selectRows(d => {
        const value = d.milling_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:milling:')) {
      const id = Number(key.replace('select:milling:', ''));
      selectRows(d => Number(d.milling_type_id) === id);
      return;
    }

    if (key === 'select:material:empty') {
      selectRows(d => {
        const value = d.sheet_material_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:material:')) {
      const id = Number(key.replace('select:material:', ''));
      selectRows(d => Number(d.sheet_material_type_id) === id);
      return;
    }

    if (key === 'select:film:empty') {
      selectRows(d => {
        const value = d.film_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:film:')) {
      const id = Number(key.replace('select:film:', ''));
      selectRows(d => Number(d.film_id) === id);
      return;
    }

    if (key === 'select:edge:empty') {
      selectRows(d => {
        const value = d.edge_type_id;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num) || num <= 0;
      });
      return;
    }

    if (key.startsWith('select:edge:')) {
      const id = Number(key.replace('select:edge:', ''));
      selectRows(d => Number(d.edge_type_id) === id);
      return;
    }

    if (key === 'select:price:empty') {
      selectRows(d => {
        const value = d.milling_cost_per_sqm;
        if (value === null || value === undefined) return true;
        const num = Number(value);
        return !Number.isFinite(num);
      });
      return;
    }

    if (key.startsWith('select:price:')) {
      const value = key.replace('select:price:', '');
      selectRows(d => d.milling_cost_per_sqm !== null && d.milling_cost_per_sqm !== undefined && Number(d.milling_cost_per_sqm).toFixed(2) === value);
      return;
    }

    if (key === 'select:note:empty') {
      selectRows(d => !(d.note || '').trim());
      return;
    }

    if (key === 'select:note:contains:prisadka') {
      selectRows(d => (d.note || '').includes('Присадка'));
      return;
    }

    if (key === 'select:note:contains:chernovoy') {
      selectRows(d => (d.note || '').includes('Черновой'));
      return;
    }

    if (key.startsWith('select:note:value#')) {
      const note = noteValueKeyToValue.get(key);
      if (note) {
        selectRows(d => (d.note || '').trim() === note);
      } else {
        closeRowContextMenu();
      }
    }
  }, [closeRowContextMenu, noteValueKeyToValue, onCopyRow, onDelete, onInsertAfter, rowContextMenu?.record, selectRows]);

  // Handle film quick create success
  const handleFilmCreated = (filmId: number) => {
    // Set the newly created film in the current editing row
    form.setFieldsValue({ film_id: filmId });
    // Refetch film options to include the new film
    filmQueryResult.refetch();
  };

  return (
    <>
    <Form form={form} component={false}>
      <div
        ref={tableContainerRef}
        className={dragSelection.isDragging ? 'drag-selection-active' : ''}
        style={{ position: 'relative' }}
      >
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {groupingControls}
        <OrderDetailColumnSettingsButton
          tableKey="orderEdit"
          definitions={ORDER_DETAIL_EDIT_COLUMN_DEFINITIONS}
          defaultOrder={ORDER_DETAIL_EDIT_DEFAULT_ORDER}
          settings={columnSettings}
          onChange={saveColumnSettings}
        />
      </div>
      <Table<any>
        className={`order-details-table${groupingActive ? ' details-grouped' : ''}`}
        dataSource={tableRows as any}
        columns={renderedColumns}
        rowKey={(row: any) => {
          if (row?.kind === 'separator') return row.key;
          const d = row?.kind === 'detail' ? row.detail : row;
          return d.temp_id ?? d.detail_id ?? 0;
        }}
        rowSelection={rowSelection}
        showSorterTooltip={false}
        pagination={groupingActive ? false : {
          pageSize: pageSize,
          showSizeChanger: true,
          showTotal: (total) => `Всего: ${total} позиций`,
          onShowSizeChange: (current, size) => setPageSize(size),
          onChange: (page, size) => setPageSize(size),
        }}
        scroll={{ x: 1780, y: 500 }}
        size="small"
        bordered
        rowClassName={(row: any) => {
          if (row?.kind === 'separator') return 'detail-group-separator';
          const record = asDetail(row)!;
          const rowKey = record.temp_id || record.detail_id || 0;
          if (!groupingActive) {
            return dragSelection.isInPendingSelection(rowKey) ? 'drag-selection-pending' : '';
          }
          const groupIndex = row?.kind === 'detail' ? row.groupIndex : 0;
          const classes = [`detail-group-tint-${groupIndex % GROUP_TINT_COUNT}`];
          if (isEditing(record)) classes.push('dg-editing');
          else if (dragSelection.isInPendingSelection(rowKey)) classes.push('dg-pending');
          else if (highlightedRowKey !== null && rowKey === highlightedRowKey) classes.push('dg-highlight');
          return classes.join(' ');
        }}
        summary={() => (
          <Table.Summary fixed="bottom">
            <Table.Summary.Row style={{ backgroundColor: 'var(--app-surface-muted)', fontWeight: 'bold' }}>
              {rowSelection && <Table.Summary.Cell index={0} />}
              {visibleColumns.map((column, index) => {
                const key = String(column.key ?? '');
                const base = rowSelection ? 1 : 0;
                if (key === 'detail_number') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="center">
                      <FitSummaryText align="center" style={{ color: '#666' }}>{details.length}</FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                if (key === 'quantity') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="right">
                      <FitSummaryText align="right" style={{ color: '#1890ff' }}>{formatNumber(totals.quantity, 0)}</FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                if (key === 'area') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="right">
                      <FitSummaryText align="right" style={{ color: '#1890ff' }}>
                        {`${formatNumber(totals.area, 2)} м\u00B2`}
                      </FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                if (key === 'detail_cost') {
                  return (
                    <Table.Summary.Cell key={key} index={base + index} align="right">
                      <FitSummaryText align="right" style={{ color: '#52c41a' }}>{formatNumber(totals.detail_cost, 2)}</FitSummaryText>
                    </Table.Summary.Cell>
                  );
                }
                return <Table.Summary.Cell key={key || index} index={base + index} />;
              })}
            </Table.Summary.Row>
          </Table.Summary>
        )}
        onRow={(row: any, index) => {
          if (row?.kind === 'separator') {
            return { style: { cursor: 'default', userSelect: 'none' as const } };
          }
          const record = asDetail(row)!;
          const rowKey = record.temp_id || record.detail_id || 0;
          const isHighlighted = highlightedRowKey !== null && rowKey === highlightedRowKey;
          const isCurrentlyEditing = isEditing(record);
          const isPendingSelection = dragSelection.isInPendingSelection(rowKey);

          return {
            ref: isHighlighted ? highlightedRowRef : undefined,
            style: {
              backgroundColor: isCurrentlyEditing
                ? 'var(--app-highlight)' // Warm yellow for editing row
                : isPendingSelection
                ? 'var(--app-selection-bg)' // Light blue for pending drag selection
                : isHighlighted
                ? 'var(--app-selection-bg)' // Light blue for highlighted row
                : (index! % 2 === 0 ? 'var(--app-surface)' : 'var(--app-surface-muted)'),
              boxShadow: isCurrentlyEditing ? '0 4px 12px rgba(0, 0, 0, 0.15)' : 'none',
              transform: isCurrentlyEditing ? 'scale(1.01)' : 'scale(1)',
              position: isCurrentlyEditing ? 'relative' as const : 'relative' as const,
              zIndex: isCurrentlyEditing ? 10 : 1,
              transition: 'all 0.3s ease',
              border: isCurrentlyEditing ? '2px solid #faad14' : 'none',
            },
            // Drag selection handlers
            onMouseDown: (e) => {
              // Only start drag if not editing and not clicking interactive elements
              if (!isCurrentlyEditing) {
                dragSelection.handleMouseDown(rowKey, e);
              }
             },
             onMouseEnter: () => {
               if (dragSelection.isDragging) {
                 dragSelection.handleMouseEnter(rowKey);
               }
             },
             onDoubleClick: () => startEdit(record),
             onContextMenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                setRowContextMenu({ x: e.clientX, y: e.clientY, record });
              },
            };
          }}
        />

        <Dropdown
          open={!!rowContextMenu}
          placement="bottomLeft"
          destroyPopupOnHide={false}
          menu={{ items: selectionMenuItems, onClick: handleContextMenuClick }}
          getPopupContainer={() => document.body}
          overlayClassName="order-details-select-context-dropdown"
          trigger={['click', 'contextMenu']}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              closeRowContextMenu();
            }
          }}
        >
          <span
            style={{
              position: 'fixed',
              left: rowContextMenu?.x ?? -9999,
              top: rowContextMenu?.y ?? -9999,
              width: 1,
              height: 1,
            }}
          />
        </Dropdown>

        <Dropdown
          open={!!sumContextMenu}
          placement="bottomLeft"
          destroyPopupOnHide={false}
          menu={{
            items: [
              {
                key: 'edit-sum',
                icon: <EditOutlined style={{ color: '#1890ff' }} />,
                label: <span style={{ color: '#1890ff' }}>Изменить значение в ячейке</span>,
              },
            ],
            onClick: () => {
              setIsSumEditable(true);
              setSumContextMenu(null);
            },
          }}
          getPopupContainer={() => document.body}
          overlayClassName="order-details-sum-context-dropdown"
          trigger={['contextMenu']}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setSumContextMenu(null);
            }
          }}
        >
          <span
            style={{
              position: 'fixed',
              left: sumContextMenu?.x ?? -9999,
              top: sumContextMenu?.y ?? -9999,
              width: 1,
              height: 1,
            }}
          />
        </Dropdown>
      </div>
    </Form>
    <FilmQuickCreate
      open={filmQuickCreateOpen}
      onClose={() => setFilmQuickCreateOpen(false)}
      onSuccess={handleFilmCreated}
    />
    </>
  );
});

// Pure reference cells: labels resolve from already-loaded name maps, so there
// is no per-row network request. `loading` only governs the placeholder shown
// before the batched reference list has arrived.
const MaterialCell: React.FC<{
  materialId: number;
  namesById: Map<number, string>;
  loading: boolean;
  resolvedName?: string | null;
}> = ({ materialId, namesById, loading, resolvedName }) => {
  // SP3: prefer the server-resolved COALESCE(sheet, material) name from the store
  // (Task 8 hydration) so a saved sheet detail shows the sheet name, never the
  // hidden shadow/disambiguated material. Legacy details resolve to the same name.
  if (resolvedName && String(resolvedName).trim()) {
    const color = getMaterialColor(String(resolvedName));
    return <span style={{ color }}>{resolvedName}</span>;
  }
  if (materialId === null || materialId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const materialName = resolveReferenceLabel(materialId, namesById);
  if (!materialName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  const color = getMaterialColor(materialName || '');
  return materialName ? (
    <span style={{ color }}>{materialName}</span>
  ) : (
    <span style={{ color: '#ff4d4f' }}>Не найден (ID: {materialId})</span>
  );
};

const MillingTypeCell: React.FC<{
  millingTypeId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ millingTypeId, namesById, loading }) => {
  if (millingTypeId === null || millingTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const millingTypeName = resolveReferenceLabel(millingTypeId, namesById);
  if (!millingTypeName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  const bgColor = getMillingBgColor(millingTypeName || '');
  return millingTypeName ? (
    <span style={{ backgroundColor: bgColor, padding: '2px 6px', borderRadius: '3px', display: 'inline-block' }}>
      {millingTypeName}
    </span>
  ) : (
    <span style={{ color: '#ff4d4f' }}>Не найден (ID: {millingTypeId})</span>
  );
};

const EdgeTypeCell: React.FC<{
  edgeTypeId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ edgeTypeId, namesById, loading }) => {
  if (edgeTypeId === null || edgeTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const edgeTypeName = resolveReferenceLabel(edgeTypeId, namesById);
  if (!edgeTypeName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{edgeTypeName || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {edgeTypeId})</span>}</span>;
};

const FilmCell: React.FC<{
  filmId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ filmId, namesById, loading }) => {
  if (filmId === null || filmId === undefined) return <span style={{ color: '#999' }}>—</span>;
  const filmName = resolveReferenceLabel(filmId, namesById);
  if (!filmName && loading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{filmName || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {filmId})</span>}</span>;
};

const ProductionStatusCell: React.FC<{
  statusId: number;
  namesById: Map<number, string>;
  loading: boolean;
}> = ({ statusId, namesById, loading }) => {
  const statusName = resolveReferenceLabel(statusId, namesById);
  if (!statusName && loading) return <Tag color="blue">…</Tag>;
  return <Tag color="blue">{statusName || `ID: ${statusId}`}</Tag>;
};

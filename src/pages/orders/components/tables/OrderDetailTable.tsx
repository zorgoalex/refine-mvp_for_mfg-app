// Order Details Table
// Displays list of order details with inline editing capabilities
//
// FIX: InputNumber стрелки теперь работают корректно при быстрых кликах
// Проблема: race condition между внутренним состоянием InputNumber и Form.Item
// Решение: используем useRef для синхронного хранения значений полей

import React, { useMemo, useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Table, Button, Tag, Space, Form, InputNumber, Input, Select, Dropdown, Tooltip, Divider } from 'antd';
import type { MenuProps } from 'antd';
import { EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined, ExclamationCircleOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons';
import { useDragSelection } from '../../../../hooks/useDragSelection';
import { FilmQuickCreate } from '../modals/FilmQuickCreate';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useOne } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { formatNumber, currencySmartFormatter, numberParser } from '../../../../utils/numberFormat';
import { CurrencyInput } from '../../../../components/CurrencyInput';
import { getMaterialColor, getMillingBgColor } from '../../../../config/displayColors';
import {
  validateMaterialDimensions,
  MaterialInfo
} from '../../../../utils/materialDimensionValidation';

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
}, ref) => {
  const { details, updateDetail, deleteDetail, setDetailEditing } = useOrderFormStore();

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
    autoScrollZone: 60,
    autoScrollSpeed: 10,
  });

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
  const [selectedMaterialId, setSelectedMaterialId] = useState<number | null>(null);
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
  const watchedMaterialId = Form.useWatch('material_id', form);
  const watchedMillingTypeId = Form.useWatch('milling_type_id', form);
  const watchedEdgeTypeId = Form.useWatch('edge_type_id', form);

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
  const { selectProps: materialSelectProps } = useSelect({
    resource: 'materials',
    optionLabel: 'material_name',
    optionValue: 'material_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled },
  });
  const { selectProps: filmSelectProps, queryResult: filmQueryResult } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled },
    defaultValue: currentFilmId ?? undefined,
  });

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
    queryOptions: { enabled: selectsEnabled },
  });

  // Load selected material with type information for validation
  const { data: materialData } = useOne({
    resource: 'materials',
    id: selectedMaterialId || 0,
    queryOptions: {
      enabled: selectedMaterialId !== null && selectedMaterialId > 0,
    },
    meta: {
      fields: [
        'material_id',
        'material_name',
        { material_type: ['material_type_id', 'material_type_name'] }
      ],
    },
  });

  // Validate dimensions against material limits
  const validateDimensions = useCallback(() => {
    const height = fieldValuesRef.current.height ?? form.getFieldValue('height');
    const width = fieldValuesRef.current.width ?? form.getFieldValue('width');

    if (!height || !width || !materialData?.data) {
      setDimensionValidationError(null);
      return;
    }

    const material: MaterialInfo = {
      material_id: materialData.data.material_id,
      material_name: materialData.data.material_name,
      material_type_id: materialData.data.material_type?.material_type_id,
      material_type_name: materialData.data.material_type?.material_type_name,
    };

    const validationResult = validateMaterialDimensions(height, width, material);

    if (!validationResult.isValid) {
      setDimensionValidationError(validationResult.errorMessage || null);
    } else {
      setDimensionValidationError(null);
    }
  }, [form, materialData]);

  // Trigger validation when material data loads
  useEffect(() => {
    if (materialData?.data) {
      validateDimensions();
    }
  }, [materialData, validateDimensions]);

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
    setSelectedMaterialId(record.material_id || null);
    setDimensionValidationError(null);
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
      material_id: record.material_id,
      milling_type_id: record.milling_type_id,
      edge_type_id: record.edge_type_id,
      film_id: record.film_id ?? null,
      milling_cost_per_sqm: record.milling_cost_per_sqm ?? null,
      detail_cost: record.detail_cost ?? null,
      note: record.note ?? '',
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
    setSelectedMaterialId(null);
    setDimensionValidationError(null);
    setIsSumEditable(false);
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

  // Handle material change
  const handleMaterialChange = (materialId: number) => {
    setSelectedMaterialId(materialId);
    // Validation will be triggered by useEffect when materialData loads
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

  const columns: ColumnsType<OrderDetail> = [
    {
      title: <div style={{ textAlign: 'center', fontSize: '70%' }}>№</div>,
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: 27,
      fixed: 'left',
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.detail_number - b.detail_number,
      render: (value) => <span style={{ color: '#999', fontSize: '67%' }}>{value}</span>,
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
      sorter: (a, b) => (a.height || 0) - (b.height || 0),
      render: (value, record) => {
        if (!isEditing(record)) {
          const num = Number(value);
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
      sorter: (a, b) => (a.width || 0) - (b.width || 0),
      render: (value, record) => {
        if (!isEditing(record)) {
          const num = Number(value);
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
      sorter: (a, b) => (a.quantity || 0) - (b.quantity || 0),
      render: (value, record) =>
        isEditing(record) ? (
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
          formatNumber(value, 0)
        ),
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
      sorter: (a, b) => (a.area || 0) - (b.area || 0),
      render: (value, record) =>
        isEditing(record) ? (
          <Form.Item name="area" style={{ margin: 0, padding: '0 4px' }}>
            <InputNumber style={{ width: '100%', minWidth: '85px' }} precision={2} disabled onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          formatNumber(value, 2) + ' м²'
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Фрезеровка</div>,
      dataIndex: 'milling_type_id',
      key: 'milling_type_id',
      width: 85,
      align: 'center',
      sorter: (a, b) => (a.milling_type_id || 0) - (b.milling_type_id || 0),
      render: (millingTypeId, record) =>
        isEditing(record) ? (
          <Form.Item name="milling_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...millingTypeSelectProps}
              placeholder="Тип фрезеровки"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 150, textAlign: 'left', ...getRequiredFieldStyle(watchedMillingTypeId) }}
            />
          </Form.Item>
        ) : (
          <MillingTypeCell millingTypeId={millingTypeId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Обкат</span></div>,
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 52,
      align: 'center',
      render: (edgeTypeId, record) =>
        isEditing(record) ? (
          <Form.Item name="edge_type_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...edgeTypeSelectProps}
              placeholder="Тип кромки"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 120, textAlign: 'left', ...getRequiredFieldStyle(watchedEdgeTypeId) }}
            />
          </Form.Item>
        ) : (
          <EdgeTypeCell edgeTypeId={edgeTypeId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Материал</div>,
      dataIndex: 'material_id',
      key: 'material_id',
      width: 80,
      align: 'center',
      sorter: (a, b) => (a.material_id || 0) - (b.material_id || 0),
      render: (materialId, record) =>
        isEditing(record) ? (
          <Form.Item name="material_id" style={{ margin: 0, padding: '0 4px' }} rules={[{ required: true }]}>
            <Select
              {...materialSelectProps}
              placeholder="Материал"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 180, textAlign: 'left', ...getRequiredFieldStyle(watchedMaterialId) }}
              onChange={handleMaterialChange}
            />
          </Form.Item>
        ) : (
          <MaterialCell materialId={materialId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Примечание</div>,
      dataIndex: 'note',
      key: 'note',
      width: 100,
      render: (text, record) =>
        isEditing(record) ? (
          <Form.Item name="note" style={{ margin: 0, padding: '0 4px' }}>
            <Input placeholder="Примечание" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          <span style={{ fontSize: '90%' }}>{text || ''}</span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Цена за кв.м.</div>,
      dataIndex: 'milling_cost_per_sqm',
      key: 'milling_cost_per_sqm',
      width: 70,
      align: 'right',
      render: (value, record) =>
        isEditing(record) ? (
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
            {value !== null && value !== undefined ? formatNumber(value, 2) : '—'}
          </span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Сумма</div>,
      dataIndex: 'detail_cost',
      key: 'detail_cost',
      width: 70,
      align: 'right',
      sorter: (a, b) => (a.detail_cost || 0) - (b.detail_cost || 0),
      render: (value, record) =>
        isEditing(record) ? (
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

                  // Remove any existing context menus first
                  const existingMenus = document.querySelectorAll('.sum-field-context-menu');
                  existingMenus.forEach(menu => menu.remove());

                  // Create context menu
                  const menu = document.createElement('div');
                  menu.className = 'ant-dropdown sum-field-context-menu';
                  menu.style.position = 'fixed';
                  menu.style.left = `${e.clientX}px`;
                  menu.style.top = `${e.clientY}px`;
                  menu.style.zIndex = '9999';

                  const menuContent = `
                    <ul class="ant-dropdown-menu" style="background: white; border: 1px solid #d9d9d9; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); padding: 4px 0;">
                      <li class="ant-dropdown-menu-item" style="padding: 5px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                        <span role="img" aria-label="edit" style="color: #1890ff;">
                          <svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor" aria-hidden="true">
                            <path d="M257.7 752c2 0 4-.2 6-.5L431.9 722c2-.4 3.9-1.3 5.3-2.8l423.9-423.9a9.96 9.96 0 000-14.1L694.9 114.9c-1.9-1.9-4.4-2.9-7.1-2.9s-5.2 1-7.1 2.9L256.8 538.8c-1.5 1.5-2.4 3.3-2.8 5.3l-29.5 168.2a33.5 33.5 0 009.4 29.8c6.6 6.4 14.9 9.9 23.8 9.9zm67.4-174.4L687.8 215l73.3 73.3-362.7 362.6-88.9 15.7 15.6-89zM880 836H144c-17.7 0-32 14.3-32 32v36c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-36c0-17.7-14.3-32-32-32z"></path>
                          </svg>
                        </span>
                        <span style="color: #1890ff;">Изменить значение в ячейке</span>
                      </li>
                    </ul>
                  `;
                  menu.innerHTML = menuContent;
                  document.body.appendChild(menu);

                  const menuItem = menu.querySelector('.ant-dropdown-menu-item');
                  menuItem?.addEventListener('click', () => {
                    setIsSumEditable(true);
                    menu.remove();
                  });

                  menuItem?.addEventListener('mouseenter', () => {
                    (menuItem as HTMLElement).style.backgroundColor = '#e6f7ff';
                  });

                  menuItem?.addEventListener('mouseleave', () => {
                    (menuItem as HTMLElement).style.backgroundColor = 'white';
                  });

                  const closeMenu = (event: MouseEvent) => {
                    if (!menu.contains(event.target as Node)) {
                      menu.remove();
                      document.removeEventListener('click', closeMenu);
                    }
                  };

                  setTimeout(() => {
                    document.addEventListener('click', closeMenu);
                  }, 0);
                }
              }}
              onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }}
            />
          </Form.Item>
        ) : (
          (() => {
            const hasValue = value !== null && value !== undefined;
            const manualOverride = isCostManuallyEdited(record);
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
          })()
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Пленка</div>,
      dataIndex: 'film_id',
      key: 'film_id',
      width: 120,
      sorter: (a, b) => (a.film_id || 0) - (b.film_id || 0),
      render: (filmId, record) =>
        isEditing(record) ? (
          <Form.Item name="film_id" style={{ margin: 0, padding: '0 4px' }}>
            <Select
              {...filmSelectProps}
              allowClear
              placeholder="Плёнка"
              showSearch
              filterOption={(input, option) => ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())}
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 200, textAlign: 'left' }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  handleTabOnLastField(e, record);
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
            {filmId ? <FilmCell filmId={filmId} /> : '—'}
          </span>
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Пр-т</div>,
      dataIndex: 'priority',
      key: 'priority',
      width: 35,
      align: 'center',
      render: (value, record) =>
        isEditing(record) ? (
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
          formatNumber(value, 0)
        ),
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Статус</div>,
      dataIndex: 'production_status_id',
      key: 'production_status_id',
      width: 120,
      render: (statusId, record) =>
        isEditing(record) ? (
          <Form.Item name="production_status_id" style={{ margin: 0, padding: '0 4px' }}>
            <Select
              {...productionStatusSelectProps}
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
          statusId ? <ProductionStatusCell statusId={statusId} /> : <Tag>Не назначен</Tag>
        ),
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
      render: (text, record) =>
        isEditing(record) ? (
          <Form.Item name="detail_name" style={{ margin: 0, padding: '0 4px' }}>
            <Input
              placeholder="Название детали"
              tabIndex={-1}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
            />
          </Form.Item>
        ) : (
          text || '—'
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Действия</span></div>,
      key: 'actions',
      width: 40,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          {isEditing(record) ? (
            <>
              {dimensionValidationError && (
                <Tooltip title={dimensionValidationError}>
                  <ExclamationCircleOutlined style={{ fontSize: '14px', color: '#ff4d4f', marginRight: '4px' }} />
                </Tooltip>
              )}
              <Button
                type="text"
                size="small"
                icon={<CheckOutlined style={{ fontSize: '16px', color: dimensionValidationError ? '#d9d9d9' : '#52c41a' }} />}
                onClick={() => saveEdit(record)}
                style={{ padding: '0 4px' }}
                disabled={!!dimensionValidationError}
              />
            </>
          ) : (
            <Button
              type="text"
              size="small"
              icon={<EditOutlined style={{ fontSize: '12px' }} />}
              onClick={() => startEdit(record)}
              style={{ padding: '0 4px' }}
            />
          )}
        </Space>
      ),
    },
  ];

  const rowSelection = onSelectChange
    ? {
        selectedRowKeys,
        onChange: onSelectChange,
        columnWidth: 24,
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

  const getOptionsMap = useCallback((options?: any[]) => {
    const map = new Map<number, string>();
    for (const option of options || []) {
      const value = option?.value;
      const label = option?.label;
      if (value === null || value === undefined) continue;
      map.set(Number(value), String(label ?? value));
    }
    return map;
  }, []);

  const materialNameById = useMemo(
    () => getOptionsMap(materialSelectProps.options as any[] | undefined),
    [getOptionsMap, materialSelectProps.options]
  );
  const millingNameById = useMemo(
    () => getOptionsMap(millingTypeSelectProps.options as any[] | undefined),
    [getOptionsMap, millingTypeSelectProps.options]
  );
  const edgeNameById = useMemo(
    () => getOptionsMap(edgeTypeSelectProps.options as any[] | undefined),
    [getOptionsMap, edgeTypeSelectProps.options]
  );
  const filmNameById = useMemo(
    () => getOptionsMap(filmSelectProps.options as any[] | undefined),
    [getOptionsMap, filmSelectProps.options]
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
    const materialIds = uniqueIds(sortedDetails, d => d.material_id);
    const filmIds = uniqueIds(sortedDetails, d => d.film_id ?? null);
    const edgeIds = uniqueIds(sortedDetails, d => d.edge_type_id);
    const prices = uniquePrices(sortedDetails);
    const noteValues = uniqueStrings(sortedDetails, d => d.note ?? null).sort((a, b) => a.localeCompare(b, 'ru'));

    return {
      millingIds,
      materialIds,
      filmIds,
      edgeIds,
      prices,
      noteValues,
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
      values: Array<{ key: string; label: React.ReactNode }>
    ): MenuProps['items'] => {
      if (values.length === 0) {
        return [{ key: `${emptyKey}:empty`, label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }];
      }
      return values;
    };

    const millingItems = buildValueItems(
      'select:milling',
      sortByLabel(selectionAggregates.millingIds, millingNameById).map(id => ({
        key: `select:milling:${id}`,
        label: renderMenuValue(millingNameById.get(id) || `ID: ${id}`),
      }))
    );

    const materialItems = buildValueItems(
      'select:material',
      sortByLabel(selectionAggregates.materialIds, materialNameById).map(id => ({
        key: `select:material:${id}`,
        label: renderMenuValue(materialNameById.get(id) || `ID: ${id}`),
      }))
    );

    const filmItems = buildValueItems(
      'select:film',
      sortByLabel(selectionAggregates.filmIds, filmNameById).map(id => ({
        key: `select:film:${id}`,
        label: renderMenuValue(filmNameById.get(id) || `ID: ${id}`, 36),
      }))
    );

    const edgeItems = buildValueItems(
      'select:edge',
      sortByLabel(selectionAggregates.edgeIds, edgeNameById).map(id => ({
        key: `select:edge:${id}`,
        label: renderMenuValue(edgeNameById.get(id) || `ID: ${id}`),
      }))
    );

    const priceItems = buildValueItems(
      'select:price',
      selectionAggregates.prices.map(value => ({
        key: `select:price:${value}`,
        label: renderMenuValue(value),
      }))
    );

    const noteItems: MenuProps['items'] = [];
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
      { key: 'select:category:notes', label: 'по примечанию', children: noteItems.length ? noteItems : [{ key: 'select:note:empty', label: <span style={{ color: '#999' }}>Нет данных</span>, disabled: true }] },
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
    materialNameById,
    millingNameById,
    noteValueKeyToValue,
    onSelectChange,
    renderMenuValue,
    selectionAggregates.edgeIds,
    selectionAggregates.filmIds,
    selectionAggregates.hasChernovoy,
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

    if (key.startsWith('select:milling:')) {
      const id = Number(key.replace('select:milling:', ''));
      selectRows(d => Number(d.milling_type_id) === id);
      return;
    }

    if (key.startsWith('select:material:')) {
      const id = Number(key.replace('select:material:', ''));
      selectRows(d => Number(d.material_id) === id);
      return;
    }

    if (key.startsWith('select:film:')) {
      const id = Number(key.replace('select:film:', ''));
      selectRows(d => Number(d.film_id) === id);
      return;
    }

    if (key.startsWith('select:edge:')) {
      const id = Number(key.replace('select:edge:', ''));
      selectRows(d => Number(d.edge_type_id) === id);
      return;
    }

    if (key.startsWith('select:price:')) {
      const value = key.replace('select:price:', '');
      selectRows(d => d.milling_cost_per_sqm !== null && d.milling_cost_per_sqm !== undefined && Number(d.milling_cost_per_sqm).toFixed(2) === value);
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
      <Table<OrderDetail>
        className="order-details-table"
        dataSource={sortedDetails}
        columns={columns}
        rowKey={(record) => record.temp_id || record.detail_id || 0}
        rowSelection={rowSelection}
        showSorterTooltip={false}
        pagination={{
          pageSize: pageSize,
          showSizeChanger: true,
          showTotal: (total) => `Всего: ${total} позиций`,
          onShowSizeChange: (current, size) => setPageSize(size),
          onChange: (page, size) => setPageSize(size),
        }}
        scroll={{ x: 1500, y: 500 }}
        size="small"
        bordered
        rowClassName={(record) => {
          const rowKey = record.temp_id || record.detail_id || 0;
          return dragSelection.isInPendingSelection(rowKey) ? 'drag-selection-pending' : '';
        }}
        summary={() => (
          <Table.Summary fixed="bottom">
            <Table.Summary.Row style={{ backgroundColor: '#fafafa', fontWeight: 'bold' }}>
              {/* Checkbox column */}
              <Table.Summary.Cell index={0} />
              {/* № */}
              <Table.Summary.Cell index={1} align="center">
                <span style={{ color: '#666' }}>{details.length}</span>
              </Table.Summary.Cell>
              {/* Высота */}
              <Table.Summary.Cell index={2} />
              {/* Ширина */}
              <Table.Summary.Cell index={3} />
              {/* Кол-во */}
              <Table.Summary.Cell index={4} align="right">
                <span style={{ color: '#1890ff' }}>{formatNumber(totals.quantity, 0)}</span>
              </Table.Summary.Cell>
              {/* Площадь */}
              <Table.Summary.Cell index={5} align="right">
                <span style={{ color: '#1890ff' }}>{formatNumber(totals.area, 2)} м²</span>
              </Table.Summary.Cell>
              {/* Фрезеровка */}
              <Table.Summary.Cell index={6} />
              {/* Обкат */}
              <Table.Summary.Cell index={7} />
              {/* Материал */}
              <Table.Summary.Cell index={8} />
              {/* Примечание */}
              <Table.Summary.Cell index={9} />
              {/* Цена за кв.м. */}
              <Table.Summary.Cell index={10} />
              {/* Сумма */}
              <Table.Summary.Cell index={11} align="right">
                <span style={{ color: '#52c41a', fontSize: '13px' }}>{formatNumber(totals.detail_cost, 2)}</span>
              </Table.Summary.Cell>
              {/* Пленка */}
              <Table.Summary.Cell index={12} />
              {/* Пр-т */}
              <Table.Summary.Cell index={13} />
              {/* Статус */}
              <Table.Summary.Cell index={14} />
              {/* detail_name */}
              <Table.Summary.Cell index={15} />
              {/* Действия */}
              <Table.Summary.Cell index={16} />
            </Table.Summary.Row>
          </Table.Summary>
        )}
        onRow={(record, index) => {
          const rowKey = record.temp_id || record.detail_id || 0;
          const isHighlighted = highlightedRowKey !== null && rowKey === highlightedRowKey;
          const isCurrentlyEditing = isEditing(record);
          const isPendingSelection = dragSelection.isInPendingSelection(rowKey);

          return {
            ref: isHighlighted ? highlightedRowRef : undefined,
            style: {
              backgroundColor: isCurrentlyEditing
                ? '#fffbe6' // Warm yellow for editing row
                : isPendingSelection
                ? '#e6f4ff' // Light blue for pending drag selection
                : isHighlighted
                ? '#e6f7ff' // Light blue for highlighted row
                : (index! % 2 === 0 ? '#ffffff' : '#f5f5f5'),
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

// Helper components for loading reference data
const MaterialCell: React.FC<{ materialId: number }> = ({ materialId }) => {
  const { data, isLoading } = useOne({
    resource: 'materials',
    id: materialId,
    queryOptions: { enabled: materialId !== null && materialId !== undefined },
  });

  if (materialId === null || materialId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;

  const materialName = data?.data?.material_name;
  const color = getMaterialColor(materialName || '');

  return materialName ? (
    <span style={{ color }}>{materialName}</span>
  ) : (
    <span style={{ color: '#ff4d4f' }}>Не найден (ID: {materialId})</span>
  );
};

const MillingTypeCell: React.FC<{ millingTypeId: number }> = ({ millingTypeId }) => {
  const { data, isLoading } = useOne({
    resource: 'milling_types',
    id: millingTypeId,
    queryOptions: { enabled: millingTypeId !== null && millingTypeId !== undefined },
  });

  if (millingTypeId === null || millingTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;

  const millingTypeName = data?.data?.milling_type_name;
  const bgColor = getMillingBgColor(millingTypeName || '');

  return millingTypeName ? (
    <span style={{ backgroundColor: bgColor, padding: '2px 6px', borderRadius: '3px', display: 'inline-block' }}>
      {millingTypeName}
    </span>
  ) : (
    <span style={{ color: '#ff4d4f' }}>Не найден (ID: {millingTypeId})</span>
  );
};

const EdgeTypeCell: React.FC<{ edgeTypeId: number }> = ({ edgeTypeId }) => {
  const { data, isLoading } = useOne({
    resource: 'edge_types',
    id: edgeTypeId,
    queryOptions: { enabled: edgeTypeId !== null && edgeTypeId !== undefined },
  });

  if (edgeTypeId === null || edgeTypeId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{data?.data?.edge_type_name || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {edgeTypeId})</span>}</span>;
};

const FilmCell: React.FC<{ filmId: number }> = ({ filmId }) => {
  const { data, isLoading } = useOne({
    resource: 'films',
    id: filmId,
    queryOptions: { enabled: filmId !== null && filmId !== undefined },
  });

  if (filmId === null || filmId === undefined) return <span style={{ color: '#999' }}>—</span>;
  if (isLoading) return <span style={{ color: '#999' }}>Загрузка...</span>;
  return <span>{data?.data?.film_name || <span style={{ color: '#ff4d4f' }}>Не найден (ID: {filmId})</span>}</span>;
};

const ProductionStatusCell: React.FC<{ statusId: number }> = ({ statusId }) => {
  const { data } = useOne({
    resource: 'production_statuses',
    id: statusId,
    queryOptions: { enabled: !!statusId },
  });
  return <Tag color="blue">{data?.data?.production_status_name || `ID: ${statusId}`}</Tag>;
};

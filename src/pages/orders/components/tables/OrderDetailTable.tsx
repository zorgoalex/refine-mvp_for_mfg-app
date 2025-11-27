// Order Details Table
// Displays list of order details with inline editing capabilities

import React, { useMemo, useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Table, Button, Tag, Space, Form, InputNumber, Input, Select, Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useOne } from '@refinedev/core';
import { useSelect } from '@refinedev/antd';
import { OrderDetail } from '../../../../types/orders';
import { formatNumber } from '../../../../utils/numberFormat';
import { getMaterialColor, getMillingBgColor } from '../../../../config/displayColors';
import {
  validateMaterialDimensions,
  MaterialInfo
} from '../../../../utils/materialDimensionValidation';

interface OrderDetailTableProps {
  onEdit: (detail: OrderDetail) => void;
  onDelete: (tempId: number, detailId?: number) => void;
  selectedRowKeys?: React.Key[];
  onSelectChange?: (selectedRowKeys: React.Key[]) => void;
  highlightedRowKey?: React.Key | null;
}

// Exposed methods via ref
export interface OrderDetailTableRef {
  startEditRow: (detail: OrderDetail) => void;
  saveCurrentAndStartNew: (newDetail: OrderDetail) => Promise<boolean>;
  isEditing: () => boolean;
}

export const OrderDetailTable = forwardRef<OrderDetailTableRef, OrderDetailTableProps>(({
  onEdit,
  onDelete,
  selectedRowKeys = [],
  onSelectChange,
  highlightedRowKey = null,
}, ref) => {
  const { details, updateDetail } = useOrderFormStore();
  const sortedDetails = useMemo(
    () => [...details].sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0)),
    [details]
  );

  const [form] = Form.useForm();
  const [editingKey, setEditingKey] = useState<number | string | null>(null);
  const [currentFilmId, setCurrentFilmId] = useState<number | null>(null);
  const [isSumEditable, setIsSumEditable] = useState(false);
  const [selectedMaterialId, setSelectedMaterialId] = useState<number | null>(null);
  const [dimensionValidationError, setDimensionValidationError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(20);
  const isEditing = (record: OrderDetail) => (record.temp_id || record.detail_id) === editingKey;
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
  const selectsEnabled = editingKey !== null;
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
  const validateDimensions = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');

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
  };

  // Trigger validation when material data loads
  useEffect(() => {
    if (materialData?.data) {
      validateDimensions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialData]);

  const startEdit = (record: OrderDetail) => {
    console.log('[OrderDetailTable] startEdit - detail:', record);
    setEditingKey(record.temp_id || record.detail_id || null);
    setCurrentFilmId(record.film_id ?? null);
    setSelectedMaterialId(record.material_id || null);
    setDimensionValidationError(null);
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
  }));

  const cancelEdit = () => {
    setEditingKey(null);
    setCurrentFilmId(null);
    setSelectedMaterialId(null);
    setDimensionValidationError(null);
    setIsSumEditable(false);
    form.resetFields();
  };

  const recalcArea = () => {
    const height = form.getFieldValue('height');
    const width = form.getFieldValue('width');
    console.log('[OrderDetailTable] recalcArea - height:', height, 'width:', width);

    if (height && width && height > 0 && width > 0) {
      const area = (height * width) / 1000000; // mm^2 -> m^2
      console.log('[OrderDetailTable] recalcArea - calculated area:', area);
      form.setFieldsValue({ area });
      recalcSum(); // Also recalculate sum when area changes
    } else {
      console.log('[OrderDetailTable] recalcArea - skipped (invalid height or width)');
    }

    // Validate dimensions against material limits
    validateDimensions();
  };

  // Handle material change
  const handleMaterialChange = (materialId: number) => {
    setSelectedMaterialId(materialId);
    // Validation will be triggered by useEffect when materialData loads
  };

  const recalcSum = () => {
    console.log('[OrderDetailTable] recalcSum - isSumEditable:', isSumEditable);

    // Only auto-calculate if sum is not in manual edit mode
    if (!isSumEditable) {
      const area = form.getFieldValue('area');
      const pricePerSqm = form.getFieldValue('milling_cost_per_sqm');
      console.log('[OrderDetailTable] recalcSum - area:', area, 'pricePerSqm:', pricePerSqm);

      if (area && pricePerSqm && area > 0 && pricePerSqm > 0) {
        const sum = area * pricePerSqm;
        const roundedSum = Number(sum.toFixed(2));
        console.log('[OrderDetailTable] recalcSum - calculated sum:', sum, 'rounded:', roundedSum);
        form.setFieldsValue({ detail_cost: roundedSum });
      } else {
        console.log('[OrderDetailTable] recalcSum - skipped (invalid area or price)');
      }
    } else {
      console.log('[OrderDetailTable] recalcSum - skipped (manual edit mode)');
    }
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

  const columns: ColumnsType<OrderDetail> = [
    {
      title: <div style={{ textAlign: 'center', fontSize: '70%' }}>№</div>,
      dataIndex: 'detail_number',
      key: 'detail_number',
      width: 40,
      fixed: 'left',
      defaultSortOrder: 'ascend',
      sorter: (a, b) => a.detail_number - b.detail_number,
      render: (value) => <span style={{ color: '#999' }}>{value}</span>,
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
            <InputNumber autoFocus style={{ width: '100%', minWidth: '80px' }} min={0} precision={2} onChange={recalcArea} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
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
            <InputNumber style={{ width: '100%', minWidth: '80px' }} min={0} precision={2} onChange={recalcArea} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
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
            <InputNumber style={{ width: '100%', minWidth: '70px' }} min={1} precision={0} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
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
              style={{ minWidth: 150, textAlign: 'left' }}
            />
          </Form.Item>
        ) : (
          <MillingTypeCell millingTypeId={millingTypeId} />
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Кромка</span></div>,
      dataIndex: 'edge_type_id',
      key: 'edge_type_id',
      width: 61,
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
              style={{ minWidth: 120, textAlign: 'left' }}
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
              style={{ minWidth: 180, textAlign: 'left' }}
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
          <span style={{ fontSize: '90%' }}>{text || '—'}</span>
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
              style={{ width: '100%', minWidth: '90px' }}
              precision={2}
              min={0}
              onChange={recalcSum}
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
            rules={[{ required: true, message: 'Рассчитайте сумму детали' }]}
          >
            <InputNumber
              style={{ width: '100%', minWidth: '90px' }}
              precision={2}
              min={0}
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
            <InputNumber style={{ width: '100%', minWidth: '60px' }} min={1} max={999} onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
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
            <Input placeholder="Название детали" onKeyDown={(e) => { if (e.key==='Enter'){e.preventDefault();} }} />
          </Form.Item>
        ) : (
          text || '—'
        ),
    },
    {
      title: <div style={{ textAlign: 'center' }}><span style={{ fontSize: '75%' }}>Действия</span></div>,
      key: 'actions',
      width: 50,
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
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined style={{ fontSize: '12px', color: '#ff4d4f' }} />}
                onClick={cancelEdit}
                style={{ padding: '0 4px' }}
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
      }
    : undefined;

  // Context menu items
  const getContextMenuItems = (record: OrderDetail): MenuProps['items'] => [
    {
      key: 'delete',
      label: 'Удалить',
      icon: <DeleteOutlined />,
      danger: true,
      onClick: () => onDelete(record.temp_id!, record.detail_id),
    },
  ];

  return (
    <Form form={form} component={false}>
      <Table<OrderDetail>
        dataSource={sortedDetails}
        columns={columns}
        rowKey={(record) => record.temp_id || record.detail_id || 0}
        rowSelection={rowSelection}
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
        rowClassName={(_, index) => (index % 2 === 0 ? '' : '')}
        onRow={(record, index) => {
          const rowKey = record.temp_id || record.detail_id || 0;
          const isHighlighted = highlightedRowKey !== null && rowKey === highlightedRowKey;
          const isCurrentlyEditing = isEditing(record);

          return {
            ref: isHighlighted ? highlightedRowRef : undefined,
            style: {
              backgroundColor: isCurrentlyEditing
                ? '#fffbe6' // Warm yellow for editing row
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
            onDoubleClick: () => startEdit(record),
            onContextMenu: (e) => {
              e.preventDefault();

              // Remove any existing context menus first
              const existingMenus = document.querySelectorAll('.order-detail-context-menu');
              existingMenus.forEach(menu => menu.remove());

              // Create context menu programmatically
              const menu = document.createElement('div');
              menu.className = 'ant-dropdown order-detail-context-menu';
              menu.style.position = 'fixed';
              menu.style.left = `${e.clientX}px`;
              menu.style.top = `${e.clientY}px`;
              menu.style.zIndex = '9999';

              const menuContent = `
                <ul class="ant-dropdown-menu" style="background: white; border: 1px solid #d9d9d9; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); padding: 4px 0;">
                  <li class="ant-dropdown-menu-item ant-dropdown-menu-item-danger" style="padding: 5px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                    <span role="img" aria-label="delete" style="color: #ff4d4f;">
                      <svg viewBox="64 64 896 896" width="1em" height="1em" fill="currentColor" aria-hidden="true">
                        <path d="M360 184h-8c4.4 0 8-3.6 8-8v8h304v-8c0 4.4 3.6 8 8 8h-8v72h72v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80h72v-72zm504 72H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zM731.3 840H292.7l-24.2-512h487l-24.2 512z"></path>
                      </svg>
                    </span>
                    <span style="color: #ff4d4f;">Удалить строку</span>
                  </li>
                </ul>
              `;
              menu.innerHTML = menuContent;
              document.body.appendChild(menu);

              const menuItem = menu.querySelector('.ant-dropdown-menu-item');
              menuItem?.addEventListener('click', () => {
                onDelete(record.temp_id!, record.detail_id);
                menu.remove();
              });

              menuItem?.addEventListener('mouseenter', () => {
                (menuItem as HTMLElement).style.backgroundColor = '#fff1f0';
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
            },
          };
        }}
      />
    </Form>
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

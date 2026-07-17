// Order Payments Table
// Displays list of order payments with inline editing capabilities
// Pattern: same as OrderDetailTable for consistency

import React, { useMemo, useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Table, Button, Space, Form, InputNumber, Input, Select, DatePicker, Typography, Tooltip, Dropdown } from 'antd';
import { EditOutlined, CheckOutlined, DeleteOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useSelect } from '@refinedev/antd';
import { Payment } from '../../../../types/orders';
import { formatNumber, numberParser, currencySmartFormatter } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { createBackendSelectProps, useOrderFormData } from '../../../../hooks/useOrderFormData';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderPaymentTableProps {
  onEdit: (payment: Payment) => void;
  onDelete: (tempId: number, paymentId?: number) => void;
  onQuickAdd?: () => void;
  selectedRowKeys?: React.Key[];
  onSelectChange?: (selectedRowKeys: React.Key[]) => void;
  highlightedRowKey?: React.Key | null;
}

// Exposed methods via ref
export interface OrderPaymentTableRef {
  startEditRow: (payment: Payment) => void;
  saveCurrentAndStartNew: (newPayment: Payment) => Promise<boolean>;
  isEditing: () => boolean;
  applyCurrentEdits: () => Promise<boolean>;
}

export const OrderPaymentTable = forwardRef<OrderPaymentTableRef, OrderPaymentTableProps>(({
  onEdit,
  onDelete,
  onQuickAdd,
  selectedRowKeys = [],
  onSelectChange,
  highlightedRowKey = null,
}, ref) => {
  const { payments, updatePayment, deletePayment, setPaymentEditing } = useOrderFormStore();
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  // Sort payments by date (newest first)
  const sortedPayments = useMemo(
    () => [...payments].sort((a, b) => {
      const dateA = a.payment_date ? new Date(a.payment_date).getTime() : 0;
      const dateB = b.payment_date ? new Date(b.payment_date).getTime() : 0;
      return dateB - dateA;
    }),
    [payments]
  );

  const [form] = Form.useForm();
  const [editingKey, setEditingKey] = useState<number | string | null>(null);
  const [paymentContextMenu, setPaymentContextMenu] = useState<{
    x: number;
    y: number;
    record: Payment;
  } | null>(null);
  const highlightedRowRef = useRef<HTMLElement | null>(null);

  const isEditing = (record: Payment) => (record.temp_id || record.payment_id) === editingKey;

  const closePaymentContextMenu = useCallback(() => {
    setPaymentContextMenu(null);
  }, []);

  // Calculate total payments amount
  const totalPaymentsAmount = useMemo(() => {
    return payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  }, [payments]);

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
  const { selectProps: paymentTypeSelectProps } = useSelect({
    resource: 'payment_types',
    optionLabel: 'type_paid_name',
    optionValue: 'type_paid_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'type_paid_id', order: 'asc' }],
    pagination: { mode: 'off' },
    queryOptions: { enabled: selectsEnabled && !useBackendReferences },
  });
  const resolvedPaymentTypeSelectProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.paymentTypes, orderFormData.isLoading)
    : paymentTypeSelectProps;

  // Watch required fields for visual indication
  const watchedTypePaidId = Form.useWatch('type_paid_id', form);
  const watchedAmount = Form.useWatch('amount', form);
  const watchedPaymentDate = Form.useWatch('payment_date', form);

  // Style for empty required fields - red bottom border
  const getRequiredFieldStyle = (value: any): React.CSSProperties => {
    const isEmpty = value === null || value === undefined || value === '';
    return isEmpty && editingKey !== null
      ? { borderBottomColor: '#ff4d4f', borderBottomWidth: '2px' }
      : {};
  };

  const startEdit = (record: Payment) => {
    setEditingKey(record.temp_id || record.payment_id || null);
    if (setPaymentEditing) {
      setPaymentEditing(true);
    }

    form.setFieldsValue({
      type_paid_id: record.type_paid_id,
      payment_date: record.payment_date ? dayjs(record.payment_date) : dayjs(),
      amount: record.amount,
      notes: record.notes ?? '',
    });
  };

  // Save current editing row and return success status
  const saveCurrentRow = async (): Promise<boolean> => {
    if (editingKey === null) return true; // Nothing to save

    // Find the record being edited
    const record = payments.find(p => (p.temp_id || p.payment_id) === editingKey);
    if (!record) return true;

    // Check if this is an "empty" payment (amount is empty or zero)
    // Must check BEFORE validation to avoid validation errors on empty rows
    const currentValues = form.getFieldsValue();
    const isEmptyPayment = (
      !record.payment_id && // Only for new payments
      (!currentValues.amount || currentValues.amount === 0)
    );

    if (isEmptyPayment) {
      // Remove empty payment from store
      const tempId = record.temp_id || record.payment_id;
      if (tempId) {
        deletePayment(tempId, record.payment_id);
      }
      cancelEdit();
      return true;
    }

    try {
      const values = await form.validateFields();
      const tempId = record.temp_id || record.payment_id!;

      // Format payment_date to ISO string
      const formattedValues = {
        ...values,
        payment_date: values.payment_date
          ? dayjs(values.payment_date).format('YYYY-MM-DD')
          : dayjs().format('YYYY-MM-DD'),
      };

      updatePayment(tempId, formattedValues);
      cancelEdit();
      return true;
    } catch (error) {
      console.log('[OrderPaymentTable] saveCurrentRow - validation failed:', error);
      return false;
    }
  };

  // Handle Tab on last field - save and optionally add new row
  const handleTabOnLastField = async (e: React.KeyboardEvent, record: Payment) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();

      // Save current row
      const saved = await saveCurrentRow();
      if (saved) {
        // Check if current row is the last one in the list
        const recordKey = record.temp_id || record.payment_id;
        const lastPayment = sortedPayments[sortedPayments.length - 1];
        const lastKey = lastPayment?.temp_id || lastPayment?.payment_id;
        const isLastRow = recordKey === lastKey;

        // Only add new row if current row is the last one
        if (isLastRow && onQuickAdd) {
          onQuickAdd();
        }
      }
    }
  };

  // Expose methods via ref for external calls
  useImperativeHandle(ref, () => ({
    startEditRow: startEdit,
    isEditing: () => editingKey !== null,
    saveCurrentAndStartNew: async (newPayment: Payment) => {
      const saved = await saveCurrentRow();
      if (saved) {
        setTimeout(() => {
          startEdit(newPayment);
        }, 50);
      }
      return saved;
    },
    applyCurrentEdits: async () => {
      if (editingKey === null) return true;
      return await saveCurrentRow();
    },
  }));

  const cancelEdit = () => {
    setEditingKey(null);
    if (setPaymentEditing) {
      setPaymentEditing(false);
    }
    form.resetFields();
  };

  const saveEdit = async (record: Payment) => {
    const values = await form.validateFields();

    // Format payment_date to ISO string
    const formattedValues = {
      ...values,
      payment_date: values.payment_date
        ? dayjs(values.payment_date).format('YYYY-MM-DD')
        : dayjs().format('YYYY-MM-DD'),
    };

    const tempId = record.temp_id || record.payment_id!;
    updatePayment(tempId, formattedValues);
    cancelEdit();
  };

  const columns: ColumnsType<Payment> = [
    {
      title: <div style={{ textAlign: 'center', fontSize: '85%' }}>Тип оплаты</div>,
      dataIndex: 'type_paid_id',
      key: 'type_paid_id',
      width: 200,
      render: (value, record) => {
        if (!isEditing(record)) {
          return (
            <PaymentTypeCell
              typePaidId={value}
              useBackendReferences={useBackendReferences}
              namesById={orderFormData.references.paymentTypeNameById}
            />
          );
        }
        return (
          <Form.Item
            name="type_paid_id"
            style={{ margin: 0, padding: '0 4px' }}
            rules={[{ required: true, message: 'Выберите тип' }]}
          >
            <Select
              {...resolvedPaymentTypeSelectProps}
              autoFocus
              placeholder="Тип оплаты"
              showSearch
              filterOption={(input, option) =>
                ((option?.label as string) || '').toLowerCase().includes((input as string).toLowerCase())
              }
              dropdownMatchSelectWidth={false}
              style={{ minWidth: 180, textAlign: 'left', ...getRequiredFieldStyle(watchedTypePaidId) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '85%' }}>Дата</div>,
      dataIndex: 'payment_date',
      key: 'payment_date',
      width: 140,
      render: (value, record) => {
        if (!isEditing(record)) {
          return formatDate(value);
        }
        return (
          <Form.Item
            name="payment_date"
            style={{ margin: 0, padding: '0 4px' }}
            rules={[{ required: true, message: 'Укажите дату' }]}
          >
            <DatePicker
              style={{ width: '100%', ...getRequiredFieldStyle(watchedPaymentDate) }}
              format="DD.MM.YYYY"
              placeholder="Дата"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '85%' }}>Сумма</div>,
      dataIndex: 'amount',
      key: 'amount',
      width: 150,
      align: 'right' as const,
      render: (value, record) => {
        if (!isEditing(record)) {
          return `${formatNumber(value || 0, 2)} ${CURRENCY_SYMBOL}`;
        }
        return (
          <Form.Item
            name="amount"
            style={{ margin: 0, padding: '0 4px' }}
            rules={[
              { required: true, message: 'Укажите сумму' },
              { type: 'number', min: 0.01, message: 'Сумма > 0' },
            ]}
          >
            <InputNumber
              controls={false}
              style={{ width: '100%', minWidth: '120px', ...getRequiredFieldStyle(watchedAmount) }}
              min={0}
              precision={2}
              formatter={currencySmartFormatter}
              parser={numberParser}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); } }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '85%' }}>Примечание</div>,
      dataIndex: 'notes',
      key: 'notes',
      ellipsis: true,
      render: (value, record) => {
        if (!isEditing(record)) {
          return value || '—';
        }
        return (
          <Form.Item name="notes" style={{ margin: 0, padding: '0 4px' }}>
            <Input
              placeholder="Примечание"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
                if (e.key === 'Tab' && !e.shiftKey) {
                  handleTabOnLastField(e, record);
                }
              }}
            />
          </Form.Item>
        );
      },
    },
    {
      title: <div style={{ textAlign: 'center', fontSize: '85%' }}>Действия</div>,
      key: 'actions',
      width: 50,
      align: 'center' as const,
      render: (_, record) => {
        return (
          <Space size={2}>
            {isEditing(record) ? (
              <Tooltip title="Сохранить">
                <Button
                  type="text"
                  size="small"
                  icon={<CheckOutlined style={{ fontSize: '14px', color: '#52c41a' }} />}
                  onClick={() => saveEdit(record)}
                  style={{ padding: '0 4px' }}
                />
              </Tooltip>
            ) : (
              <Tooltip title="Редактировать">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined style={{ fontSize: '12px' }} />}
                  onClick={() => startEdit(record)}
                  style={{ padding: '0 4px' }}
                />
              </Tooltip>
            )}
          </Space>
        );
      },
    },
  ];

  const paymentContextMenuItems: MenuProps['items'] = useMemo(
    () => [
      {
        key: 'edit',
        icon: <EditOutlined style={{ color: '#1890ff' }} />,
        label: <span style={{ color: '#1890ff' }}>Редактировать</span>,
      },
      { type: 'divider' as const },
      {
        key: 'delete',
        icon: <DeleteOutlined />,
        label: 'Удалить',
        danger: true,
      },
    ],
    [],
  );

  const handlePaymentContextMenuClick: MenuProps['onClick'] = useCallback(
    (info) => {
      if (!paymentContextMenu?.record) return;

      if (info.key === 'edit') {
        startEdit(paymentContextMenu.record);
        closePaymentContextMenu();
        return;
      }

      if (info.key === 'delete') {
        const tempId = paymentContextMenu.record.temp_id || paymentContextMenu.record.payment_id;
        if (tempId) {
          onDelete(tempId, paymentContextMenu.record.payment_id);
        }
        closePaymentContextMenu();
      }
    },
    [closePaymentContextMenu, onDelete, paymentContextMenu?.record],
  );

  const rowSelection = onSelectChange
    ? {
        selectedRowKeys,
        onChange: onSelectChange,
        columnWidth: 24,
      }
    : undefined;

  return (
    <>
      <Form form={form} component={false}>
        <Table<Payment>
          dataSource={sortedPayments}
          columns={columns}
          rowKey={(record) => record.temp_id || record.payment_id || 0}
          rowSelection={rowSelection}
          showSorterTooltip={false}
          pagination={false}
          scroll={{ y: 300 }}
          size="small"
          bordered
          onRow={(record, index) => {
            const rowKey = record.temp_id || record.payment_id || 0;
            const isHighlighted = highlightedRowKey !== null && rowKey === highlightedRowKey;
            const isCurrentlyEditing = isEditing(record);

            return {
              ref: isHighlighted ? highlightedRowRef : undefined,
              style: {
                backgroundColor: isCurrentlyEditing
                  ? 'var(--app-highlight)' // Warm yellow for editing row
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
              onDoubleClick: () => startEdit(record),
              onContextMenu: (e) => {
                e.preventDefault();
                e.stopPropagation();
                setPaymentContextMenu({ x: e.clientX, y: e.clientY, record });
              },
            };
          }}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}>
                <Text strong>Итого:</Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                <Text strong>
                  {formatNumber(totalPaymentsAmount, 2)} {CURRENCY_SYMBOL}
                </Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} colSpan={2} />
            </Table.Summary.Row>
          )}
        />
      </Form>

      <Dropdown
        open={!!paymentContextMenu}
        placement="bottomLeft"
        destroyPopupOnHide={false}
        menu={{ items: paymentContextMenuItems, onClick: handlePaymentContextMenuClick }}
        getPopupContainer={() => document.body}
        overlayClassName="order-payment-context-dropdown"
        trigger={['click', 'contextMenu']}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closePaymentContextMenu();
          }
        }}
      >
        <span
          style={{
            position: 'fixed',
            left: paymentContextMenu?.x ?? -9999,
            top: paymentContextMenu?.y ?? -9999,
            width: 1,
            height: 1,
          }}
        />
      </Dropdown>
    </>
  );
});

// Helper function to format date
const formatDate = (date: string | Date | null | undefined) => {
  if (!date) return '—';
  return dayjs(date).format('DD.MM.YYYY');
};

// Helper component for loading payment type name
const PaymentTypeCell: React.FC<{
  typePaidId: number;
  useBackendReferences: boolean;
  namesById: Map<number, string>;
}> = ({
  typePaidId,
  useBackendReferences,
  namesById,
}) => {
  const { selectProps } = useSelect({
    resource: 'payment_types',
    optionLabel: 'type_paid_name',
    optionValue: 'type_paid_id',
    defaultValue: typePaidId,
    queryOptions: {
      enabled: !useBackendReferences && typePaidId !== null && typePaidId !== undefined,
    },
  });

  if (typePaidId === null || typePaidId === undefined) return <span style={{ color: '#999' }}>—</span>;

  if (useBackendReferences) {
    return <span>{namesById.get(Number(typePaidId)) || `ID: ${typePaidId}`}</span>;
  }

  const option = selectProps.options?.find((opt: any) => opt.value === typePaidId);
  return <span>{option?.label || `ID: ${typePaidId}`}</span>;
};

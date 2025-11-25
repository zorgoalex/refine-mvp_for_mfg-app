// Order Payments Tab
// Container for managing order payments with CRUD operations

import React, { useState, useMemo } from 'react';
import { Card, Button, Space, Modal, message, Table, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { Payment } from '../../../../types/orders';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { PaymentModal } from '../modals/PaymentModal';
import dayjs from 'dayjs';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';

const { Text } = Typography;

export const OrderPaymentsTab: React.FC = () => {
  const { payments, addPayment, updatePayment, deletePayment, header } = useOrderFormStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingPayment, setEditingPayment] = useState<Payment | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [highlightedRowKey, setHighlightedRowKey] = useState<React.Key | null>(null);

  // Load payment types for display
  const { data: paymentTypesData } = useList({
    resource: 'payment_types',
    pagination: { pageSize: 1000 },
  });

  const paymentTypesMap = useMemo(() => {
    const map: Record<string | number, string> = {};
    (paymentTypesData?.data || []).forEach((pt: any) => {
      map[pt.type_paid_id] = pt.type_paid_name;
    });
    return map;
  }, [paymentTypesData]);

  // Calculate total payments amount
  const totalPaymentsAmount = useMemo(() => {
    return payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  }, [payments]);

  // Handle create new payment
  const handleCreate = () => {
    setModalMode('create');
    setEditingPayment(undefined);
    setModalOpen(true);
  };

  // Handle edit existing payment
  const handleEdit = (payment: Payment) => {
    setModalMode('edit');
    setEditingPayment(payment);
    setModalOpen(true);
  };

  // Handle save (create or update)
  const handleSave = (paymentData: Omit<Payment, 'temp_id'>) => {
    let rowKey: React.Key;

    // Check if we're editing by looking at editingPayment (more reliable than modalMode)
    if (editingPayment && (editingPayment.payment_id || editingPayment.temp_id)) {
      // Update existing payment
      const tempId = editingPayment.temp_id || editingPayment.payment_id!;
      updatePayment(tempId, paymentData);
      rowKey = tempId;
      message.success('Платеж обновлен');
    } else {
      // Create new payment
      addPayment(paymentData);
      const lastPayment = [...payments].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      rowKey = lastPayment?.temp_id || Date.now();
      message.success('Платеж добавлен');
    }

    setModalOpen(false);
    setEditingPayment(undefined);

    // Highlight the row and auto-clear after 2 seconds
    setTimeout(() => {
      const updatedPayments = useOrderFormStore.getState().payments;
      const lastPayment = [...updatedPayments].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      const actualRowKey = lastPayment?.temp_id || lastPayment?.payment_id || rowKey;

      setHighlightedRowKey(actualRowKey);
      setTimeout(() => {
        setHighlightedRowKey(null);
      }, 2000);
    }, 100);
  };

  // Handle delete single payment
  const handleDelete = (tempId: number, paymentId?: number) => {
    Modal.confirm({
      title: 'Удалить платеж?',
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk() {
        deletePayment(tempId, paymentId);
        message.success('Платеж удален');
      },
    });
  };

  // Handle delete multiple payments
  const handleDeleteSelected = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('Выберите платежи для удаления');
      return;
    }

    Modal.confirm({
      title: `Удалить выбранные платежи (${selectedRowKeys.length})?`,
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk() {
        selectedRowKeys.forEach((key) => {
          const payment = payments.find(
            (p) => (p.temp_id || p.payment_id) === key
          );
          if (payment) {
            const tempId = payment.temp_id || payment.payment_id!;
            deletePayment(tempId, payment.payment_id);
          }
        });
        setSelectedRowKeys([]);
        message.success(`Удалено платежей: ${selectedRowKeys.length}`);
      },
    });
  };

  const formatDate = (date: string | Date | null | undefined) => {
    if (!date) return '—';
    return dayjs(date).format('DD.MM.YYYY');
  };

  const columns = [
    {
      title: 'Тип оплаты',
      dataIndex: 'type_paid_id',
      key: 'type_paid_id',
      width: 200,
      render: (value: number) => paymentTypesMap[value] || '—',
    },
    {
      title: 'Дата',
      dataIndex: 'payment_date',
      key: 'payment_date',
      width: 120,
      render: (value: string | Date) => formatDate(value),
    },
    {
      title: 'Сумма',
      dataIndex: 'amount',
      key: 'amount',
      width: 150,
      align: 'right' as const,
      render: (value: number) => `${formatNumber(value || 0, 2)} ${CURRENCY_SYMBOL}`,
    },
    {
      title: 'Примечание',
      dataIndex: 'notes',
      key: 'notes',
      ellipsis: true,
      render: (value: string | null) => value || '—',
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 100,
      align: 'center' as const,
      render: (_: any, record: Payment) => {
        const tempId = record.temp_id || record.payment_id!;
        return (
          <Space size="small">
            <Button
              type="link"
              icon={<EditOutlined />}
              size="small"
              onClick={() => handleEdit(record)}
            />
            <Button
              type="link"
              danger
              icon={<DeleteOutlined />}
              size="small"
              onClick={() => handleDelete(tempId, record.payment_id)}
            />
          </Space>
        );
      },
    },
  ];

  // Check if amounts match
  const paidAmount = header?.paid_amount || 0;
  const isAmountMismatch = Math.abs(totalPaymentsAmount - paidAmount) > 0.01;

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>Платежи по заказу</span>
          {isAmountMismatch && (
            <Text type="danger" style={{ fontSize: 12 }}>
              ⚠ Расхождение сумм
            </Text>
          )}
        </Space>
      }
      extra={
        <Space>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            size="small"
            onClick={handleCreate}
          >
            Создать оплату
          </Button>
          {selectedRowKeys.length > 0 && (
            <Button
              danger
              icon={<DeleteOutlined />}
              size="small"
              onClick={handleDeleteSelected}
            >
              Удалить ({selectedRowKeys.length})
            </Button>
          )}
        </Space>
      }
    >
      <Table
        dataSource={payments}
        columns={columns}
        rowKey={(record) => record.temp_id || record.payment_id!}
        size="small"
        pagination={false}
        bordered
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        rowClassName={(record) => {
          const rowKey = record.temp_id || record.payment_id!;
          return highlightedRowKey === rowKey ? 'highlighted-row' : '';
        }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={2}>
              <Text strong>Итого:</Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} align="right">
              <Text strong style={{ color: isAmountMismatch ? '#ff4d4f' : undefined }}>
                {formatNumber(totalPaymentsAmount, 2)} {CURRENCY_SYMBOL}
              </Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3} colSpan={2}>
              {isAmountMismatch && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Оплачено в заказе: {formatNumber(paidAmount, 2)} {CURRENCY_SYMBOL}
                </Text>
              )}
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />

      {/* Payment Modal */}
      {modalOpen && (
        <PaymentModal
          mode={modalMode}
          payment={editingPayment}
          open={modalOpen}
          onSave={handleSave}
          onCancel={() => {
            setModalOpen(false);
            setEditingPayment(undefined);
          }}
        />
      )}
    </Card>
  );
};

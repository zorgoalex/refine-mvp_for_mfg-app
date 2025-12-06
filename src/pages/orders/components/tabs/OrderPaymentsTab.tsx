// Order Payments Tab
// Container for managing order payments with inline editing (like OrderDetailsTab)

import React, { useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { Card, Button, Space, Modal, message } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { OrderPaymentTable, OrderPaymentTableRef } from '../tables/OrderPaymentTable';
import { PaymentModal } from '../modals/PaymentModal';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { Payment } from '../../../../types/orders';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import dayjs from 'dayjs';

// Exposed methods via ref
export interface OrderPaymentsTabRef {
  applyCurrentEdits: () => Promise<boolean>;
}

// Default values for quick add
const QUICK_ADD_DEFAULTS = {
  type_paid_id: 1,  // Первый тип оплаты (обычно "Наличные" или аналог)
  amount: 0,
  payment_date: dayjs().format('YYYY-MM-DD'),
};

export const OrderPaymentsTab = forwardRef<OrderPaymentsTabRef>((_, ref) => {
  const { payments, addPayment, deletePayment } = useOrderFormStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingPayment, setEditingPayment] = useState<Payment | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [highlightedRowKey, setHighlightedRowKey] = useState<React.Key | null>(null);
  const tableRef = useRef<OrderPaymentTableRef>(null);

  // Expose methods via ref for parent (OrderForm) to call
  useImperativeHandle(ref, () => ({
    applyCurrentEdits: async () => {
      if (tableRef.current) {
        return await tableRef.current.applyCurrentEdits();
      }
      return true;
    },
  }));

  // Handle create new payment via modal
  const handleCreate = () => {
    setModalMode('create');
    setEditingPayment(undefined);
    setModalOpen(true);
  };

  // Handle quick inline add
  const handleQuickAdd = async () => {
    // Add new payment with defaults
    addPayment(QUICK_ADD_DEFAULTS as Omit<Payment, 'temp_id'>);

    // Get the newly added payment
    await new Promise(resolve => setTimeout(resolve, 50));
    const updatedPayments = useOrderFormStore.getState().payments;
    const lastPayment = [...updatedPayments].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];

    if (!lastPayment || !tableRef.current) return;

    // If currently editing another row, save it first then start new
    if (tableRef.current.isEditing()) {
      const saved = await tableRef.current.saveCurrentAndStartNew(lastPayment);
      if (!saved) {
        // Validation failed - remove the just-added payment
        const tempId = lastPayment.temp_id || lastPayment.payment_id;
        if (tempId) {
          deletePayment(tempId, lastPayment.payment_id);
        }
        message.warning('Сначала заполните обязательные поля текущего платежа');
      }
    } else {
      // No row being edited, just start editing the new one
      tableRef.current.startEditRow(lastPayment);
    }
  };

  // Handle edit existing payment (via modal - legacy support)
  const handleEdit = (payment: Payment) => {
    setModalMode('edit');
    setEditingPayment(payment);
    setModalOpen(true);
  };

  // Handle save (create or update from modal)
  const handleSave = (paymentData: Omit<Payment, 'temp_id'>) => {
    let rowKey: React.Key;

    if (modalMode === 'create') {
      addPayment(paymentData);
      const lastPayment = [...payments].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      rowKey = lastPayment?.temp_id || Date.now();
      message.success('Платеж добавлен');
    } else if (editingPayment) {
      const tempId = editingPayment.temp_id || editingPayment.payment_id!;
      const { updatePayment } = useOrderFormStore.getState();
      updatePayment(tempId, paymentData);
      rowKey = tempId;
      message.success('Платеж обновлен');
    } else {
      setModalOpen(false);
      setEditingPayment(undefined);
      return;
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
        message.success(`Удалено платежей: ${selectedRowKeys.length}`);
        setSelectedRowKeys([]);
      },
    });
  };

  // Handle row selection change
  const handleSelectChange = (newSelectedRowKeys: React.Key[]) => {
    setSelectedRowKeys(newSelectedRowKeys);
  };

  return (
    <Card size="small">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Toolbar */}
        <Space>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleQuickAdd}>
            Быстрое добавление
          </Button>
          <Button icon={<PlusOutlined />} onClick={handleCreate}>
            Добавить (форма)
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={handleDeleteSelected}
            disabled={selectedRowKeys.length === 0}
          >
            Удалить выбранные ({selectedRowKeys.length})
          </Button>
          <span style={{ marginLeft: 16, color: '#666' }}>
            Всего платежей: {payments.length}
          </span>
        </Space>

        {/* Table with inline editing */}
        <OrderPaymentTable
          ref={tableRef}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onQuickAdd={handleQuickAdd}
          selectedRowKeys={selectedRowKeys}
          onSelectChange={handleSelectChange}
          highlightedRowKey={highlightedRowKey}
        />

        {/* Modal (for legacy "Add via form" button) */}
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
      </Space>
    </Card>
  );
});

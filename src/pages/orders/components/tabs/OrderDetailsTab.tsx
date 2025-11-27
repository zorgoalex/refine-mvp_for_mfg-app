// Order Details Tab
// Container for managing order details with toolbar and CRUD operations

import React, { useState, useRef } from 'react';
import { Card, Button, Space, Modal, message } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { OrderDetailTable, OrderDetailTableRef } from '../tables/OrderDetailTable';
import { OrderDetailModal } from '../modals/OrderDetailModal';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { OrderDetail } from '../../../../types/orders';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

// Default values for quick add
const QUICK_ADD_DEFAULTS = {
  material_id: 1,      // МДФ 16мм
  milling_type_id: 1,  // Модерн
  edge_type_id: 1,     // р-1
  quantity: 1,
  priority: 100,
};

export const OrderDetailsTab: React.FC = () => {
  const { details, addDetail, updateDetail, deleteDetail, reorderDetails } = useOrderFormStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingDetail, setEditingDetail] = useState<OrderDetail | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [highlightedRowKey, setHighlightedRowKey] = useState<React.Key | null>(null);
  const tableRef = useRef<OrderDetailTableRef>(null);

  // Handle create new detail via modal
  const handleCreate = () => {
    setModalMode('create');
    setEditingDetail(undefined);
    setModalOpen(true);
  };

  // Handle quick inline add
  const handleQuickAdd = async () => {
    // Add new detail with defaults
    addDetail(QUICK_ADD_DEFAULTS as Omit<OrderDetail, 'temp_id'>);

    // Get the newly added detail
    await new Promise(resolve => setTimeout(resolve, 50));
    const updatedDetails = useOrderFormStore.getState().details;
    const lastDetail = [...updatedDetails].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];

    if (!lastDetail || !tableRef.current) return;

    // If currently editing another row, save it first then start new
    if (tableRef.current.isEditing()) {
      const saved = await tableRef.current.saveCurrentAndStartNew(lastDetail);
      if (!saved) {
        // Validation failed - remove the just-added detail
        const tempId = lastDetail.temp_id || lastDetail.detail_id;
        if (tempId) {
          deleteDetail(tempId, lastDetail.detail_id);
        }
        message.warning('Сначала заполните обязательные поля текущей позиции');
      }
    } else {
      // No row being edited, just start editing the new one
      tableRef.current.startEditRow(lastDetail);
    }
  };

  // Handle edit existing detail
  const handleEdit = (detail: OrderDetail) => {
    setModalMode('edit');
    setEditingDetail(detail);
    setModalOpen(true);
  };

  // Handle save (create or update)
  const handleSave = (detailData: Omit<OrderDetail, 'temp_id'>) => {
    let rowKey: React.Key;

    if (modalMode === 'create') {
      // addDetail will assign temp_id internally
      addDetail(detailData);
      // Get the last added detail's temp_id (it will be the last one in the array)
      const lastDetail = [...details].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      rowKey = lastDetail?.temp_id || Date.now();
      message.success('Деталь добавлена');
    } else if (editingDetail) {
      const tempId = editingDetail.temp_id || editingDetail.detail_id!;
      updateDetail(tempId, detailData);
      rowKey = tempId;
      message.success('Деталь обновлена');
    } else {
      setModalOpen(false);
      setEditingDetail(undefined);
      return;
    }

    setModalOpen(false);
    setEditingDetail(undefined);

    // Highlight the row and auto-clear after 2 seconds
    // Use setTimeout to ensure the detail is added to the list first
    setTimeout(() => {
      // Re-get the last detail after state update
      const updatedDetails = useOrderFormStore.getState().details;
      const lastDetail = [...updatedDetails].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      const actualRowKey = lastDetail?.temp_id || lastDetail?.detail_id || rowKey;

      setHighlightedRowKey(actualRowKey);
      setTimeout(() => {
        setHighlightedRowKey(null);
      }, 2000);
    }, 100);
  };

  // Handle delete single detail
  const handleDelete = (tempId: number, detailId?: number) => {
    Modal.confirm({
      title: 'Удалить деталь?',
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk() {
        deleteDetail(tempId, detailId);
        message.success('Деталь удалена');
      },
    });
  };

  // Handle delete multiple details
  const handleDeleteSelected = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('Выберите детали для удаления');
      return;
    }

    Modal.confirm({
      title: `Удалить выбранные детали (${selectedRowKeys.length})?`,
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk() {
        selectedRowKeys.forEach((key) => {
          const detail = details.find(
            (d) => (d.temp_id || d.detail_id) === key
          );
          if (detail) {
            const tempId = detail.temp_id || detail.detail_id!;
            deleteDetail(tempId, detail.detail_id);
          }
        });
        message.success(`Удалено деталей: ${selectedRowKeys.length}`);
        setSelectedRowKeys([]);
        reorderDetails(); // Renumber after deletion
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
            Всего позиций: {details.length}
          </span>
        </Space>

        {/* Table */}
        <OrderDetailTable
          ref={tableRef}
          onEdit={handleEdit}
          onDelete={handleDelete}
          selectedRowKeys={selectedRowKeys}
          onSelectChange={handleSelectChange}
          highlightedRowKey={highlightedRowKey}
        />

        {/* Modal */}
        <OrderDetailModal
          open={modalOpen}
          mode={modalMode}
          detail={editingDetail}
          onSave={handleSave}
          onCancel={() => {
            setModalOpen(false);
            setEditingDetail(undefined);
          }}
        />
      </Space>
    </Card>
  );
};

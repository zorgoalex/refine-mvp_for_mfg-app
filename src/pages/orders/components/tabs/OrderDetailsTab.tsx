// Order Details Tab
// Container for managing order details with toolbar and CRUD operations

import React, { useState } from 'react';
import { Card, Button, Space, Modal, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { OrderDetailTable } from '../tables/OrderDetailTable';
import { OrderDetailModal } from '../modals/OrderDetailModal';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { OrderDetail } from '../../../../types/orders';

const { confirm } = Modal;

export const OrderDetailsTab: React.FC = () => {
  const { details, addDetail, updateDetail, deleteDetail, reorderDetails } = useOrderFormStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingDetail, setEditingDetail] = useState<OrderDetail | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  // Handle create new detail
  const handleCreate = () => {
    setModalMode('create');
    setEditingDetail(undefined);
    setModalOpen(true);
  };

  // Handle edit existing detail
  const handleEdit = (detail: OrderDetail) => {
    setModalMode('edit');
    setEditingDetail(detail);
    setModalOpen(true);
  };

  // Handle save (create or update)
  const handleSave = (detailData: Omit<OrderDetail, 'temp_id'>) => {
    if (modalMode === 'create') {
      addDetail(detailData);
      message.success('Деталь добавлена');
    } else if (editingDetail) {
      const tempId = editingDetail.temp_id || editingDetail.detail_id!;
      updateDetail(tempId, detailData);
      message.success('Деталь обновлена');
    }
    setModalOpen(false);
    setEditingDetail(undefined);
  };

  // Handle delete single detail
  const handleDelete = (tempId: number, detailId?: number) => {
    confirm({
      title: 'Удалить деталь?',
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
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

    confirm({
      title: `Удалить выбранные детали (${selectedRowKeys.length})?`,
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
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
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            Добавить деталь
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
            Всего деталей: {details.length}
          </span>
        </Space>

        {/* Table */}
        <OrderDetailTable
          onEdit={handleEdit}
          onDelete={handleDelete}
          selectedRowKeys={selectedRowKeys}
          onSelectChange={handleSelectChange}
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

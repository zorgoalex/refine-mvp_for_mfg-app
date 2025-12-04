// Order Details Tab
// Container for managing order details with toolbar and CRUD operations

import React, { useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { Card, Button, Space, Modal, message } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined, CalculatorOutlined } from '@ant-design/icons';
import { OrderDetailTable, OrderDetailTableRef } from '../tables/OrderDetailTable';
import { OrderDetailModal } from '../modals/OrderDetailModal';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { OrderDetail } from '../../../../types/orders';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';

// Exposed methods via ref
export interface OrderDetailsTabRef {
  applyCurrentEdits: () => Promise<boolean>;
}

// Default values for quick add
const QUICK_ADD_DEFAULTS = {
  material_id: 1,      // МДФ 16мм
  milling_type_id: 1,  // Модерн
  edge_type_id: 1,     // р-1
  priority: 100,
};

export const OrderDetailsTab = forwardRef<OrderDetailsTabRef>((_, ref) => {
  const { details, addDetail, insertDetailAfter, updateDetail, deleteDetail, reorderDetails, header, updateHeaderField } = useOrderFormStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingDetail, setEditingDetail] = useState<OrderDetail | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [highlightedRowKey, setHighlightedRowKey] = useState<React.Key | null>(null);
  const tableRef = useRef<OrderDetailTableRef>(null);

  // Expose methods via ref for parent (OrderForm) to call
  useImperativeHandle(ref, () => ({
    applyCurrentEdits: async () => {
      if (tableRef.current) {
        return await tableRef.current.applyCurrentEdits();
      }
      return true;
    },
  }));

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

  // Handle copy row - duplicate the row and insert after original
  const handleCopyRow = (detail: OrderDetail) => {
    // Create copy without identifiers
    const { temp_id, detail_id, detail_number, ...detailData } = detail;

    // Insert copy after the original
    const afterTempId = temp_id || detail_id;
    if (afterTempId) {
      insertDetailAfter(afterTempId, detailData as Omit<OrderDetail, 'temp_id'>);
      message.success('Строка скопирована');
    }
  };

  // Handle insert new row after current - insert empty row with defaults after selected
  const handleInsertAfter = async (detail: OrderDetail) => {
    const afterTempId = detail.temp_id || detail.detail_id;
    if (!afterTempId) return;

    // Insert new row with defaults after the selected row
    insertDetailAfter(afterTempId, QUICK_ADD_DEFAULTS as Omit<OrderDetail, 'temp_id'>);

    // Get the newly inserted detail and start editing it
    await new Promise(resolve => setTimeout(resolve, 50));
    const updatedDetails = useOrderFormStore.getState().details;

    // Find the detail that was just inserted (it will have the highest temp_id)
    const newDetail = [...updatedDetails].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];

    if (newDetail && tableRef.current) {
      tableRef.current.startEditRow(newDetail);
    }
  };

  // Handle recalculate all areas and sums
  const handleRecalculateSums = () => {
    if (details.length === 0) {
      message.warning('Нет позиций для пересчёта');
      return;
    }

    let areaUpdatedCount = 0;
    let costUpdatedCount = 0;
    let totalArea = 0;
    let totalAmount = 0;

    // First pass: recalculate area for each detail, then cost
    details.forEach((detail, index) => {
      const height = Number(detail.height) || 0;
      const width = Number(detail.width) || 0;
      const quantity = Number(detail.quantity) || 0;

      // Calculate area using INTEGER MATH to avoid floating point errors
      // height and width are in mm (integers), so we calculate in mm² first
      // Example: 550mm * 200mm * 2 = 220000 mm²
      // Then: ceil(220000 / 10000) / 100 = ceil(22) / 100 = 0.22 m²
      let newArea = 0;
      if (height > 0 && width > 0 && quantity > 0) {
        const areaMm2 = height * width * quantity; // Integer arithmetic - no floating point errors!
        newArea = Math.ceil(areaMm2 / 10000) / 100; // Convert to m² with 2 decimal places, round up
      }

      const identifier = detail.temp_id || detail.detail_id;
      const currentArea = Number(detail.area) || 0;

      console.log(`[Recalc] #${index + 1}: h=${height}, w=${width}, q=${quantity}, rawArea=${(height/1000)*(width/1000)*quantity}, newArea=${newArea}, currentArea=${currentArea}, diff=${Math.abs(newArea - currentArea)}, identifier=${identifier}`);

      // Update area if changed (compare as numbers with tolerance)
      if (identifier && Math.abs(newArea - currentArea) > 0.001) {
        console.log(`[Recalc] #${index + 1}: UPDATING area from ${currentArea} to ${newArea}`);
        updateDetail(identifier, { area: newArea });
        areaUpdatedCount++;
      } else {
        console.log(`[Recalc] #${index + 1}: SKIPPED - no identifier or no change`);
      }

      // Use new area for cost calculation
      const areaForCost = newArea > 0 ? newArea : currentArea;
      const pricePerSqm = Number(detail.milling_cost_per_sqm) || 0;
      const newDetailCost = Number((areaForCost * pricePerSqm).toFixed(2));
      const currentDetailCost = Number(detail.detail_cost) || 0;

      // Update cost if changed (compare as numbers with tolerance)
      if (identifier && Math.abs(newDetailCost - currentDetailCost) > 0.001) {
        updateDetail(identifier, { detail_cost: newDetailCost });
        costUpdatedCount++;
      }

      totalArea += areaForCost;
      totalAmount += newDetailCost;
    });

    // Round totals
    totalArea = Number(totalArea.toFixed(2));
    totalAmount = Number(totalAmount.toFixed(2));

    // Update total_amount in header
    updateHeaderField('total_amount', totalAmount);

    // Calculate final_amount
    // Note: discount is now stored as absolute amount (not percent)
    const discount = header.discount || 0;
    const discountedAmount = Math.max(0, Number((totalAmount - discount).toFixed(2)));
    updateHeaderField('final_amount', discountedAmount);

    if (discount > 0) {
      const discountPercent = totalAmount > 0 ? (discount / totalAmount) * 100 : 0;
      message.success(
        `Пересчитано: площадь ${areaUpdatedCount} поз., стоимость ${costUpdatedCount} поз. ` +
        `Площадь: ${totalArea.toLocaleString('ru-RU')} м², ` +
        `Сумма: ${totalAmount.toLocaleString('ru-RU')} ₸, скидка ${discount.toLocaleString('ru-RU')} ₸ (${discountPercent.toFixed(1)}%): ${discountedAmount.toLocaleString('ru-RU')} ₸`
      );
    } else {
      message.success(
        `Пересчитано: площадь ${areaUpdatedCount} поз., стоимость ${costUpdatedCount} поз. ` +
        `Площадь: ${totalArea.toLocaleString('ru-RU')} м², Сумма: ${totalAmount.toLocaleString('ru-RU')} ₸`
      );
    }
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
          <Button
            icon={<CalculatorOutlined />}
            onClick={handleRecalculateSums}
            disabled={details.length === 0}
          >
            Пересчитать суммы
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
          onQuickAdd={handleQuickAdd}
          onInsertAfter={handleInsertAfter}
          onCopyRow={handleCopyRow}
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
});

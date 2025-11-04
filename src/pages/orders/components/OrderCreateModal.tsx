// Order Create Modal
// Modal window for creating a new order with transition to edit mode after save

import React, { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { useNavigation } from '@refinedev/core';
import { OrderForm } from './OrderForm';
import { useOrderFormStore } from '../../../stores/orderFormStore';

interface OrderCreateModalProps {
  open: boolean;
  onClose: () => void;
}

export const OrderCreateModal: React.FC<OrderCreateModalProps> = ({ open, onClose }) => {
  const { edit } = useNavigation();
  const { reset } = useOrderFormStore();
  const [isReady, setIsReady] = useState(false);

  // Reset store when modal opens and mark as ready
  useEffect(() => {
    if (open) {
      console.log('[OrderCreateModal] Modal opened, resetting store...');
      reset();
      // Small delay to ensure store is reset
      setTimeout(() => {
        console.log('[OrderCreateModal] Store reset complete, ready to render form');
        setIsReady(true);
      }, 50);
    } else {
      // Reset ready state when modal closes
      setIsReady(false);
    }
  }, [open, reset]);

  const handleSaveSuccess = (orderId: number) => {
    console.log('[OrderCreateModal] Order saved successfully, orderId:', orderId);
    // Close modal
    onClose();

    // Navigate to edit page with the newly created order
    setTimeout(() => {
      edit('orders', orderId);
    }, 100);
  };

  const handleCancel = () => {
    console.log('[OrderCreateModal] Modal cancelled');
    // Close modal without saving
    onClose();
  };

  return (
    <Modal
      open={open}
      onCancel={handleCancel}
      footer={null}
      width="95%"
      style={{ top: 20 }}
      destroyOnClose
      title="Создание нового заказа"
    >
      {isReady && (
        <OrderForm
          mode="create"
          onSaveSuccess={handleSaveSuccess}
          onCancel={handleCancel}
        />
      )}
    </Modal>
  );
};

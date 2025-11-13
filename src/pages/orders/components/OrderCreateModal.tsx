// Order Create Modal
// Modal window for creating a new order with transition to edit mode after save

import React, { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './OrderForm';
import { useOrderFormStore } from '../../../stores/orderFormStore';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';

interface OrderCreateModalProps {
  open: boolean;
  onClose: () => void;
}

export const OrderCreateModal: React.FC<OrderCreateModalProps> = ({ open, onClose }) => {
  const navigate = useNavigate();
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
    console.log('[OrderCreateModal] ========== handleSaveSuccess STARTED ==========');
    console.log('[OrderCreateModal] Order saved successfully, orderId:', orderId);
    console.log('[OrderCreateModal] Calling onClose()...');

    // Close modal
    onClose();

    console.log('[OrderCreateModal] Modal closed, setting timeout for navigation...');
    // Navigate to edit page with the newly created order
    setTimeout(() => {
      console.log('[OrderCreateModal] Timeout executed, calling navigate(/orders/edit/' + orderId + ')...');
      try {
        navigate(`/orders/edit/${orderId}`);
        console.log('[OrderCreateModal] Navigation successful!');
      } catch (error) {
        console.error('[OrderCreateModal] Navigation failed:', error);
      }
    }, 100);

    console.log('[OrderCreateModal] ========== handleSaveSuccess ENDED ==========');
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
      modalRender={(modal) => <DraggableModalWrapper open={open}>{modal}</DraggableModalWrapper>}
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

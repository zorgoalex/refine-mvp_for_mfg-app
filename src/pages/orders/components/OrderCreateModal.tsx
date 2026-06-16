// Order Create Modal
// Modal window for creating a new order with transition to edit mode after save

import React, { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './OrderForm';
import { getOrderDraftStore, destroyOrderDraftStore, NEW_ORDER_KEY } from '../../../stores/orderFormStore';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';

interface OrderCreateModalProps {
  open: boolean;
  onClose: () => void;
}

export const OrderCreateModal: React.FC<OrderCreateModalProps> = ({ open, onClose }) => {
  const navigate = useNavigate();
  const [isReady, setIsReady] = useState(false);

  // Reset store when modal opens and mark as ready.
  // NOTE: depend ONLY on `open`. Destroying the "new" draft store recreates a fresh
  // store instance on the next render, which would give a store action (e.g. `reset`)
  // a new identity — putting such an action in the dep array re-fires this effect every
  // render → destroy/recreate churn → "Maximum update depth exceeded". Resolve the fresh
  // store imperatively instead of subscribing to it.
  useEffect(() => {
    if (open) {
      // Drop any stale "new" draft (and its sessionStorage) so each create starts clean.
      destroyOrderDraftStore(NEW_ORDER_KEY);
      getOrderDraftStore(NEW_ORDER_KEY).getState().reset();
      // Small delay to ensure store is reset
      const timer = setTimeout(() => {
        setIsReady(true);
      }, 50);
      return () => clearTimeout(timer);
    }
    // Reset ready state when modal closes
    setIsReady(false);
    return undefined;
  }, [open]);

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

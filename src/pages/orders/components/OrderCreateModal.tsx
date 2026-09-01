// Order Create Modal
// Modal window for creating a new order with transition to edit mode after save

import React, { useEffect, useState } from 'react';
import { Button, Modal, Space, Typography } from 'antd';
import { ExpandOutlined, MinusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './OrderForm';
import { getOrderDraftStore, destroyOrderDraftStore, NEW_ORDER_KEY } from '../../../stores/orderFormStore';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';
import './orderCreateModal.css';

interface OrderCreateModalProps {
  open: boolean;
  onClose: () => void;
}

export const OrderCreateModal: React.FC<OrderCreateModalProps> = ({ open, onClose }) => {
  const navigate = useNavigate();
  const [isReady, setIsReady] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  // Reset store when modal opens and mark as ready.
  // NOTE: depend ONLY on `open`. Destroying the "new" draft store recreates a fresh
  // store instance on the next render, which would give a store action (e.g. `reset`)
  // a new identity — putting such an action in the dep array re-fires this effect every
  // render → destroy/recreate churn → "Maximum update depth exceeded". Resolve the fresh
  // store imperatively instead of subscribing to it.
  useEffect(() => {
    if (open) {
      setIsMinimized(false);
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

  const closeAndDiscard = () => {
    destroyOrderDraftStore(NEW_ORDER_KEY);
    onClose();
  };

  const requestClose = () => {
    const isDirty = getOrderDraftStore(NEW_ORDER_KEY).getState().isDirty;
    if (!isDirty) {
      closeAndDiscard();
      return;
    }
    Modal.confirm({
      title: 'Несохранённый заказ',
      content: 'Закрыть форму и удалить несохранённые данные?',
      okText: 'Закрыть без сохранения',
      okButtonProps: { danger: true },
      cancelText: 'Продолжить работу',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk: closeAndDiscard,
    });
  };

  const restore = () => {
    navigate('/orders');
    setIsMinimized(false);
  };

  return (
    <>
      <Modal
        open={open && !isMinimized}
        onCancel={requestClose}
        footer={null}
        width="95%"
        style={{ top: 20 }}
        maskClosable={false}
        keyboard={false}
        title={(
          <div className="order-create-modal__title">
            <Typography.Text strong>Создание нового заказа</Typography.Text>
            <Button
              aria-label="Свернуть форму создания заказа"
              className="order-create-modal__minimize"
              icon={<MinusOutlined />}
              onClick={() => setIsMinimized(true)}
              size="small"
              type="text"
            >
              Свернуть
            </Button>
          </div>
        )}
        modalRender={(modal) => (
          <DraggableModalWrapper open={open && !isMinimized}>{modal}</DraggableModalWrapper>
        )}
      >
        {isReady && (
          <OrderForm
            mode="create"
            onSaveSuccess={handleSaveSuccess}
            onCancel={closeAndDiscard}
          />
        )}
      </Modal>

      {open && isMinimized && (
        <div className="order-create-modal__minimized" role="status">
          <Space size="middle">
            <span className="order-create-modal__minimized-copy">
              <Typography.Text strong>Новый заказ</Typography.Text>
              <Typography.Text type="secondary">Черновик сохранён</Typography.Text>
            </span>
            <Button
              aria-label="Развернуть форму создания заказа"
              icon={<ExpandOutlined />}
              onClick={restore}
              type="primary"
            >
              Развернуть
            </Button>
          </Space>
        </div>
      )}
    </>
  );
};

// Edit Order Page

import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderEdit: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const orderId = id ? parseInt(id, 10) : undefined;

  const handleSaveSuccess = (savedOrderId: number) => {
    // Stay on the edit page after save (no navigation)
    // Navigation is disabled per product requirement
  };

  const handleCancel = () => {
    // Navigate back to orders list
    navigate('/orders');
  };

  return (
    <OrderForm
      key={orderId}
      mode="edit"
      orderId={orderId}
      onSaveSuccess={handleSaveSuccess}
      onCancel={handleCancel}
    />
  );
};

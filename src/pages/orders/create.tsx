// Create Order Page

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderCreate: React.FC = () => {
  const navigate = useNavigate();

  const handleSaveSuccess = (orderId: number) => {
    // After successful create, redirect to edit page for this order
    console.log('[OrderCreate] handleSaveSuccess - navigating to edit page for order:', orderId);
    navigate(`/orders/edit/${orderId}`, { replace: true });
  };

  const handleCancel = () => {
    // Navigate back to orders list
    navigate('/orders');
  };

  return (
    <OrderForm
      mode="create"
      onSaveSuccess={handleSaveSuccess}
      onCancel={handleCancel}
    />
  );
};

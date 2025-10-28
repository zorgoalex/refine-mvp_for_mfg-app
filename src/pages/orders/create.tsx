// Create Order Page

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderCreate: React.FC = () => {
  const navigate = useNavigate();

  const handleSaveSuccess = (orderId: number) => {
    // Navigate to the created order's show page
    navigate(`/orders/show/${orderId}`);
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

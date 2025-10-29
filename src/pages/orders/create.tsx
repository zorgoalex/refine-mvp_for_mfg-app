// Create Order Page

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderCreate: React.FC = () => {
  const navigate = useNavigate();

  const handleSaveSuccess = (orderId: number) => {
    // Stay on the page after save (no navigation)
    // Navigation is disabled per product requirement
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

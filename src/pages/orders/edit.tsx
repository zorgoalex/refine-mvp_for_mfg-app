// Edit Order Page

import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderEdit: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const orderId = id ? parseInt(id, 10) : undefined;

  const handleSaveSuccess = (savedOrderId: number) => {
    // Navigate to the updated order's show page
    navigate(`/orders/show/${savedOrderId}`);
  };

  const handleCancel = () => {
    // Navigate back to orders list
    navigate('/orders');
  };

  return (
    <OrderForm
      mode="edit"
      orderId={orderId}
      onSaveSuccess={handleSaveSuccess}
      onCancel={handleCancel}
    />
  );
};

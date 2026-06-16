// Edit Order Page

import React from 'react';
import { useParams } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderEdit: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const orderId = id ? parseInt(id, 10) : undefined;

  const handleSaveSuccess = (savedOrderId: number) => {
    // Stay on the edit page after save (no navigation)
    // Navigation is disabled per product requirement
  };

  // No onCancel: in the tabbed workspace OrderForm owns the close path
  // (closeTab + navigate to neighbour). Passing onCancel would force the
  // embedded/modal branch instead.
  return (
    <OrderForm
      key={orderId}
      mode="edit"
      orderId={orderId}
      onSaveSuccess={handleSaveSuccess}
    />
  );
};

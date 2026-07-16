// Create Order Page — полноценная страница /orders/create (роут в App.tsx).
// Используется draft-first флоу Базис-панелей (location.state.bazisDraft) и
// доступна как обычная страница создания.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { OrderForm } from './components/OrderForm';

export const OrderCreate: React.FC = () => {
  const navigate = useNavigate();

  const handleSaveSuccess = (orderId: number) => {
    navigate(`/orders/edit/${orderId}`, { replace: true });
  };

  // Без onCancel: в tabbed workspace OrderForm сам владеет закрытием
  // (closeTab + переход к соседу); onCancel форсит embedded/modal-ветку.
  return <OrderForm mode="create" onSaveSuccess={handleSaveSuccess} />;
};

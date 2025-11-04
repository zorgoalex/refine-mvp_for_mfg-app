// Main Order Form Component
// Master-Detail form with Tabs for child entities

import React, { useEffect, useRef } from 'react';
import { Card, Tabs, Button, Space, Spin, notification } from 'antd';
import { SaveOutlined, CloseOutlined } from '@ant-design/icons';
import { useOne, useList, useNavigation } from '@refinedev/core';
import { useOrderFormStore } from '../../../stores/orderFormStore';
import { useDefaultStatuses } from '../../../hooks/useDefaultStatuses';
import { useUnsavedChangesWarning } from '../../../hooks/useUnsavedChangesWarning';
import { useOrderSave } from '../../../hooks/useOrderSave';
import { OrderFormMode } from '../../../types/orders';
import { orderFormSchema } from '../../../schemas/orderSchema';

// Sections
import { OrderHeaderSummary } from './sections/OrderHeaderSummary';
import { OrderBasicInfo } from './sections/OrderBasicInfo';
import { OrderStatusSection } from './sections/OrderStatusSection';
import { OrderNotesSection } from './sections/OrderNotesSection';
import { OrderDatesSection } from './sections/OrderDatesSection';
import { OrderFinanceSection } from './sections/OrderFinanceSection';
import { OrderLegacySection } from './sections/OrderLegacySection';
import { OrderFilesSection } from './sections/OrderFilesSection';
import { OrderAggregatesDisplay } from './sections/OrderAggregatesDisplay';

// Tabs
import { OrderDetailsTab } from './tabs/OrderDetailsTab';

interface OrderFormProps {
  mode: OrderFormMode;
  orderId?: number;
  onSaveSuccess?: (orderId: number) => void;
  onCancel?: () => void;
}

export const OrderForm: React.FC<OrderFormProps> = ({
  mode,
  orderId,
  onSaveSuccess,
  onCancel,
}) => {
  const {
    header,
    setHeader,
    isDirty,
    reset,
    loadOrder,
    getFormValues,
    setDirty,
  } = useOrderFormStore();

  const { defaultOrderStatus, defaultPaymentStatus, isLoading: statusesLoading } =
    useDefaultStatuses();
  const { checkUnsavedChanges } = useUnsavedChangesWarning(isDirty);
  const { saveOrder, isSaving } = useOrderSave();

  // Load existing order data in edit mode
  const { data: orderData, isLoading: orderLoading } = useOne({
    resource: 'orders',
    id: orderId,
    queryOptions: {
      enabled: mode === 'edit' && !!orderId,
    },
  });

  // Load order details in edit mode (only if orderId is valid number)
  const shouldLoadDetails = mode === 'edit' && orderId && typeof orderId === 'number' && orderId > 0;

  const { data: detailsData, isLoading: detailsLoading } = useList({
    resource: 'order_details',
    filters: [{ field: 'order_id', operator: 'eq', value: orderId || 0 }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: shouldLoadDetails,
    },
  });

  // Load payments in edit mode (only if orderId is valid number)
  const shouldLoadPayments = mode === 'edit' && orderId && typeof orderId === 'number' && orderId > 0;

  const { data: paymentsData, isLoading: paymentsLoading } = useList({
    resource: 'payments',
    filters: [{ field: 'order_id', operator: 'eq', value: orderId || 0 }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: shouldLoadPayments,
    },
  });

  // Initialize form with default values for create mode
  useEffect(() => {
    if (mode === 'create' && defaultOrderStatus && defaultPaymentStatus) {
      setHeader({
        order_date: new Date().toISOString().split('T')[0], // Today's date
        order_status_id: defaultOrderStatus,
        payment_status_id: defaultPaymentStatus,
        priority: 100,
        discount: 0,
        paid_amount: 0,
      });
      setDirty(false); // Reset dirty flag after initial setup
    }
  }, [mode, defaultOrderStatus, defaultPaymentStatus]);

  // Load order data in edit mode (one-time)
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    if (mode === 'edit' && orderData?.data) {
      // Wait for details and payments only if they should be loaded
      const detailsReady = !shouldLoadDetails || (!detailsLoading && detailsData);
      const paymentsReady = !shouldLoadPayments || (!paymentsLoading && paymentsData);

      if (detailsReady && paymentsReady) {
        loadOrder({
          header: orderData.data,
          details: detailsData?.data || [],
          payments: paymentsData?.data || [],
          workshops: [],
          requirements: [],
        });
        setDirty(false);
        didInit.current = true;
      }
    }
  }, [
    mode,
    orderData,
    detailsData,
    paymentsData,
    detailsLoading,
    paymentsLoading,
    shouldLoadDetails,
    shouldLoadPayments,
  ]);

  // Navigation
  const { list, edit } = useNavigation();

  // Handle save
  const handleSave = async () => {
    try {
      const formValues = getFormValues();

      // Zod validation
      const result = orderFormSchema.safeParse(formValues);
      if (!result.success) {
        // Log full error for debugging
        // console.error('Validation failed:', result.error);
        // console.error('Form values:', formValues);

        // Show validation errors
        const errors = result.error?.errors || [];
        const errorMessages = errors.length > 0
          ? errors.map((err) => `${err.path.join('.')}: ${err.message}`).join('\n')
          : 'Ошибка валидации данных';

        notification.error({
          message: 'Ошибка валидации',
          description: (
            <div style={{ whiteSpace: 'pre-line' }}>
              {errorMessages}
            </div>
          ),
          duration: 0, // Don't auto-hide
        });
        return;
      }

        const savedOrderId = await saveOrder(formValues, mode === 'edit');

      if (savedOrderId) {
        // On success: remain on the same page.
        // If this was a create, set header.order_id so tabs unlock and state reflects persisted record
        if (mode === 'create' && !header.order_id) {
          setHeader({ order_id: savedOrderId });
        }
        setDirty(false);
        if (onSaveSuccess) {
          onSaveSuccess(savedOrderId);
        }
      }
    } catch (error) {
      notification.error({
        message: 'Ошибка при сохранении',
        description: error instanceof Error ? error.message : 'Неизвестная ошибка',
        duration: 0,
      });
    }
  };

  // Handle cancel
  const handleCancel = () => {
    checkUnsavedChanges(() => {
      reset();
      if (onCancel) {
        onCancel();
      }
    });
  };

  // Show loading only for essential data
  const isLoadingEssential =
    statusesLoading ||
    orderLoading ||
    (shouldLoadDetails && detailsLoading) ||
    (shouldLoadPayments && paymentsLoading);

  if (isLoadingEssential) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: '50px' }}>
          <Spin size="large" />
          <div style={{ marginTop: '16px' }}>
            {orderLoading ? 'Загрузка заказа...' : 'Загрузка формы...'}
          </div>
        </div>
      </Card>
    );
  }

  const headerTabItems = [
    {
      key: 'basic',
      label: 'Основная информация',
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <OrderBasicInfo />
          <OrderStatusSection />
          <OrderNotesSection />
        </Space>
      ),
    },
    {
      key: 'dates',
      label: 'Даты',
      children: <OrderDatesSection />,
    },
    {
      key: 'finance',
      label: 'Финансы',
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <OrderFinanceSection />
          <OrderAggregatesDisplay />
        </Space>
      ),
    },
    {
      key: 'additional',
      label: 'Дополнительно',
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <OrderLegacySection />
          <OrderFilesSection />
        </Space>
      ),
    },
    {
      key: 'details',
      label: 'Детали заказа',
      children: <OrderDetailsTab />,
    },
    {
      key: 'payments',
      label: 'Платежи',
      children: <div>TODO: Payments Tab</div>,
      disabled: mode === 'create' && !header.order_id,
    },
    {
      key: 'workshops',
      label: 'Цеха',
      children: <div>TODO: Workshops Tab</div>,
      disabled: mode === 'create' && !header.order_id,
    },
    {
      key: 'requirements',
      label: 'Потребности',
      children: <div>TODO: Requirements Tab</div>,
      disabled: mode === 'create' && !header.order_id,
    },
  ];

  return (
    <Card
      title={mode === 'create' ? 'Создание заказа' : `Редактирование заказа ${header.order_name || ''}`}
      extra={
        <Space>
          <Button
            type={isDirty ? "primary" : "default"}
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={isSaving}
            disabled={!isDirty}
          >
            Сохранить
          </Button>
          {isDirty && (
            <Button icon={<CloseOutlined />} onClick={handleCancel}>
              Отмена
            </Button>
          )}
        </Space>
      }
    >
      {/* Read-only header with order summary (only in edit mode) */}
      {mode === 'edit' && <OrderHeaderSummary />}

      {/* Editable tabs */}
      <Tabs
        defaultActiveKey="basic"
        items={headerTabItems}
        type="card"
      />
    </Card>
  );
};

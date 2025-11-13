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
    details,
    setHeader,
    updateHeaderField,
    isDirty,
    reset,
    loadOrder,
    getFormValues,
    setDirty,
    isTotalAmountManual,
  } = useOrderFormStore();

  const { defaultOrderStatus, defaultPaymentStatus, isLoading: statusesLoading } =
    useDefaultStatuses();
  const { checkUnsavedChanges } = useUnsavedChangesWarning(isDirty);
  const { saveOrder, isSaving } = useOrderSave();


  // Load existing order data in edit mode
  const shouldLoadOrder = mode === 'edit' && !!orderId;
  const { data: orderData, isLoading: orderLoading } = useOne({
    resource: 'orders',
    id: orderId,
    queryOptions: {
      enabled: shouldLoadOrder,
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
        total_amount: 0,
        discounted_amount: 0,
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
        // Auto-calculate empty detail_cost before loading into store
        const processedDetails = (detailsData?.data || []).map((detail: any) => {
          // If detail_cost is null/undefined but area and price are available, calculate it
          if (!detail.detail_cost && detail.area && detail.milling_cost_per_sqm) {
            const calculatedCost = Number((detail.area * detail.milling_cost_per_sqm).toFixed(2));
            console.log(
              '[OrderForm] Auto-calculating cost for detail #' + detail.detail_number +
              ': area=' + detail.area + ' × price=' + detail.milling_cost_per_sqm +
              ' = ' + calculatedCost
            );
            return {
              ...detail,
              detail_cost: calculatedCost,
            };
          }
          return detail;
        });

        loadOrder({
          header: orderData.data,
          details: processedDetails,
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

  // Ensure legacy details always have a calculated sum
  useEffect(() => {
    if (!details || details.length === 0) {
      return;
    }

    const store = useOrderFormStore.getState();
    let patchedCount = 0;

    details.forEach((detail) => {
      const hasCost = detail.detail_cost !== undefined && detail.detail_cost !== null;
      const hasArea = typeof detail.area === 'number';
      const hasPrice = typeof detail.milling_cost_per_sqm === 'number';

      if (!hasCost && hasArea && hasPrice) {
        const autoCost = Number((detail.area! * detail.milling_cost_per_sqm!).toFixed(2));
        const identifier = detail.temp_id || detail.detail_id;
        if (identifier) {
          store.updateDetail(identifier, { detail_cost: autoCost });
          patchedCount += 1;
        }
      }
    });

    if (patchedCount > 0) {
      console.log(`[OrderForm] Auto-filled detail_cost for ${patchedCount} legacy detail(s)`);
    }
  }, [details]);

  // Auto-recalculate total_amount from details (unless overridden manually)
  useEffect(() => {
    if (orderLoading || detailsLoading) {
      return;
    }

    if (!details || details.length === 0) {
      if (header.total_amount === undefined || header.total_amount === null) {
        return;
      }
    }

    if (isTotalAmountManual) {
      return;
    }

    const autoTotalRaw = details.reduce((sum, detail) => {
      if (detail?.detail_cost !== undefined && detail?.detail_cost !== null) {
        return sum + Number(detail.detail_cost);
      }
      const hasArea = typeof detail?.area === 'number';
      const hasPrice = typeof detail?.milling_cost_per_sqm === 'number';
      if (hasArea && hasPrice) {
        return sum + Number(((detail.area as number) * (detail.milling_cost_per_sqm as number)).toFixed(2));
      }
      return sum;
    }, 0);

    const autoTotal = Number(autoTotalRaw.toFixed(2));
    const currentTotal =
      typeof header.total_amount === 'number'
        ? Number(header.total_amount.toFixed(2))
        : header.total_amount ?? 0;

    const shouldUpdate =
      header.total_amount === undefined ||
      header.total_amount === null ||
      Number.isNaN(currentTotal) ||
      Math.abs(Number(currentTotal) - autoTotal) >= 0.01;

    if (shouldUpdate) {
      updateHeaderField('total_amount', autoTotal);
    }
  }, [
    details,
    header.total_amount,
    isTotalAmountManual,
    orderLoading,
    detailsLoading,
    updateHeaderField,
  ]);

  // Navigation
  const { list } = useNavigation();

  // Handle save
  const handleSave = async () => {
    console.log('[OrderForm] ========== handleSave STARTED ==========');
    console.log('[OrderForm] handleSave - mode:', mode);
    console.log('[OrderForm] handleSave - orderId:', orderId);

    try {
      const formValues = getFormValues();
      console.log('[OrderForm] handleSave - formValues:', formValues);
      console.log('[OrderForm] handleSave - details count:', formValues.details?.length || 0);

      // Zod validation
      const result = orderFormSchema.safeParse(formValues);
      console.log('[OrderForm] handleSave - validation result:', result.success);
      console.log('[OrderForm] handleSave - full result object:', result);

      if (!result.success) {
        // Show validation errors
        console.log('[OrderForm] handleSave - result.error (FULL):', result.error);
        console.log('[OrderForm] handleSave - result.error type:', typeof result.error);
        console.log('[OrderForm] handleSave - result.error keys:', result.error ? Object.keys(result.error) : 'null');
        console.log('[OrderForm] handleSave - result.error.issues:', result.error?.issues);
        console.log('[OrderForm] handleSave - result.error.errors:', result.error?.errors);

        // Zod uses 'issues' property, not 'errors'!
        const issues = result.error?.issues || [];
        console.log('[OrderForm] handleSave - validation issues:', issues);
        console.log('[OrderForm] handleSave - validation issues (detailed):', JSON.stringify(issues, null, 2));
        console.log('[OrderForm] handleSave - validation issues length:', issues.length);

        // Check if the error is about missing details (array too small)
        const hasDetailsError = issues.some(err => {
          const pathStr = err.path.join('.');
          const isDetailsPath = pathStr === 'details';
          const isTooSmall = err.code === 'too_small';
          const hasMinimumText = err.message.includes('минимум');

          console.log('[OrderForm] handleSave - checking error:', {
            path: err.path,
            pathStr,
            code: err.code,
            message: err.message,
            isDetailsPath,
            isTooSmall,
            hasMinimumText,
            result: isDetailsPath && (isTooSmall || hasMinimumText)
          });

          // Check if it's a 'details' error with too_small code (array length validation)
          return isDetailsPath && (isTooSmall || hasMinimumText);
        });

        console.log('[OrderForm] handleSave - hasDetailsError:', hasDetailsError);

        if (hasDetailsError) {
          // Special handling for missing details error - prominent notification
          console.log('[OrderForm] handleSave - showing SPECIAL details error notification');
          notification.error({
            message: '⚠️ Невозможно сохранить заказ',
            description: (
              <div style={{ fontSize: '14px' }}>
                <p style={{ marginBottom: '12px', fontWeight: 'bold', fontSize: '15px', color: '#ff4d4f' }}>
                  Для создания заказа необходимо добавить минимум одну позицию (деталь).
                </p>
                <p style={{ marginBottom: '8px' }}>
                  📋 Перейдите на вкладку <strong>"Позиции заказа"</strong>
                </p>
                <p style={{ marginBottom: 0 }}>
                  ➕ Нажмите кнопку <strong>"Добавить"</strong> для создания позиции
                </p>
              </div>
            ),
            duration: 0, // Don't auto-hide
          });
        } else {
          // Regular validation errors
          console.log('[OrderForm] handleSave - showing REGULAR validation error notification');
          const errorMessages = issues.length > 0
            ? issues.map((err) => `${err.path.join('.')}: ${err.message}`).join('\n')
            : 'Ошибка валидации данных';

          console.log('[OrderForm] handleSave - errorMessages:', errorMessages);

          notification.error({
            message: 'Ошибка валидации',
            description: (
              <div style={{ whiteSpace: 'pre-line' }}>
                {errorMessages}
              </div>
            ),
            duration: 0, // Don't auto-hide
          });
        }
        return;
      }

        console.log('[OrderForm] handleSave - calling saveOrder...');
        const savedOrderId = await saveOrder(formValues, mode === 'edit');
        console.log('[OrderForm] handleSave - saveOrder returned:', savedOrderId);

      if (savedOrderId) {
        console.log('[OrderForm] handleSave - save SUCCESS, processing result...');
        console.log('[OrderForm] handleSave - mode:', mode);
        console.log('[OrderForm] handleSave - header.order_id:', header.order_id);
        console.log('[OrderForm] handleSave - savedOrderId:', savedOrderId);

        // On success: remain on the same page.
        // If this was a create, set header.order_id so tabs unlock and state reflects persisted record
        if (mode === 'create' && !header.order_id) {
          console.log('[OrderForm] handleSave - setting header.order_id to:', savedOrderId);
          setHeader({ order_id: savedOrderId });
        }

        console.log('[OrderForm] handleSave - setting dirty to false');
        setDirty(false);

        console.log('[OrderForm] handleSave - onSaveSuccess callback exists?', !!onSaveSuccess);
        if (onSaveSuccess) {
          console.log('[OrderForm] handleSave - calling onSaveSuccess with orderId:', savedOrderId);
          onSaveSuccess(savedOrderId);
          console.log('[OrderForm] handleSave - onSaveSuccess called successfully');
        } else {
          console.warn('[OrderForm] handleSave - WARNING: onSaveSuccess callback is not defined!');
        }
      }
    } catch (error) {
      console.error('[OrderForm] handleSave - CATCH block, error:', error);
      notification.error({
        message: 'Ошибка при сохранении',
        description: error instanceof Error ? error.message : 'Неизвестная ошибка',
        duration: 0,
      });
    } finally {
      console.log('[OrderForm] ========== handleSave ENDED ==========');
    }
  };

  const exitForm = () => {
    reset();
    if (onCancel) {
      onCancel();
    } else {
      list('orders');
    }
  };

  // Handle cancel / close requests
  const handleCancel = () => {
    checkUnsavedChanges(exitForm);
  };

  // Show loading only for essential data
  const isLoadingEssential =
    statusesLoading ||
    (shouldLoadOrder && orderLoading) ||
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

  const orderName = header.order_name?.trim();
  const cardTitle =
    mode === 'create'
      ? `Создание заказа${orderName ? ` «${orderName}»` : ''}`
      : `Редактирование заказа${orderName ? ` «${orderName}»` : ''}`;

  return (
    <Card
      title={cardTitle}
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

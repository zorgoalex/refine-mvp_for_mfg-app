// Main Order Form Component
// Master-Detail form with Tabs for child entities

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Tabs, Button, Space, Spin, notification } from 'antd';
import { SaveOutlined, CloseOutlined, EyeOutlined } from '@ant-design/icons';
import { useOne, useList, useNavigation } from '@refinedev/core';
import { useOrderFormStore } from '../../../stores/orderFormStore';
import { useDefaultStatuses } from '../../../hooks/useDefaultStatuses';
import { useUnsavedChangesWarning } from '../../../hooks/useUnsavedChangesWarning';
import { useOrderSave } from '../../../hooks/useOrderSave';
import { useOrderExport } from '../../../hooks/useOrderExport';
import { OrderFormMode } from '../../../types/orders';
import { orderFormSchema } from '../../../schemas/orderSchema';
import dayjs from 'dayjs';

// Sections
import { OrderHeaderSummary } from './sections/OrderHeaderSummary';
import { OrderBasicInfo } from './sections/OrderBasicInfo';
import { OrderStatusSection } from './sections/OrderStatusSection';
import { OrderNotesSection } from './sections/OrderNotesSection';
import { OrderDatesSection } from './sections/OrderDatesSection';
import { OrderFinanceSection } from './sections/OrderFinanceSection';
import { OrderMaterialsTab } from './sections/OrderMaterialsTab';
import { OrderLegacySection } from './sections/OrderLegacySection';
import { OrderFilesSection } from './sections/OrderFilesSection';
import { OrderAggregatesDisplay } from './sections/OrderAggregatesDisplay';

// Tabs
import { OrderDetailsTab, OrderDetailsTabRef } from './tabs/OrderDetailsTab';
import { OrderPaymentsTab } from './tabs/OrderPaymentsTab';

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
    payments,
    setHeader,
    updateHeaderField,
    isDirty,
    isDetailEditing,
    reset,
    loadOrder,
    getFormValues,
    setDirty,
    isTotalAmountManual,
    deleteDetail,
  } = useOrderFormStore();

  // Ref for OrderDetailsTab to apply current edits before save
  const detailsTabRef = useRef<OrderDetailsTabRef>(null);

  const { defaultOrderStatus, defaultPaymentStatus, isLoading: statusesLoading } =
    useDefaultStatuses();
  const { checkUnsavedChanges } = useUnsavedChangesWarning(isDirty);
  const { saveOrder, isSaving } = useOrderSave();
  const { exportToDrive, isUploading } = useOrderExport();
  const [activeTab, setActiveTab] = useState('details');


  // Load existing order data in edit mode
  // Use relationship to load doweling_order in the same query (1:1 by order_id)
  const shouldLoadOrder = mode === 'edit' && !!orderId;
  const { data: orderData, isLoading: orderLoading } = useOne({
    resource: 'orders',
    id: orderId,
    meta: {
      fields: [
        '*',
        { doweling_orders: ['doweling_order_id', 'doweling_order_name', 'design_engineer_id', 'design_engineer'] }
      ]
    },
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
      const today = dayjs();
      const orderDate = today.format('YYYY-MM-DD');
      const plannedCompletion = today.add(10, 'day').format('YYYY-MM-DD');
      setHeader({
        order_date: orderDate,
        planned_completion_date: plannedCompletion,
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

        // Extract doweling order fields from relationship (1:1, returns array with 0 or 1 element)
        const dowelingOrders = orderData.data.doweling_orders || [];
        const dowelingOrder = dowelingOrders[0];
        const { doweling_orders, ...orderDataWithoutRelationship } = orderData.data;
        const headerWithDoweling = {
          ...orderDataWithoutRelationship,
          doweling_order_id: dowelingOrder?.doweling_order_id || null,
          doweling_order_name: dowelingOrder?.doweling_order_name || null,
          design_engineer_id: dowelingOrder?.design_engineer_id || null,
          design_engineer: dowelingOrder?.design_engineer || null,
        };

        loadOrder({
          header: headerWithDoweling,
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

  // Auto-recalculate discounted_amount when total_amount or discount changes
  // This useEffect is in OrderForm (always mounted) to ensure recalculation
  // happens regardless of which tab is active
  useEffect(() => {
    if (orderLoading || detailsLoading) {
      return;
    }

    const totalAmount = header.total_amount || 0;
    const discount = header.discount || 0;
    // discount is absolute amount, not percent
    const expectedDiscountedAmount = Math.max(0, Number((totalAmount - discount).toFixed(2)));

    // Only update if changed (avoid infinite loops)
    if (header.discounted_amount !== expectedDiscountedAmount) {
      updateHeaderField('discounted_amount', expectedDiscountedAmount);
    }
  }, [
    header.total_amount,
    header.discount,
    header.discounted_amount,
    orderLoading,
    detailsLoading,
    updateHeaderField,
  ]);

  // Auto-recalculate paid_amount from payments
  useEffect(() => {
    if (orderLoading || detailsLoading) return;

    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const roundedPaid = Number(totalPaid.toFixed(2));

    if (header.paid_amount !== roundedPaid) {
      updateHeaderField('paid_amount', roundedPaid);
    }
  }, [payments, header.paid_amount, orderLoading, detailsLoading, updateHeaderField]);

  // Auto-update payment_status_id based on paid_amount and discounted_amount
  // Only auto-update if current status is 1 (не оплачено), 2 (частично), or 3 (оплачено)
  // If user set a custom status (other than 1,2,3), don't auto-update
  useEffect(() => {
    if (orderLoading || detailsLoading) return;

    // Skip auto-update if current status is not one of the standard payment statuses (1, 2, 3)
    const currentStatus = header.payment_status_id;
    if (currentStatus && currentStatus !== 1 && currentStatus !== 2 && currentStatus !== 3) {
      return;
    }

    const paidAmount = header.paid_amount || 0;
    const discountedAmount = header.discounted_amount || header.total_amount || 0;

    let newPaymentStatusId: number;

    if (paidAmount === 0) {
      newPaymentStatusId = 1; // Не оплачено
    } else if (paidAmount < discountedAmount) {
      newPaymentStatusId = 2; // Частично оплачено
    } else {
      newPaymentStatusId = 3; // Оплачено
    }

    // Only update if changed to avoid unnecessary re-renders
    if (header.payment_status_id !== newPaymentStatusId) {
      updateHeaderField('payment_status_id', newPaymentStatusId);
    }
  }, [
    header.paid_amount,
    header.discounted_amount,
    header.total_amount,
    header.payment_status_id,
    orderLoading,
    detailsLoading,
    updateHeaderField,
  ]);

  // Navigation
  const { list, show } = useNavigation();

  // Handle save
  const handleSave = async () => {
    console.log('[OrderForm] ========== handleSave STARTED ==========');
    console.log('[OrderForm] handleSave - mode:', mode);
    console.log('[OrderForm] handleSave - orderId:', orderId);

    // Apply current edits from detail table before saving
    if (detailsTabRef.current) {
      console.log('[OrderForm] handleSave - applying current edits from detail table...');
      const applied = await detailsTabRef.current.applyCurrentEdits();
      if (!applied) {
        console.log('[OrderForm] handleSave - failed to apply current edits, aborting save');
        notification.warning({
          message: 'Ошибка валидации',
          description: 'Заполните обязательные поля в редактируемой позиции',
        });
        return;
      }
      console.log('[OrderForm] handleSave - current edits applied successfully');
    }

    try {
      const formValues = getFormValues();
      console.log('[OrderForm] handleSave - formValues:', formValues);
      console.log('[OrderForm] handleSave - details count:', formValues.details?.length || 0);

      // Filter out unfilled details before validation (new details with only default values)
      const isDetailUnfilled = (detail: any): boolean => {
        // Only check new details (no detail_id)
        if (detail.detail_id) return false;
        // Check if essential fields are empty/null/zero
        const hasNoHeight = !detail.height || detail.height === 0;
        const hasNoWidth = !detail.width || detail.width === 0;
        const hasNoArea = !detail.area || detail.area === 0;
        return hasNoHeight && hasNoWidth && hasNoArea;
      };

      const filteredDetails = (formValues.details || []).filter(detail => !isDetailUnfilled(detail));
      const skippedCount = (formValues.details?.length || 0) - filteredDetails.length;
      if (skippedCount > 0) {
        console.log(`[OrderForm] handleSave - filtered out ${skippedCount} unfilled detail(s)`);
      }

      // Normalize detail_numbers: sort by current number and renumber sequentially 1, 2, 3...
      // This fixes any duplicates or gaps in numbering before validation
      const sortedDetails = [...filteredDetails].sort((a, b) =>
        (a.detail_number || 0) - (b.detail_number || 0)
      );
      formValues.details = sortedDetails.map((detail, index) => ({
        ...detail,
        detail_number: index + 1,
      }));
      console.log(`[OrderForm] handleSave - normalized ${formValues.details.length} detail numbers`);

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
          // Regular validation errors - format them nicely
          console.log('[OrderForm] handleSave - showing REGULAR validation error notification');

          // Field name mappings for human-readable messages
          const fieldLabels: Record<string, string> = {
            // Header fields
            'header.order_name': 'Название заказа',
            'header.client_id': 'Клиент',
            'header.order_date': 'Дата заказа',
            'header.order_status_id': 'Статус заказа',
            'header.payment_status_id': 'Статус оплаты',
            'header.planned_completion_date': 'Плановая дата завершения',
            'header.total_amount': 'Сумма заказа',
            'header.discount': 'Скидка',
            'header.paid_amount': 'Оплачено',
            // Detail fields
            'height': 'Высота',
            'width': 'Ширина',
            'quantity': 'Количество',
            'area': 'Площадь',
            'material_id': 'Материал',
            'milling_type_id': 'Тип фрезеровки',
            'edge_type_id': 'Тип обката',
            'detail_cost': 'Сумма детали',
            'milling_cost_per_sqm': 'Цена за м²',
          };

          // Group errors by section (header vs details)
          const headerErrors: string[] = [];
          const detailErrors: Map<number, string[]> = new Map();
          const generalDetailErrors: string[] = [];

          issues.forEach((err) => {
            const pathStr = err.path.join('.');

            // Check if it's a general details error (e.g., "details" without index)
            if (pathStr === 'details' && err.message) {
              generalDetailErrors.push(err.message);
              return;
            }

            // Check if it's a detail error (e.g., details.0.height)
            const detailMatch = pathStr.match(/^details\.(\d+)\.(.+)$/);
            if (detailMatch) {
              const detailIndex = parseInt(detailMatch[1], 10);
              const fieldName = detailMatch[2];
              const label = fieldLabels[fieldName] || fieldName;

              if (!detailErrors.has(detailIndex)) {
                detailErrors.set(detailIndex, []);
              }
              detailErrors.get(detailIndex)!.push(label);
            } else {
              // Header error
              const label = fieldLabels[pathStr] || pathStr;
              headerErrors.push(label);
            }
          });

          notification.error({
            message: '⚠️ Не удалось сохранить заказ',
            description: (
              <div style={{ fontSize: '14px' }}>
                {generalDetailErrors.length === 0 && (headerErrors.length > 0 || detailErrors.size > 0) && (
                  <p style={{ marginBottom: '12px', fontWeight: 'bold', color: '#ff4d4f' }}>
                    Пожалуйста, заполните обязательные поля:
                  </p>
                )}

                {generalDetailErrors.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px', color: '#ff4d4f' }}>⚠️ Ошибка в деталях:</div>
                    <ul style={{ margin: 0, paddingLeft: '20px' }}>
                      {generalDetailErrors.map((msg, idx) => (
                        <li key={idx} style={{ color: '#595959' }}>{msg}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {headerErrors.length > 0 && (
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px' }}>📋 Основная информация:</div>
                    <ul style={{ margin: 0, paddingLeft: '20px' }}>
                      {headerErrors.map((field, idx) => (
                        <li key={idx} style={{ color: '#595959' }}>{field}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {detailErrors.size > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: '4px' }}>📦 Детали заказа:</div>
                    {Array.from(detailErrors.entries()).map(([detailIdx, fields]) => (
                      <div key={detailIdx} style={{ marginBottom: '8px' }}>
                        <div style={{ color: '#fa8c16', fontWeight: 500 }}>
                          Позиция #{detailIdx + 1}:
                        </div>
                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                          {fields.map((field, idx) => (
                            <li key={idx} style={{ color: '#595959' }}>{field}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
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

        // Clean up unfilled details from the store
        const currentDetails = useOrderFormStore.getState().details;
        const unfilledDetails = currentDetails.filter(detail => {
          if (detail.detail_id) return false;
          const hasNoHeight = !detail.height || detail.height === 0;
          const hasNoWidth = !detail.width || detail.width === 0;
          const hasNoArea = !detail.area || detail.area === 0;
          return hasNoHeight && hasNoWidth && hasNoArea;
        });
        if (unfilledDetails.length > 0) {
          console.log(`[OrderForm] handleSave - removing ${unfilledDetails.length} unfilled detail(s) from store`);
          unfilledDetails.forEach(detail => {
            const tempId = detail.temp_id || detail.detail_id;
            if (tempId) {
              deleteDetail(tempId, detail.detail_id);
            }
          });
        }

        console.log('[OrderForm] handleSave - onSaveSuccess callback exists?', !!onSaveSuccess);
        if (onSaveSuccess) {
          console.log('[OrderForm] handleSave - calling onSaveSuccess with orderId:', savedOrderId);
          onSaveSuccess(savedOrderId);
          console.log('[OrderForm] handleSave - onSaveSuccess called successfully');
        } else {
          console.warn('[OrderForm] handleSave - WARNING: onSaveSuccess callback is not defined!');
        }

        // Auto-export to Google Drive
        try {
          console.log('[OrderForm] handleSave - starting auto-export to Google Drive');
          await exportToDrive({
            order_id: savedOrderId,
            order_name: formValues.header.order_name,
            order_date: formValues.header.order_date,
            client: formValues.header.client,
          });
          console.log('[OrderForm] handleSave - auto-export completed successfully');
        } catch (exportError) {
          // Error already handled in useOrderExport hook (shows message.error)
          console.error('[OrderForm] handleSave - auto-export failed:', exportError);
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

  const headerTabItems = useMemo(
    () => [
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
        key: 'details',
        label: 'Детали заказа',
        children: <OrderDetailsTab ref={detailsTabRef} />,
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
            <OrderPaymentsTab />
          </Space>
        ),
      },
      {
        key: 'services',
        label: 'Услуги/работы',
        children: <div>TODO: Services Tab</div>,
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
        label: 'Материалы',
        children: <OrderMaterialsTab />,
        disabled: mode === 'create' && !header.order_id,
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
    ],
    [mode, header.order_id]
  );

  const enabledTabKeys = useMemo(
    () => headerTabItems.filter((item) => !item.disabled).map((item) => item.key as string),
    [headerTabItems]
  );

  useEffect(() => {
    if (!enabledTabKeys.includes(activeTab) && enabledTabKeys.length > 0) {
      setActiveTab(enabledTabKeys[0]);
    }
  }, [enabledTabKeys, activeTab]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() !== 'tab') return;
      event.preventDefault();

      if (enabledTabKeys.length === 0) {
        return;
      }

      const direction = event.shiftKey ? -1 : 1;
      const currentIndex = enabledTabKeys.indexOf(activeTab);
      const startIndex = currentIndex === -1 ? 0 : currentIndex;
      const nextIndex =
        (startIndex + direction + enabledTabKeys.length) % enabledTabKeys.length;

      setActiveTab(enabledTabKeys[nextIndex]);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabledTabKeys, activeTab]);

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
          {mode === 'edit' && orderId && (
            <Button
              icon={<EyeOutlined />}
              onClick={() => show('orders_view', orderId)}
              style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
            >
              Просмотр
            </Button>
          )}
          <Button
            type={(isDirty || isDetailEditing) ? "primary" : "default"}
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={isSaving}
            disabled={!isDirty && !isDetailEditing}
            style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
          >
            Сохранить
          </Button>
          <Button
            icon={<CloseOutlined />}
            onClick={handleCancel}
            style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
          >
            Закрыть
          </Button>
        </Space>
      }
    >
      {/* Read-only header with order summary (only in edit mode) */}
      {mode === 'edit' && <OrderHeaderSummary />}

      {/* Editable tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key)}
        items={headerTabItems}
        type="card"
      />
    </Card>
  );
};

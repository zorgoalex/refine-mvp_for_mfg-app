// Main Order Form Component
// Master-Detail form with Tabs for child entities

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card, Tabs, Button, Space, Spin, notification, Modal } from 'antd';
import { SaveOutlined, CloseOutlined, EyeOutlined } from '@ant-design/icons';
import { useOne, useList, useNavigation } from '@refinedev/core';
import {
  useOrderDraftStore,
  getOrderDraftStore,
  peekOrderDraftStore,
  OrderDraftStoreProvider,
  NEW_ORDER_KEY,
} from '../../../stores/orderFormStore';
import { useTabStore, computeNeighborPath } from '../../../stores/tabStore';
import { useTabDirty } from '../../../hooks/useTabDirty';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';
import { useDefaultStatuses } from '../../../hooks/useDefaultStatuses';
import { loadOrderViaBackend } from '../../../hooks/useOrderBackendRead';
import { useOrderSave } from '../../../hooks/useOrderSave';
import { useOrderExport } from '../../../hooks/useOrderExport';
import { OrderFormMode } from '../../../types/orders';
import { orderFormSchema } from '../../../schemas/orderSchema';
import { featureFlags } from '../../../config/featureFlags';
import { can } from '../../../utils/permissions';
import dayjs from 'dayjs';

// Sections
import { OrderHeaderSummary } from './sections/OrderHeaderSummary';
import { OrderBasicInfo } from './sections/OrderBasicInfo';
import { OrderNotesSection } from './sections/OrderNotesSection';
import { OrderDatesSection } from './sections/OrderDatesSection';
import { OrderFinanceSection } from './sections/OrderFinanceSection';
import { OrderMaterialsTab } from './sections/OrderMaterialsTab';
import { OrderLegacySection } from './sections/OrderLegacySection';
import { OrderFilesSection } from './sections/OrderFilesSection';
import { OrderAggregatesDisplay } from './sections/OrderAggregatesDisplay';
import { OrderLabelDataEditor } from './labels/OrderLabelDataEditor';

// Tabs
import { OrderDetailsTab, OrderDetailsTabRef } from './tabs/OrderDetailsTab';
import { OrderPaymentsTab, OrderPaymentsTabRef } from './tabs/OrderPaymentsTab';

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
  const location = useLocation();
  const navigate = useNavigate();
  const orderKey = mode === 'create' ? NEW_ORDER_KEY : String(orderId);
  const tabKey = location.pathname; // e.g. /orders/edit/11195 or /orders/create

  const {
    header,
    details,
    payments,
    setHeader,
    updateHeaderField,
    isDirty,
    isDetailEditing,
    isPaymentEditing,
    reset,
    loadOrder,
    getFormValues,
    setDirty,
    finalizeInitialization,
    isTotalAmountManual,
    deleteDetail,
  } = useOrderDraftStore(orderKey);

  // Refs for tabs to apply current edits before save
  const detailsTabRef = useRef<OrderDetailsTabRef>(null);
  const paymentsTabRef = useRef<OrderPaymentsTabRef>(null);

  const {
    defaultOrderStatus,
    defaultPaymentStatus,
    isLoading: statusesLoading,
    error: statusesError,
  } =
    useDefaultStatuses();
  const { saveOrder, isSaving } = useOrderSave(orderKey);

  // Bridge dirty state into the workspace tab registry (single dirty contract).
  useTabDirty(tabKey, isDirty);

  const setTabTitle = useTabStore((s) => s.setTabTitle);
  const closeTab = useTabStore((s) => s.closeTab);

  // Enrich the tab label once the order name is known.
  useEffect(() => {
    if (mode === 'edit' && orderId && header?.order_name) {
      setTabTitle(tabKey, `Заказ #${orderId} · ${header.order_name} · Редактирование`);
    }
  }, [mode, orderId, header?.order_name, tabKey, setTabTitle]);
  const { exportToDrive, isUploading } = useOrderExport();

  // Read sub-tab reactively from the URL (do NOT strip/replace it — the workspace
  // tab keeps its query so deep-links into an already-open tab still work).
  const activeTabFromUrl = new URLSearchParams(location.search).get('tab') || 'details';
  const [activeTab, setActiveTab] = useState(activeTabFromUrl);
  const [backendOrderLoading, setBackendOrderLoading] = useState(false);
  const useBackendOrderRead = featureFlags.useBackendOrdersRead;
  const labelsEnabled = featureFlags.labels && can('labels.view');

  // React to deep-link/sub-tab jumps into an already-open order tab.
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab');
    if (t && t !== activeTab) setActiveTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);


  // Load existing order data in edit mode
  // Use relationship to load doweling links via order_doweling_links (many-to-many)
  const shouldLoadOrder = mode === 'edit' && !!orderId && !useBackendOrderRead;
  const { data: orderData, isLoading: orderLoading } = useOne({
    resource: 'orders',
    id: orderId,
    queryOptions: {
      enabled: shouldLoadOrder,
    },
    meta: {
      fields: [
        'order_id',
        'order_name',
        'client_id',
        'order_date',
        'priority',
        'completion_date',
        'planned_completion_date',
        'issue_date',
        'order_status_id',
        'payment_status_id',
        'production_status_id',
        'production_status_from_details_enabled',
        'total_amount',
        'final_amount',
        'discount',
        'surcharge',
        'paid_amount',
        'payment_date',
        'parts_count',
        'total_area',
        'milling_type_id',
        'edge_type_id',
        'film_id',
        'material_id',
        // SP3: header sheet material + durable SP3-era eligibility marker
        'sheet_material_type_id',
        'sheet_eligible',
        'link_cutting_file',
        'link_cutting_image_file',
        'link_cad_file',
        'link_pdf_file',
        'notes',
        'manager_id',
        'delete_flag',
        'version',
        'ref_key_1c',
        'created_by',
        'edited_by',
        'created_at',
        'updated_at',
        {
          order_doweling_links: [
            'order_doweling_link_id',
            'order_id',
            'doweling_order_id',
            {
              doweling_order: [
                'doweling_order_id',
                'doweling_order_name',
                'design_engineer_id',
              ],
            },
          ],
        },
      ],
    },
  });

  // Load order details in edit mode (only if orderId is valid number)
  const canLoadOrderChildren = mode === 'edit' && typeof orderId === 'number' && orderId > 0;
  const shouldLoadDetails = canLoadOrderChildren && !useBackendOrderRead;

  const { data: detailsData, isLoading: detailsLoading } = useList({
    resource: 'order_details',
    filters: [{ field: 'order_id', operator: 'eq', value: orderId || 0 }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: shouldLoadDetails,
    },
  });

  // SP3: server-resolved per-detail material name (COALESCE sheet/material) from
  // order_details_view, merged into the store as material_name_resolved so the edit
  // workspace shows the sheet name in mixed read mode without a shadow materials row.
  const { data: detailNamesData, isLoading: detailNamesLoading } = useList({
    resource: 'order_details_view',
    filters: [{ field: 'order_id', operator: 'eq', value: orderId || 0 }],
    pagination: { pageSize: 1000 },
    meta: { fields: ['detail_id', 'material_name', 'sheet_material_type_id'] },
    queryOptions: {
      enabled: shouldLoadDetails && featureFlags.sheetMaterialsReads,
    },
  });

  // SP3: server-resolved header material name (COALESCE sheet/material) from orders_view.
  const { data: headerNameData, isLoading: headerNameLoading } = useOne({
    resource: 'orders_view',
    id: orderId,
    meta: { fields: ['order_id', 'material_name', 'sheet_material_type_id'] },
    queryOptions: {
      enabled: shouldLoadOrder && featureFlags.sheetMaterialsReads,
    },
  });

  // Load payments in edit mode (only if orderId is valid number)
  const shouldLoadPayments = canLoadOrderChildren && !useBackendOrderRead;

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
        production_status_from_details_enabled: true,
        priority: 100,
        discount: 0,
        surcharge: 0,
        paid_amount: 0,
        total_amount: 0,
        final_amount: 0,
      });
      setDirty(false); // Reset dirty flag after initial setup
    }
  }, [mode, defaultOrderStatus, defaultPaymentStatus]);

  useEffect(() => {
    if (!statusesError) return;
    notification.error({
      message: 'Ошибка загрузки справочников формы',
      description: statusesError.message,
      duration: 0,
    });
  }, [statusesError]);

  // Reset store and didInit when orderId changes (handles navigation between orders)
  const didInit = useRef(false);
  const prevOrderIdRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // If orderId changed, reset the store and allow re-initialization
    if (prevOrderIdRef.current !== orderId) {
      if (prevOrderIdRef.current !== undefined) {
        // Only reset if we had a previous order (not initial mount)
        reset();
      }
      didInit.current = false;
      prevOrderIdRef.current = orderId;
    }
  }, [orderId, reset]);

  useEffect(() => {
    if (!useBackendOrderRead || didInit.current || mode !== 'edit' || !orderId) {
      return;
    }

    // A restored dirty draft (sessionStorage rehydration) is authoritative —
    // do not clobber it via a backend reload.
    if (getOrderDraftStore(orderKey).getState().isDirty) {
      didInit.current = true;
      return;
    }

    let cancelled = false;
    setBackendOrderLoading(true);

    loadOrderViaBackend(orderId, {
      // peek (non-creating): a load resolving after discard must not resurrect the slice.
      getOrderStore: () => peekOrderDraftStore(orderKey)?.getState() ?? null,
    })
      .then((formValues) => {
        if (cancelled || !formValues) return;
        didInit.current = true;
        setTimeout(() => {
          if (!cancelled) {
            finalizeInitialization();
          }
        }, 200);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[OrderForm] Backend order load failed:', error);
        notification.error({
          message: 'Ошибка загрузки заказа',
          description: error instanceof Error ? error.message : 'Не удалось загрузить заказ',
        });
      })
      .finally(() => {
        if (!cancelled) {
          setBackendOrderLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [useBackendOrderRead, mode, orderId, finalizeInitialization]);

  // Load order data in edit mode (one-time per orderId)
  useEffect(() => {
    if (didInit.current) return;
    // A restored dirty draft is authoritative — do not clobber it via loadOrder().
    if (mode === 'edit' && getOrderDraftStore(orderKey).getState().isDirty) {
      didInit.current = true;
      return;
    }
    if (mode === 'edit' && orderData?.data) {
      // Wait for details and payments only if they should be loaded.
      // SP3 view loads (resolved names) gate on !loading only — never on data — so an
      // untracked/errored view (mixed mode before Hasura metadata) cannot deadlock the
      // edit form; the resolved name is best-effort and falls back to the materials map.
      const detailsReady = !shouldLoadDetails || (!detailsLoading && detailsData);
      const paymentsReady = !shouldLoadPayments || (!paymentsLoading && paymentsData);
      const detailNamesReady = !shouldLoadDetails || !detailNamesLoading;
      const headerNameReady = !shouldLoadOrder || !headerNameLoading;

      if (detailsReady && paymentsReady && detailNamesReady && headerNameReady) {
        // SP3: detail_id -> server-resolved COALESCE(sheet, material) name.
        const resolvedNameByDetailId = new Map<number, string | null>();
        (detailNamesData?.data || []).forEach((row: any) => {
          if (row?.detail_id != null) {
            resolvedNameByDetailId.set(row.detail_id, row.material_name ?? null);
          }
        });

        // Auto-calculate empty detail_cost before loading into store
        const processedDetails = (detailsData?.data || []).map((detail: any) => {
          const material_name_resolved = resolvedNameByDetailId.has(detail.detail_id)
            ? resolvedNameByDetailId.get(detail.detail_id)
            : undefined;
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
              material_name_resolved,
            };
          }
          return { ...detail, material_name_resolved };
        });

        // Extract doweling links from relationship (many-to-many via order_doweling_links)
        const dowelingLinks = orderData.data.order_doweling_links || [];
        const { order_doweling_links, ...orderDataWithoutRelationship } = orderData.data;

        // Для обратной совместимости: заполняем doweling_order_id/name из первой связи
        const firstLink = dowelingLinks[0];
        const headerWithDoweling = {
          ...orderDataWithoutRelationship,
          doweling_order_id: firstLink?.doweling_order?.doweling_order_id || null,
          doweling_order_name: firstLink?.doweling_order?.doweling_order_name || null,
          doweling_links: dowelingLinks,
          // SP3: server-resolved header material name (COALESCE sheet/material).
          material_name_resolved: (headerNameData?.data as any)?.material_name ?? undefined,
        };

        loadOrder({
          header: headerWithDoweling,
          details: processedDetails,
          payments: paymentsData?.data || [],
          workshops: [],
          requirements: [],
          dowelingLinks: dowelingLinks,
        });
        didInit.current = true;
        // После пересчётов проверяем реальные изменения и устанавливаем isDirty соответственно
        // Увеличена задержка для гарантии завершения всех useEffect пересчётов
        setTimeout(() => finalizeInitialization(), 200);
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
    shouldLoadOrder,
    detailNamesData,
    detailNamesLoading,
    headerNameData,
    headerNameLoading,
  ]);

  const isOrderDataLoading =
    backendOrderLoading ||
    (mode === 'edit' && !useBackendOrderRead && (orderLoading || detailsLoading));

  // Ensure legacy details always have a calculated sum
  useEffect(() => {
    if (!details || details.length === 0) {
      return;
    }

    const store = getOrderDraftStore(orderKey).getState();
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
    if (isOrderDataLoading) {
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
    isOrderDataLoading,
    updateHeaderField,
  ]);

  // Auto-recalculate final_amount when total_amount, discount or surcharge changes
  // This useEffect is in OrderForm (always mounted) to ensure recalculation
  // happens regardless of which tab is active
  useEffect(() => {
    if (isOrderDataLoading) {
      return;
    }

    const totalAmount = header.total_amount || 0;
    const discount = header.discount || 0;
    const surcharge = header.surcharge || 0;
    // discount/surcharge are absolute amounts, not percent
    // Only one can be active at a time (mutually exclusive)
    const expectedFinalAmount = surcharge > 0
      ? Number((totalAmount + surcharge).toFixed(2))
      : Math.max(0, Number((totalAmount - discount).toFixed(2)));

    // Only update if changed (avoid infinite loops)
    if (header.final_amount !== expectedFinalAmount) {
      updateHeaderField('final_amount', expectedFinalAmount);
    }
  }, [
    header.total_amount,
    header.discount,
    header.surcharge,
    header.final_amount,
    isOrderDataLoading,
    updateHeaderField,
  ]);

  // Auto-recalculate paid_amount from payments
  useEffect(() => {
    if (isOrderDataLoading) return;

    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const roundedPaid = Number(totalPaid.toFixed(2));

    if (header.paid_amount !== roundedPaid) {
      updateHeaderField('paid_amount', roundedPaid);
    }
  }, [payments, header.paid_amount, isOrderDataLoading, updateHeaderField]);

  // Auto-update payment_status_id based on paid_amount and final_amount
  // Only auto-update if current status is 1 (не оплачено), 2 (частично), or 3 (оплачено)
  // If user set a custom status (other than 1,2,3), don't auto-update
  useEffect(() => {
    if (isOrderDataLoading) return;

    // Skip auto-update if current status is not one of the standard payment statuses (1, 2, 3)
    const currentStatus = header.payment_status_id;
    if (currentStatus && currentStatus !== 1 && currentStatus !== 2 && currentStatus !== 3) {
      return;
    }

    const paidAmount = header.paid_amount || 0;
    const discountedAmount = header.final_amount || header.total_amount || 0;

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
    header.final_amount,
    header.total_amount,
    header.payment_status_id,
    isOrderDataLoading,
    updateHeaderField,
  ]);

  // Navigation
  const { show } = useNavigation();

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

    // Apply current edits from payments table before saving
    if (paymentsTabRef.current) {
      console.log('[OrderForm] handleSave - applying current edits from payments table...');
      const applied = await paymentsTabRef.current.applyCurrentEdits();
      if (!applied) {
        console.log('[OrderForm] handleSave - failed to apply payment edits, aborting save');
        notification.warning({
          message: 'Ошибка валидации',
          description: 'Заполните обязательные поля в редактируемом платеже',
        });
        return;
      }
      console.log('[OrderForm] handleSave - payment edits applied successfully');
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
            className: 'order-save-validation-notification',
            description: (
              <div style={{ fontSize: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <Button size="small" onClick={() => notification.destroy()}>
                    Закрыть все
                  </Button>
                </div>
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
        // Only touch the draft store if its slice still exists — if the tab was
        // closed/discarded while the save was in flight, these writes (bound store
        // actions persist to sessionStorage) would resurrect the discarded draft.
        if (peekOrderDraftStore(orderKey)) {
          // If this was a create, set header.order_id so tabs unlock and state reflects persisted record
          if (mode === 'create' && !header.order_id) {
            console.log('[OrderForm] handleSave - setting header.order_id to:', savedOrderId);
            setHeader({ order_id: savedOrderId });
          }

          console.log('[OrderForm] handleSave - setting dirty to false');
          setDirty(false);

          // Clean up unfilled details from the store
          const currentDetails = peekOrderDraftStore(orderKey)?.getState().details ?? [];
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

  const confirmDiscard = (onConfirm: () => void) => {
    Modal.confirm({
      title: 'Несохраненные изменения',
      content: 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?',
      okText: 'Покинуть',
      cancelText: 'Остаться',
      modalRender: (m) => React.createElement(DraggableModalWrapper, null, m),
      onOk: onConfirm,
    });
  };

  const headerTabItems = useMemo(
    () => [
      {
        key: 'basic',
        label: 'Основная информация',
        children: (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <OrderBasicInfo />
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
            <OrderPaymentsTab ref={paymentsTabRef} />
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
            {labelsEnabled && (
              <OrderLabelDataEditor orderId={header.order_id ?? orderId} isOrderDirty={isDirty} />
            )}
          </Space>
        ),
      },
    ],
    [mode, header.order_id, orderId, labelsEnabled, isDirty]
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
    if (isSaving) return; // disabled mid-save

    // Embedded (create modal): delegate to the parent's cancel handler.
    if (onCancel) {
      const exit = () => {
        reset();
        onCancel();
      };
      if (isDirty) confirmDiscard(exit);
      else exit();
      return;
    }

    // Tabbed route: close the workspace tab and navigate to a neighbour.
    const closeAndLeave = (discard: boolean) => {
      // Resolve the neighbour from the PRE-removal tab list — closeTab mutates it.
      const neighbor = computeNeighborPath(useTabStore.getState().tabs, tabKey);
      closeTab(tabKey, discard ? { discard: true } : undefined);
      navigate(neighbor);
    };
    if (isDirty) confirmDiscard(() => closeAndLeave(true));
    else closeAndLeave(false);
  };

  // Show loading only for essential data
  const isLoadingEssential =
    statusesLoading ||
    backendOrderLoading ||
    (shouldLoadOrder && orderLoading) ||
    (shouldLoadDetails && detailsLoading) ||
    (shouldLoadPayments && paymentsLoading);


  if (isLoadingEssential) {
    return (
      <OrderDraftStoreProvider orderKey={orderKey}>
        <Card>
          <div style={{ textAlign: 'center', padding: '50px' }}>
            <Spin size="large" />
            <div style={{ marginTop: '16px' }}>
              {backendOrderLoading || orderLoading ? 'Загрузка заказа...' : 'Загрузка формы...'}
            </div>
          </div>
        </Card>
      </OrderDraftStoreProvider>
    );
  }

  const orderName = header.order_name?.trim();
  const cardTitle =
    mode === 'create'
      ? `Создание заказа${orderName ? ` «${orderName}»` : ''}`
      : `Редактирование заказа${orderName ? ` «${orderName}»` : ''}`;

  return (
    <OrderDraftStoreProvider orderKey={orderKey}>
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
            type={(isDirty || isDetailEditing || isPaymentEditing) ? "primary" : "default"}
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={isSaving}
            disabled={!isDirty && !isDetailEditing && !isPaymentEditing}
            style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
          >
            Сохранить
          </Button>
          <Button
            icon={<CloseOutlined />}
            onClick={handleCancel}
            disabled={isSaving}
            style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
          >
            Закрыть
          </Button>
        </Space>
      }
    >
      {/* Read-only header with order summary (both create and edit modes) */}
      <OrderHeaderSummary />

      {/* Editable tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key)}
        items={headerTabItems}
        type="card"
      />
    </Card>
    </OrderDraftStoreProvider>
  );
};

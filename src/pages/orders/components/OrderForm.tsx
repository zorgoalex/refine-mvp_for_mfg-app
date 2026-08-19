import { Tooltip } from '../../../ui/tooltipDelay';
// Main Order Form Component
// Master-Detail form with Tabs for child entities

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Card, Tabs, Button, Empty, Space, Spin, notification, Modal, Form, Select, Tag, Popconfirm, message } from 'antd';
import { SaveOutlined, CloseOutlined, EyeOutlined, DeleteOutlined } from '@ant-design/icons';
import { useOne, useList, useNavigation } from '@refinedev/core';
import { toClientKey } from '../../../api/mappers/orderMapper';
import type { BazisOrderDraftResponse } from '../../../api/types/bazisApi.types';
import {
  useOrderDraftStore,
  getOrderDraftStore,
  peekOrderDraftStore,
  OrderDraftStoreProvider,
  NEW_ORDER_KEY,
} from '../../../stores/orderFormStore';
import { useTabStore, computeCloseTargetPath } from '../../../stores/tabStore';
import { useTabDirty } from '../../../hooks/useTabDirty';
import { DraggableModalWrapper } from '../../../components/DraggableModalWrapper';
import { useWorkspaceTabKey } from '../../../components/workspace/KeepAliveContext';
import { useDefaultStatuses } from '../../../hooks/useDefaultStatuses';
import { loadOrderViaBackend } from '../../../hooks/useOrderBackendRead';
import { useOrderSave } from '../../../hooks/useOrderSave';
import { OrderSaveValidationContext } from '../../../hooks/orderSaveValidation';
import { useOrderExport } from '../../../hooks/useOrderExport';
import { useIsMobile } from '../../../hooks/useDeviceTier';
import { projectsApi, type ProjectDto } from '../../../api/projectsApi';
import { OrderDetail, OrderFormMode } from '../../../types/orders';
import { orderFormSchema } from '../../../schemas/orderSchema';
import { featureFlags } from '../../../config/featureFlags';
import { can } from '../../../utils/permissions';
import { useOrderFinancialVisibility } from '../../../hooks/useOrderFinancialVisibility';
import { resolveOrderTabLabel } from '../../../utils/tabLabels';
import {
  buildNextOrderNameFromList, collectProvenanceNodes, draftToFormSeed } from '../../bazis/bazisOrderDraft';
import { ordersApi } from '../../../api/ordersApi';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type { DeadlineDefaultScheduleDto } from '../../../api/types/deadlineApi.types';
import {
  computePlannedCompletionDate,
  shouldApplyComputedPlannedCompletion,
} from '../../configuration/components/deadlineDefaultScheduleView';
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
import { OrderTelegramScreenshots } from './sections/OrderTelegramScreenshots';
import { OrderAggregatesDisplay } from './sections/OrderAggregatesDisplay';
import { OrderLabelDataEditor } from './labels/OrderLabelDataEditor';
import { makeOrderDeleteHandler } from '../orderDeleteAction';

// Tabs
import { OrderDetailsTab, OrderDetailsTabRef } from './tabs/OrderDetailsTab';
import { OrderHdfTab } from './tabs/OrderHdfTab';
import { OrderPaymentsTab, OrderPaymentsTabRef } from './tabs/OrderPaymentsTab';
import { CutPage } from '../../cut/CutPage';
import {
  clearAddPaymentIntent,
  readAddPaymentIntent,
} from '../orderPaymentIntent';
import { OperationalPageHeader, useOperationalUi } from '../../../ui-operational/OperationalPrimitives';
import {
  appendOrderDetailEmptyTailRowsForDisplay,
  businessOrderDetails,
  collectOrderDetailEmptyTailRowsForDisplay,
  MIN_ORDER_DETAIL_GRID_ROWS,
  orderDetailIdentityKey,
  prepareOrderDetailsForSave,
} from '../../../utils/orderDetailRows';

const INITIAL_ORDER_DETAIL_DEFAULTS: Omit<OrderDetail, 'temp_id'> = {
  detail_number: 0,
  height: 0,
  width: 0,
  quantity: 0,
  area: 0,
  material_id: null,
  milling_type_id: 1,
  edge_type_id: 1,
  priority: 100,
};

interface OrderFormProps {
  mode: OrderFormMode;
  orderId?: number;
  onSaveSuccess?: (orderId: number) => void;
  onCancel?: () => void;
}

interface BazisDraftRuntime {
  locationKey: string;
  meta: {
    revisionId: number;
    clientId: number | null;
  };
  idempotencyKey: string;
}

const ORDER_FORM_COMPACT_HEADER_STICKY_HEIGHT = 40;

type OrderFormStickyStyle = CSSProperties & {
  '--order-show-sticky-top': string;
  '--order-show-compact-header-height': string;
  '--order-show-tabs-shell-height': string;
  '--order-show-details-toolbar-height': string;
  '--order-show-table-header-top': string;
};

function useWorkspaceTabsHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    let ro: ResizeObserver | null = null;
    const attach = (): boolean => {
      const tabs = document.querySelector('.workspace-tabs');
      if (!tabs) return false;
      const measure = () => setHeight(tabs.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(tabs);
      }
      return true;
    };

    if (attach()) return () => ro?.disconnect();

    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);

  return height;
}

function createOrderSaveIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function computeOrderSaveSignature(values: unknown): string {
  return JSON.stringify(values);
}

export const OrderForm: React.FC<OrderFormProps> = (props) => {
  const { canViewFinancials, isLoading } = useOrderFinancialVisibility();
  if (isLoading) return <Spin />;
  if (!canViewFinancials) {
    return (
      <Alert
        type="info"
        showIcon
        message="Финансовый слой заказа недоступен"
        description="Создание и полное редактирование заказа отключены. Статусы заказа и деталей можно менять в карточке заказа и на рабочих досках."
      />
    );
  }

  return <OrderFormContent {...props} />;
};

const OrderFormContent: React.FC<OrderFormProps> = ({
  mode,
  orderId,
  onSaveSuccess,
  onCancel,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const isOperational = useOperationalUi();
  const isMobile = useIsMobile();
  const workspaceTabsHeight = useWorkspaceTabsHeight();
  const orderKey = mode === 'create' ? NEW_ORDER_KEY : String(orderId);
  const tabKey = useWorkspaceTabKey(location.pathname);
  const bazisDraft = readBazisDraftFromLocationState(location.state);

  const {
    header,
    details,
    payments,
    workshops,
    requirements,
    dowelingLinks,
    deletedDetails,
    deletedPayments,
    deletedWorkshops,
    deletedRequirements,
    deletedDowelingLinks,
    setHeader,
    updateHeaderField,
    isDirty,
    isDetailEditing,
    isPaymentEditing,
    reset,
    loadOrder,
    getFormValues,
    ensureMinimumDetailRows,
    updateDetail,
    setDirty,
    setInitializing,
    finalizeInitialization,
    isTotalAmountManual,
  } = useOrderDraftStore(orderKey);
  const businessDetails = useMemo(
    () => businessOrderDetails(details),
    [details],
  );

  // Seed create drafts before any tab or reference catalog mounts. Placeholder
  // rows are excluded from save and UI totals by the shared business filter.
  useEffect(() => {
    if (mode !== 'create' || details.length >= MIN_ORDER_DETAIL_GRID_ROWS) return;

    const wasDirty = getOrderDraftStore(orderKey).getState().isDirty;
    ensureMinimumDetailRows(MIN_ORDER_DETAIL_GRID_ROWS, INITIAL_ORDER_DETAIL_DEFAULTS);
    if (!wasDirty) setDirty(false);
  }, [details.length, ensureMinimumDetailRows, mode, orderKey, setDirty]);

  // Refs for tabs to apply current edits before save
  const detailsTabRef = useRef<OrderDetailsTabRef>(null);
  const paymentsTabRef = useRef<OrderPaymentsTabRef>(null);
  const orderFormDetailsBlockRef = useRef<HTMLDivElement>(null);
  const orderFormStickySentinelRef = useRef<HTMLDivElement>(null);
  const handledAddPaymentIntentRef = useRef<string | null>(null);
  const saveKeyRef = useRef<string | undefined>(undefined);
  const saveKeySignatureRef = useRef<string | undefined>(undefined);
  const bazisDraftRuntimeRef = useRef<BazisDraftRuntime | null>(null);
  const seededBazisDraftLocationKeyRef = useRef<string | null>(null);
  const createDefaultsSeededRef = useRef(false);
  const automaticPlannedCompletionRef = useRef<string | null>(null);
  const projectClientRef = useRef<number | undefined>(undefined);
  const projectRequestIdRef = useRef(0);
  const [projectOptions, setProjectOptions] = useState<Array<{ label: string; value: number }>>(
    [],
  );
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [orderFormStickyEnabled, setOrderFormStickyEnabled] = useState(false);
  const [orderFormSummaryStuck, setOrderFormSummaryStuck] = useState(false);
  const orderFormStickyStyle = useMemo<OrderFormStickyStyle>(() => ({
    '--order-show-sticky-top': `${workspaceTabsHeight}px`,
    '--order-show-compact-header-height': `${ORDER_FORM_COMPACT_HEADER_STICKY_HEIGHT}px`,
    '--order-show-tabs-shell-height': '0px',
    '--order-show-details-toolbar-height': '0px',
    '--order-show-table-header-top': '0px',
  }), [workspaceTabsHeight]);
  const orderFormPageClassName = useMemo(() => [
    'order-show-page',
    'order-form-sticky-page',
    isOperational ? 'order-show-page--operational' : '',
    orderFormStickyEnabled ? 'order-show-page--sticky-enabled' : '',
  ].filter(Boolean).join(' '), [isOperational, orderFormStickyEnabled]);

  const {
    defaultOrderStatus,
    defaultPaymentStatus,
    isLoading: statusesLoading,
    error: statusesError,
  } =
    useDefaultStatuses();
  const [deadlineDefaultSchedule, setDeadlineDefaultSchedule] = useState<{
    loaded: boolean;
    schedule: DeadlineDefaultScheduleDto | null;
  }>({
    loaded:
      mode !== 'create' ||
      !featureFlags.useBackendDeadlines ||
      !featureFlags.useBackendOrdersWrite,
    schedule: null,
  });
  const {
    saveOrder,
    isSaving,
    validation: saveValidation,
    showValidationErrors,
    clearValidation,
  } = useOrderSave(orderKey, {
    getBazisDraftSaveContext: () => {
      const runtime = bazisDraftRuntimeRef.current;
      if (!runtime) {
        return null;
      }

      return {
        revisionId: runtime.meta.revisionId,
        collectNodes: (values) =>
          collectProvenanceNodes(values.details ?? [], (row) => toClientKey(row.temp_id)),
        regenerateIdempotencyKey: () => {
          const nextKey = createOrderSaveIdempotencyKey();
          const current = bazisDraftRuntimeRef.current;
          bazisDraftRuntimeRef.current = current
            ? { ...current, idempotencyKey: nextKey }
            : null;
          return nextKey;
        },
      };
    },
  });
  const normalizedClientId =
    typeof header.client_id === 'number' && Number.isFinite(header.client_id)
      ? header.client_id
      : Number(header.client_id) > 0
        ? Number(header.client_id)
        : undefined;
  const currentSaveSignature = useMemo(
    () =>
      computeOrderSaveSignature({
        header,
        details,
        payments,
        workshops,
        requirements,
        dowelingLinks,
        deletedDetails,
        deletedPayments,
        deletedWorkshops,
        deletedRequirements,
        deletedDowelingLinks,
      }),
    [
      header,
      details,
      payments,
      workshops,
      requirements,
      dowelingLinks,
      deletedDetails,
      deletedPayments,
      deletedWorkshops,
      deletedRequirements,
      deletedDowelingLinks,
    ],
  );
  const applicableProductionStatusIds = useMemo(
    () => [
      ...new Set(
        workshops
          .map((workshop) => Number(workshop.production_status_id))
          .filter(
            (productionStatusId) =>
              Number.isInteger(productionStatusId) && productionStatusId > 0,
          ),
      ),
    ],
    [workshops],
  );
  const bazisDraftClientLocked = mode === 'create' && (bazisDraft?.clientId ?? null) != null;
  const bazisDraftProjectLocked = mode === 'create' && bazisDraft != null;

  // Bridge dirty state into the workspace tab registry (single dirty contract).
  useTabDirty(tabKey, isDirty);

  const setTabTitle = useTabStore((s) => s.setTabTitle);
  const closeTab = useTabStore((s) => s.closeTab);

  // The workspace tab shows only the user-facing order name, never its database id.
  useEffect(() => {
    if (mode === 'edit' && header?.order_name) {
      setTabTitle(tabKey, resolveOrderTabLabel(header.order_name));
    }
  }, [mode, header?.order_name, tabKey, setTabTitle]);
  const { exportToDrive, isUploading } = useOrderExport();

  // Read sub-tab reactively from the URL (do NOT strip/replace it — the workspace
  // tab keeps its query so deep-links into an already-open tab still work).
  const activeTabFromUrl = new URLSearchParams(location.search).get('tab') || 'details';
  const [activeTab, setActiveTab] = useState(activeTabFromUrl);
  const [backendOrderLoading, setBackendOrderLoading] = useState(false);
  const useBackendOrderRead = featureFlags.useBackendOrdersRead;
  const labelsEnabled = featureFlags.labels && can('labels.view');
  const cutTabEnabled = featureFlags.useBackendCut && can('cut.view');
  const canManageOrderTrash = !featureFlags.useBackendPermissions || can('orders.delete');

  useEffect(() => {
    if (saveValidation?.invalidDetailKeys.length) {
      setActiveTab('details');
    }
  }, [saveValidation]);

  useEffect(() => {
    if (
      saveKeyRef.current &&
      saveKeySignatureRef.current &&
      currentSaveSignature !== saveKeySignatureRef.current
    ) {
      saveKeyRef.current = undefined;
      saveKeySignatureRef.current = undefined;
    }
  }, [currentSaveSignature]);

  useEffect(() => {
    if (!featureFlags.projects || mode !== 'create') {
      return;
    }

    if (!normalizedClientId) {
      projectClientRef.current = undefined;
      setProjectOptions([]);
      if (header.project_id !== undefined && header.project_id !== null) {
        updateHeaderField('project_id', undefined as never);
      }
      return;
    }

    if (
      projectClientRef.current !== undefined &&
      projectClientRef.current !== normalizedClientId &&
      header.project_id !== undefined &&
      header.project_id !== null
    ) {
      updateHeaderField('project_id', undefined as never);
    }

    projectClientRef.current = normalizedClientId;
  }, [mode, normalizedClientId, header.project_id, updateHeaderField]);

  const loadProjectOptions = useCallback(async (search = '') => {
    if (!featureFlags.projects || !normalizedClientId) {
      setProjectOptions([]);
      return;
    }

    const requestId = ++projectRequestIdRef.current;
    setProjectsLoading(true);

    try {
      const response = await projectsApi.list({
        clientId: normalizedClientId,
        search: search.trim() || undefined,
      });
      if (requestId !== projectRequestIdRef.current) {
        return;
      }
      setProjectOptions(
        response.map((project: ProjectDto) => ({
          value: project.projectId,
          label: `${project.code} — ${project.name}`,
        })),
      );
    } catch (error) {
      if (requestId === projectRequestIdRef.current) {
        notification.error({
          message: 'Не удалось загрузить проекты',
          description:
            error instanceof Error ? error.message : 'Проверьте подключение и повторите попытку',
        });
      }
    } finally {
      if (requestId === projectRequestIdRef.current) {
        setProjectsLoading(false);
      }
    }
  }, [normalizedClientId]);

  useEffect(() => {
    if (!featureFlags.projects || mode !== 'create' || !normalizedClientId) {
      return;
    }

    void loadProjectOptions();
  }, [mode, normalizedClientId, loadProjectOptions]);

  // React to deep-link/sub-tab jumps into an already-open order tab.
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab');
    if (t && t !== activeTab) setActiveTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    const intentId = readAddPaymentIntent(location.search);
    const isLoadedOrder =
      mode === 'edit' &&
      typeof orderId === 'number' &&
      Number(header.order_id) === orderId;

    if (
      !intentId ||
      handledAddPaymentIntentRef.current === intentId ||
      activeTab !== 'finance' ||
      !isLoadedOrder ||
      !paymentsTabRef.current
    ) {
      return;
    }

    handledAddPaymentIntentRef.current = intentId;
    void paymentsTabRef.current.addInlinePayment();
    navigate(
      {
        pathname: location.pathname,
        search: clearAddPaymentIntent(location.search),
      },
      {
        replace: true,
        state: location.state,
      },
    );
  }, [
    activeTab,
    header.order_id,
    location.pathname,
    location.search,
    location.state,
    mode,
    navigate,
    orderId,
  ]);


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
        ...(featureFlags.projects ? ['project_id'] : []),
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
    meta: {
      fields: [
        'order_id',
        'material_name',
        'sheet_material_type_id',
        ...(featureFlags.projects ? ['project_id', 'project_code', 'order_full_number'] : []),
      ],
    },
    queryOptions: {
      enabled: shouldLoadOrder && (featureFlags.sheetMaterialsReads || featureFlags.projects),
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
    let cancelled = false;
    if (
      mode !== 'create' ||
      !featureFlags.useBackendDeadlines ||
      !featureFlags.useBackendOrdersWrite
    ) {
      setDeadlineDefaultSchedule({ loaded: true, schedule: null });
      return () => {
        cancelled = true;
      };
    }

    setDeadlineDefaultSchedule((current) => ({ ...current, loaded: false }));
    void deadlinesApi
      .getDefaultSchedule()
      .then((response) => {
        if (!cancelled) {
          setDeadlineDefaultSchedule({ loaded: true, schedule: response.schedule });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeadlineDefaultSchedule({ loaded: true, schedule: null });
          notification.warning({
            message: 'Срок по умолчанию не применён',
            description: 'Плановую дату можно указать вручную. Сервер повторит проверку при сохранении.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    if (mode === 'create' && !bazisDraft) {
      bazisDraftRuntimeRef.current = null;
      seededBazisDraftLocationKeyRef.current = null;
    }
  }, [bazisDraft, mode]);

  useEffect(() => {
    if (
      mode === 'create' &&
      defaultOrderStatus &&
      defaultPaymentStatus &&
      !createDefaultsSeededRef.current
    ) {
      const store = getOrderDraftStore(orderKey).getState();
      const wasDirty = store.isDirty;
      const today = dayjs();
      const orderDate =
        typeof store.header.order_date === 'string' &&
        store.header.order_date.trim().length > 0
          ? store.header.order_date
          : today.format('YYYY-MM-DD');
      const currentPlannedCompletion =
        typeof store.header.planned_completion_date === 'string' &&
        store.header.planned_completion_date.trim().length > 0
          ? store.header.planned_completion_date
          : null;
      const plannedCompletion = computePlannedCompletionDate(
        orderDate,
        deadlineDefaultSchedule.schedule,
        applicableProductionStatusIds,
      );
      automaticPlannedCompletionRef.current =
        currentPlannedCompletion === null ? plannedCompletion : null;
      setHeader({
        order_date: orderDate,
        planned_completion_date: currentPlannedCompletion ?? plannedCompletion,
        order_status_id: store.header.order_status_id ?? defaultOrderStatus,
        payment_status_id: store.header.payment_status_id ?? defaultPaymentStatus,
        production_status_from_details_enabled:
          store.header.production_status_from_details_enabled ?? true,
        priority: store.header.priority ?? 100,
        discount: store.header.discount ?? 0,
        surcharge: store.header.surcharge ?? 0,
        paid_amount: store.header.paid_amount ?? 0,
        total_amount: store.header.total_amount ?? 0,
        final_amount: store.header.final_amount ?? 0,
      });
      createDefaultsSeededRef.current = true;
      if (!wasDirty) {
        setDirty(false);
      }
    }
  }, [
    mode,
    defaultOrderStatus,
    defaultPaymentStatus,
    deadlineDefaultSchedule.schedule,
    applicableProductionStatusIds,
    orderKey,
    setDirty,
    setHeader,
  ]);

  useEffect(() => {
    if (
      mode !== 'create' ||
      !bazisDraft ||
      !defaultOrderStatus ||
      !defaultPaymentStatus ||
      seededBazisDraftLocationKeyRef.current === location.key
    ) {
      return;
    }

    const today = dayjs();
    const seed = draftToFormSeed(bazisDraft);
    const orderDate = today.format('YYYY-MM-DD');
    const plannedCompletion = computePlannedCompletionDate(
      orderDate,
      deadlineDefaultSchedule.schedule,
      [],
    );
    automaticPlannedCompletionRef.current = plannedCompletion;
    const seededHeader: Record<string, unknown> = {
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
      project_id: seed.header.projectId,
      client_name: bazisDraft.clientName ?? null,
    };

    if (seed.header.clientId != null) {
      seededHeader.client_id = seed.header.clientId;
    }

    reset();
    loadOrder({
      header: seededHeader as any,
      details: seed.details,
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
      deletedDetails: [],
      deletedPayments: [],
      deletedWorkshops: [],
      deletedRequirements: [],
      deletedDowelingLinks: [],
      isDirty: false,
      version: 0,
    });
    setInitializing(false);
    // Драфт из Базис-панелей = несохранённые данные by definition: кнопка
    // «Сохранить» требует dirty, юзер должен мочь сохранить без правок.
    setDirty(true);
    bazisDraftRuntimeRef.current = {
      locationKey: location.key,
      meta: seed.meta,
      idempotencyKey: createOrderSaveIdempotencyKey(),
    };
    seededBazisDraftLocationKeyRef.current = location.key;

    // Подсказка номера заказа: асинхронно после seed, только если поле пусто
    // (ручной ввод юзера не затираем). Финальная уникальность — серверный гейт.
    void (async () => {
      try {
        const response = await ordersApi.list({
          page: 1,
          pageSize: 20,
          sortBy: 'orderDate',
          sortOrder: 'desc',
        });
        const next = buildNextOrderNameFromList(response.data.map((item) => item.orderName));
        if (!next) {
          return;
        }
        const store = getOrderDraftStore(orderKey).getState();
        if (!store.header.order_name) {
          store.updateHeaderField('order_name', next);
        }
      } catch {
        // Non-blocking hint only.
      }
    })();
  }, [
    bazisDraft,
    deadlineDefaultSchedule.schedule,
    defaultOrderStatus,
    defaultPaymentStatus,
    loadOrder,
    location.key,
    mode,
    reset,
    setDirty,
    setInitializing,
  ]);

  useEffect(() => {
    if (
      mode !== 'create' ||
      !deadlineDefaultSchedule.loaded ||
      !header.order_date
    ) {
      return;
    }

    const nextAutomaticDate = computePlannedCompletionDate(
      String(header.order_date),
      deadlineDefaultSchedule.schedule,
      applicableProductionStatusIds,
    );
    const previousAutomaticDate = automaticPlannedCompletionRef.current;
    const currentDate =
      typeof header.planned_completion_date === 'string' &&
      header.planned_completion_date.trim().length > 0
        ? header.planned_completion_date
        : null;
    if (!nextAutomaticDate) {
      if (
        previousAutomaticDate !== null &&
        currentDate === previousAutomaticDate
      ) {
        automaticPlannedCompletionRef.current = null;
        updateHeaderField('planned_completion_date', null);
      }
      return;
    }

    if (
      !shouldApplyComputedPlannedCompletion(
        header.planned_completion_date,
        previousAutomaticDate,
      )
    ) {
      return;
    }
    automaticPlannedCompletionRef.current = nextAutomaticDate;
    if (currentDate !== nextAutomaticDate) {
      updateHeaderField('planned_completion_date', nextAutomaticDate);
    }
  }, [
    deadlineDefaultSchedule.loaded,
    deadlineDefaultSchedule.schedule,
    applicableProductionStatusIds,
    header.order_date,
    header.planned_completion_date,
    mode,
    updateHeaderField,
  ]);

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
          project_id:
            orderDataWithoutRelationship.project_id ??
            (headerNameData?.data as any)?.project_id ??
            null,
          project_code: (headerNameData?.data as any)?.project_code ?? null,
          order_full_number: (headerNameData?.data as any)?.order_full_number ?? null,
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

    businessDetails.forEach((detail) => {
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
  }, [businessDetails, orderKey]);

  // Auto-recalculate total_amount from details (unless overridden manually)
  useEffect(() => {
    if (isOrderDataLoading) {
      return;
    }

    if (!businessDetails || businessDetails.length === 0) {
      if (header.total_amount === undefined || header.total_amount === null) {
        return;
      }
    }

    if (isTotalAmountManual) {
      return;
    }

    const autoTotalRaw = businessDetails.reduce((sum, detail) => {
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
    businessDetails,
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
    clearValidation();

    // Apply current edits from detail table before saving
    if (detailsTabRef.current) {
      console.log('[OrderForm] handleSave - applying current edits from detail table...');
      const applied = await detailsTabRef.current.applyCurrentEdits();
      if (!applied) {
        console.log('[OrderForm] handleSave - failed to apply current edits, aborting save');
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

      const emptyTailRowsForDisplay = collectOrderDetailEmptyTailRowsForDisplay(formValues.details ?? []);
      const businessFormDetails = businessOrderDetails(formValues.details ?? []);
      const preparedDetails = prepareOrderDetailsForSave(businessFormDetails);
      if (preparedDetails.emptyTailCount > 0) {
        businessFormDetails.forEach((detail, index) => {
          if (!preparedDetails.emptyTailKeys.has(orderDetailIdentityKey(detail, index))) return;
          const rowKey = detail.temp_id ?? detail.detail_id;
          if (rowKey != null) {
            updateDetail(rowKey, preparedDetails.detailsForDisplay[index]);
          }
        });
        console.log(`[OrderForm] handleSave - cleared ${preparedDetails.emptyTailCount} empty tail detail row(s)`);
      }
      // UI placeholders never cross validation or persistence boundaries.
      formValues.details = preparedDetails.detailsForSave;

      // Normalize detail_numbers: sort by current number and renumber sequentially 1, 2, 3...
      // This fixes any duplicates or gaps in numbering before validation
      const sortedDetails = [...(formValues.details || [])].sort((a, b) =>
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
        showValidationErrors(result.error.issues, formValues.details);
        return;
      }

      const saveSignature = computeOrderSaveSignature(formValues);
      if (bazisDraftRuntimeRef.current) {
        formValues.idempotencyKey = bazisDraftRuntimeRef.current.idempotencyKey;
      } else {
        if (!saveKeyRef.current) {
          saveKeyRef.current = createOrderSaveIdempotencyKey();
        }
        saveKeySignatureRef.current = saveSignature;
        formValues.idempotencyKey = saveKeyRef.current;
      }

        console.log('[OrderForm] handleSave - calling saveOrder...');
        const savedOrderId = await saveOrder(formValues, mode === 'edit');
        console.log('[OrderForm] handleSave - saveOrder returned:', savedOrderId);

      if (savedOrderId) {
        saveKeyRef.current = undefined;
        saveKeySignatureRef.current = undefined;
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

          if (emptyTailRowsForDisplay.length > 0) {
            const savedFormValues = getFormValues();
            loadOrder({
              ...savedFormValues,
              header: {
                ...savedFormValues.header,
                order_id: savedOrderId,
              },
              details: appendOrderDetailEmptyTailRowsForDisplay(
                savedFormValues.details ?? [],
                emptyTailRowsForDisplay,
                savedOrderId,
              ),
            });
            setInitializing(false);
          }

          console.log('[OrderForm] handleSave - setting dirty to false');
          setDirty(false);

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
    () => {
      const projectCode = header.project_code?.trim() || null;
      const projectLink =
        header.project_id && projectCode ? `/projects/show/${header.project_id}` : null;
      const projectField =
        !featureFlags.projects ? null : mode === 'create' ? (
          <Form.Item
            label={(
              <Space size={4}>
                <span>Проект</span>
                <Tooltip title="Пусто — проект создастся автоматически (МП-N)">
                  <span style={{ cursor: 'help', color: 'var(--app-text-muted)' }}>?</span>
                </Tooltip>
              </Space>
            )}
            name={['header', 'project_id']}
            extra={bazisDraftProjectLocked ? 'Проект Базис-проекта' : undefined}
          >
            <Select
              allowClear={!bazisDraftProjectLocked}
              showSearch
              filterOption={false}
              disabled={!normalizedClientId || bazisDraftProjectLocked}
              loading={projectsLoading}
              placeholder="Новый проект (авто)"
              value={header.project_id ?? undefined}
              onChange={(value) => updateHeaderField('project_id', value ?? undefined)}
              onSearch={(value) => {
                void loadProjectOptions(value);
              }}
              onFocus={() => {
                void loadProjectOptions();
              }}
              options={projectOptions}
              notFoundContent={
                normalizedClientId
                  ? projectsLoading
                    ? 'Загрузка проектов...'
                    : 'Проекты не найдены'
                  : 'Сначала выберите клиента'
              }
            />
          </Form.Item>
        ) : projectCode ? (
          <Form.Item label="Проект">
            {projectLink ? <Link to={projectLink}>{projectCode}</Link> : <span>{projectCode}</span>}
          </Form.Item>
        ) : null;

      const items = [
      {
        key: 'basic',
        label: isOperational ? 'Обзор' : 'Основная информация',
        children: (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <OrderBasicInfo
              clientLocked={bazisDraftClientLocked}
              projectField={projectField}
            />
            <OrderNotesSection />
          </Space>
        ),
      },
      {
        key: 'details',
        label: isOperational ? 'Состав' : 'Детали заказа',
        children: (
          <div ref={orderFormDetailsBlockRef} className="order-form-details-section">
            <OrderSaveValidationContext.Provider value={saveValidation}>
              <OrderDetailsTab ref={detailsTabRef} isSaving={isSaving} />
            </OrderSaveValidationContext.Provider>
          </div>
        ),
      },
      {
        key: 'hdf',
        label: 'ХДФ',
        children: <OrderHdfTab />,
      },
      {
        key: 'dates',
        label: isOperational ? 'Логистика' : 'Даты',
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
      ...(cutTabEnabled
        ? [
            {
              key: 'cut',
              label: 'Раскрой',
              children: header.order_id ? <CutPage embeddedOrderId={header.order_id} /> : null,
              disabled: mode === 'create' && !header.order_id,
            },
          ]
        : []),
      {
        key: 'services',
        label: isOperational ? 'Активность' : 'Услуги/работы',
        children: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isOperational ? 'События заказа отсутствуют' : 'Услуги и работы не добавлены'} />,
        disabled: mode === 'create' && !header.order_id,
      },
      {
        key: 'workshops',
        label: isOperational ? 'Производство' : 'Цеха',
        children: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isOperational ? 'Производственные операции не добавлены' : 'Цеха не назначены'} />,
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
        label: isOperational ? 'Бирки' : 'Дополнительно',
        children: isOperational ? (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <OrderTelegramScreenshots orderId={header.order_id ?? orderId} />
            {labelsEnabled ? (
              <OrderLabelDataEditor orderId={header.order_id ?? orderId} isOrderDirty={isDirty} />
            ) : (
              <span>Бирки недоступны</span>
            )}
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <OrderLegacySection />
            <OrderFilesSection />
            {labelsEnabled && (
              <OrderLabelDataEditor orderId={header.order_id ?? orderId} isOrderDirty={isDirty} />
            )}
          </Space>
        ),
      },
      ];

      if (!isOperational) return items;

      const operationalOrder = [
        'basic',
        'details',
        'requirements',
        'cut',
        'workshops',
        'finance',
        'dates',
        'additional',
        'services',
      ];
      return operationalOrder
        .map((key) => items.find((item) => item.key === key))
        .filter((item): item is (typeof items)[number] => Boolean(item));
    },
    [
      mode,
      header.order_id,
      header.project_code,
      header.project_id,
      orderId,
      labelsEnabled,
      isDirty,
      cutTabEnabled,
      bazisDraftClientLocked,
      bazisDraftProjectLocked,
      isOperational,
      isSaving,
      saveValidation,
      normalizedClientId,
      projectsLoading,
      projectOptions,
      loadProjectOptions,
      updateHeaderField,
    ]
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

  useEffect(() => {
    const update = () => {
      const block = orderFormDetailsBlockRef.current;
      const availableHeight = window.innerHeight - workspaceTabsHeight;
      const next =
        !isMobile &&
        activeTab === 'details' &&
        details.length > 0 &&
        !!block &&
        block.scrollHeight > Math.max(320, availableHeight);
      setOrderFormStickyEnabled((prev) => (prev === next ? prev : next));
    };

    update();
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (orderFormDetailsBlockRef.current) ro?.observe(orderFormDetailsBlockRef.current);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [activeTab, details.length, isMobile, workspaceTabsHeight]);

  useEffect(() => {
    const update = () => {
      const node = orderFormStickySentinelRef.current;
      const next =
        orderFormStickyEnabled &&
        !!node &&
        node.getBoundingClientRect().top <= workspaceTabsHeight;
      setOrderFormSummaryStuck((prev) => (prev === next ? prev : next));
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [orderFormStickyEnabled, workspaceTabsHeight]);

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

    // Tabbed route: close the workspace tab and navigate to its opener or neighbour.
    const closeAndLeave = (discard: boolean) => {
      // Resolve from the PRE-removal tab list — closeTab mutates it.
      const closeTargetPath = computeCloseTargetPath(useTabStore.getState().tabs, tabKey);
      closeTab(tabKey, discard ? { discard: true } : undefined);
      navigate(closeTargetPath);
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

  if (isOperational) {
    return (
      <OrderDraftStoreProvider orderKey={orderKey}>
        <div className="order-form-operational">
          <OperationalPageHeader
            breadcrumbs={(
              <Space split={<span>›</span>} size={6}>
                <Link to="/orders">Заказы</Link>
                <span>{header.order_name || orderId || 'Новый'}</span>
                <span>Редактирование</span>
                {activeTab === 'additional' ? <span>Бирки</span> : null}
              </Space>
            )}
            title={`${mode === 'create' ? 'Создание' : 'Редактирование'} заказа ${header.order_name || orderId || ''}${activeTab === 'additional' ? ' · Бирки' : ''}`}
            description={activeTab === 'additional'
              ? 'Настройка шаблона и данных бирок с мгновенным предпросмотром результата.'
              : 'Редактирование состава, параметров и производственных данных заказа.'}
            actions={(
              <>
                <Tag color="orange">Режим редактирования</Tag>
                {mode === 'edit' && orderId ? (
                  <Button icon={<EyeOutlined />} onClick={() => show('orders_view', orderId)}>
                    Просмотр
                  </Button>
                ) : null}
                {featureFlags.useBackendOrdersWrite && canManageOrderTrash && mode === 'edit' && orderId && !header.delete_flag ? (
                  <Popconfirm
                    title={`Удалить заказ №${header.order_name}?`}
                    description="Заказ попадёт в корзину, его можно будет восстановить."
                    okText="Удалить"
                    okButtonProps={{ danger: true }}
                    cancelText="Отмена"
                    onConfirm={makeOrderDeleteHandler({
                      deleteFn: () => ordersApi.delete(Number(orderId), {
                        version: Number(header.version ?? 0),
                      }),
                      onSuccess: () => {
                        message.success('Заказ перемещён в корзину');
                        navigate('/orders');
                      },
                      onVersionConflict: () => window.location.reload(),
                      onError: (errorMessage) => message.error(errorMessage),
                    })}
                  >
                    <Button danger icon={<DeleteOutlined />}>Удалить</Button>
                  </Popconfirm>
                ) : null}
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleSave}
                  loading={isSaving}
                  disabled={!isDirty && !isDetailEditing && !isPaymentEditing}
                >
                  Сохранить
                </Button>
              </>
            )}
          />
          <div className="order-form-operational__workspace">
            <div className={orderFormPageClassName} style={orderFormStickyStyle}>
              <div ref={orderFormStickySentinelRef} className="order-show-sticky-sentinel" aria-hidden />
              <div
                className={`order-show-summary-tabs-sticky${orderFormSummaryStuck ? ' order-show-summary-tabs-sticky--stuck' : ''}`}
              >
                <OrderHeaderSummary compactSticky={orderFormStickyEnabled && orderFormSummaryStuck} />
              </div>
              <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key)}
                items={headerTabItems}
                type="card"
              />
            </div>
          </div>
        </div>
      </OrderDraftStoreProvider>
    );
  }

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
          {featureFlags.useBackendOrdersWrite && canManageOrderTrash && mode === 'edit' && orderId && !header.delete_flag ? (
            <Popconfirm
              title={`Удалить заказ №${header.order_name}?`}
              description="Заказ попадёт в корзину, его можно будет восстановить."
              okText="Удалить"
              okButtonProps={{ danger: true }}
              cancelText="Отмена"
              onConfirm={makeOrderDeleteHandler({
                deleteFn: () => ordersApi.delete(Number(orderId), {
                  version: Number(header.version ?? 0),
                }),
                onSuccess: () => {
                  message.success('Заказ перемещён в корзину');
                  navigate('/orders');
                },
                onVersionConflict: () =>
                  Modal.error({
                    title: 'Конфликт версий',
                    content: 'Заказ был изменен другим пользователем. Обновите страницу и повторите.',
                    okText: 'Обновить страницу',
                    onOk: () => window.location.reload(),
                  }),
                onError: (m) => message.error(m),
              })}
            >
              <Tooltip title="Удалить заказ">
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  disabled={isSaving}
                  style={{ height: '27px', fontSize: '13px', padding: '0 8px' }}
                />
              </Tooltip>
            </Popconfirm>
          ) : null}
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
      <div className={orderFormPageClassName} style={orderFormStickyStyle}>
        <div ref={orderFormStickySentinelRef} className="order-show-sticky-sentinel" aria-hidden />
        <div
          className={`order-show-summary-tabs-sticky${orderFormSummaryStuck ? ' order-show-summary-tabs-sticky--stuck' : ''}`}
        >
          <OrderHeaderSummary compactSticky={orderFormStickyEnabled && orderFormSummaryStuck} />
        </div>

        {/* Editable tabs */}
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key)}
          items={headerTabItems}
          type="card"
        />
      </div>
    </Card>
    </OrderDraftStoreProvider>
  );
};

function readBazisDraftFromLocationState(state: unknown): BazisOrderDraftResponse | null {
  if (!state || typeof state !== 'object' || !('bazisDraft' in state)) {
    return null;
  }

  const draft = (state as { bazisDraft?: BazisOrderDraftResponse }).bazisDraft;
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.details)) {
    return null;
  }

  return draft;
}

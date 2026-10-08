import { PopconfirmContent } from "../../../components/PopconfirmContent";
import { Tooltip } from '../../../ui/tooltipDelay';
// Main Order Form Component
// Master-Detail form with Tabs for child entities

import React, { CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Card, Tabs, Button, Empty, Space, notification, Modal, Form, Select, Tag, Popconfirm, message } from 'antd';
import { SaveOutlined, CloseOutlined, EyeOutlined, DeleteOutlined, RightOutlined } from '@ant-design/icons';
import { useNavigation, useParsed } from '@refinedev/core';
import { toClientKey } from '../../../api/mappers/orderMapper';
import { orderSaveRetryKey } from '../../../utils/orderSaveRetryKey';
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
import {
  useKeepAlive,
  useWorkspaceTabKey,
} from '../../../components/workspace/KeepAliveContext';
import { useDefaultStatuses } from '../../../hooks/useDefaultStatuses';
import { loadOrderViaBackend } from '../../../hooks/useOrderBackendRead';
import { useOrderSave } from '../../../hooks/useOrderSave';
import { OrderSaveValidationContext } from '../../../hooks/orderSaveValidation';
import { useOrderExport } from '../../../hooks/useOrderExport';
import { useIsMobile } from '../../../hooks/useDeviceTier';
import { projectsApi, type ProjectDto } from '../../../api/projectsApi';
import { OrderDetail, OrderFormMode, type Order, type OrderDowelingLink, type Payment } from '../../../types/orders';
import { orderFormSchema } from '../../../schemas/orderSchema';
import { featureFlags } from '../../../config/featureFlags';
import { OrderCatalogLinesTable } from './OrderCatalogLinesTable';
import { orderCatalogSubtotal } from '../../../utils/orderCatalogLines';
import { can } from '../../../utils/permissions';
import { ClientScreenOrderHeader } from '../../clientScreen/ClientScreenOrderHeader';
import { authSession } from '../../../api/authSession';
import { useOrderFinancialVisibility } from '../../../hooks/useOrderFinancialVisibility';
import { resolveOrderTabLabel } from '../../../utils/tabLabels';
import { resolveStickySummaryStuck } from '../utils/stickySummaryStuck';
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
import { useAuthCacheNamespace } from '../../../query/authCacheNamespace';
import { createOrderEditLegacyPrimaryIdentity } from '../../../query/orderEditPrimaryResource';
import { additionalRouteParams } from '../../../query/orderListPrimaryResource';
import { getOrdersReadBackendMode } from '../../../query/orderPrimaryResource';
import { ORDER_PRIMARY_HARD_STALE_TIME_MS } from '../../../query/orderPrimaryFetchPolicy';
import {
  useOrderLifecycleCohort,
} from '../../../performance/orderLifecycleCohortStore';
import {
  OrderLifecycleReadSurface,
  useCancelInactiveOrderQueriesOnDeactivate,
  useList,
  useOne,
  useOrderAsyncReadGuard,
  useOrderLifecycleReadActive,
} from '../../../query/orderLifecycleQueries';
import { useWorkspaceCheckpointAdapter } from '../../../workspace/workspaceCheckpointReact';
import { readWorkspaceCheckpointAdapterState } from '../../../workspace/workspaceCheckpointRegistry';
import {
  restoreWorkspaceDomCheckpoint,
} from '../../../workspace/workspaceDomCheckpoint';
import { useWorkspaceDomCheckpointCapture } from '../../../workspace/workspaceDomCheckpointReact';
import type { WorkspaceSerializableRecord } from '../../../workspace/workspaceUiStateStore';
import {
  acquireWorkspaceOperationPin,
  isWorkspaceOperationOwnershipLost,
  runPageOwnedWorkspaceOperation,
} from '../../../workspace/workspaceOperationPins';

// Sections
import { OrderHeaderSummary } from './sections/OrderHeaderSummary';
import { OrderBasicInfo } from './sections/OrderBasicInfo';
import { OrderNotesSection } from './sections/OrderNotesSection';
import { OrderDatesSection } from './sections/OrderDatesSection';
import { OrderFinanceSection } from './sections/OrderFinanceSection';
import { OrderFinanceSummary } from './sections/OrderFinanceSummary';
import { OrderFormWorkbenchBar } from './sections/OrderFormWorkbenchBar';
import { OrderMaterialsTab } from './sections/OrderMaterialsTab';
import { OrderLegacySection } from './sections/OrderLegacySection';
import { OrderFilesSection } from './sections/OrderFilesSection';
import { OrderTelegramScreenshots } from './sections/OrderTelegramScreenshots';
import { OrderAggregatesDisplay } from './sections/OrderAggregatesDisplay';
import { OrderLabelDataEditor } from './labels/OrderLabelDataEditor';
import { makeOrderDeleteHandler } from '../orderDeleteAction';
import { canDeleteOrderForUser } from '../orderDeleteVisibility';
import { isAuthoritativeDirtyOrderDraft } from '../orderDraftAuthority';
import {
  OrderFormProgressiveSurface,
  OrderInitialSkeleton,
} from './OrderProgressiveLoading';

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
import { useOptionalUiVariant } from '../../../ui-variant/UiVariantProvider';
import { useWorkspaceChromeBottom } from '../useWorkspaceChromeBottom';
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

interface LoadedFormOrder extends Order {
  order_doweling_links?: OrderDowelingLink[] | null;
}

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
// «NewLine» hybrid form: these tabs become always-open sections of one page, the rest are folds.
const WORKBENCH_FORM_BAR_HEIGHT = 52;
const HYBRID_MAIN_SECTION_KEYS: readonly string[] = ['basic', 'dates', 'details', 'services', 'finance'];
const HYBRID_MAIN_SECTION_ORDER: readonly string[] = ['basic', 'details', 'services', 'finance'];

type OrderFormStickyStyle = CSSProperties & {
  '--wb-order-sticky-top': string;
  '--wb-order-bar-height': string;
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
  useCancelInactiveOrderQueriesOnDeactivate();
  const { canViewFinancials, isLoading } = useOrderFinancialVisibility();
  if (isLoading) {
    return <OrderInitialSkeleton variant="form" label="Проверяем доступ к форме заказа" />;
  }
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
  const ordinaryReadActive = useOrderLifecycleReadActive();
  const location = useLocation();
  const navigate = useNavigate();
  const isOperational = useOperationalUi();
  // «NewLine»: own page head, compact bar while scrolling and underline tabs; the form itself is the same.
  const uiVariant = useOptionalUiVariant()?.variant;
  const isWorkbench = !isOperational && uiVariant === 'workbench';
  const workbenchChromeBottom = useWorkspaceChromeBottom();
  const [workbenchHeadHidden, setWorkbenchHeadHidden] = useState(false);
  // the section anchors stay under the compact bar while the form scrolls
  const [workbenchAnchorsStuck, setWorkbenchAnchorsStuck] = useState(false);
  const workbenchAnchorsRef = useRef<HTMLElement>(null);
  const [workbenchSpySection, setWorkbenchSpySection] = useState<string | null>(null);
  // the anchor the user clicked stays current until they scroll the form themselves
  // (a short last section cannot reach the top of the screen)
  const [workbenchPinnedSection, setWorkbenchPinnedSection] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const workspaceTabsHeight = useWorkspaceTabsHeight();
  const orderKey = mode === 'create' ? NEW_ORDER_KEY : String(orderId);
  const tabKey = useWorkspaceTabKey(location.pathname);
  const orderWorkspaceKey = tabKey
    || (orderKey === NEW_ORDER_KEY ? '/orders/create' : `/orders/edit/${orderKey}`);
  const restoredOrderFormCheckpoint = useMemo(
    () => readWorkspaceCheckpointAdapterState(tabKey, 'order-form'),
    [tabKey],
  );
  const captureOrderFormDomCheckpoint = useWorkspaceDomCheckpointCapture(
    tabKey,
    asWorkspaceRecord(restoredOrderFormCheckpoint?.dom),
  );
  const bazisDraft = readBazisDraftFromLocationState(location.state);

  const {
    header,
    details,
    catalogLines,
    deletedCatalogLineIds,
    setCatalogLines,
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
  const orderFormSummaryTabsRef = useRef<HTMLDivElement>(null);
  const orderFormSummaryStuckRef = useRef(false);
  const orderFormExpandedSummaryHeightRef = useRef(0);
  const handledAddPaymentIntentRef = useRef<string | null>(null);
  const saveKeyRef = useRef<string | undefined>(undefined);
  const saveKeySignatureRef = useRef<string | undefined>(undefined);
  const bazisDraftRuntimeRef = useRef<BazisDraftRuntime | null>(null);
  const seededBazisDraftLocationKeyRef = useRef<string | null>(null);
  const createDefaultsSeededRef = useRef(false);
  const orderNameSuggestionRequestedRef = useRef(false);
  const automaticPlannedCompletionRef = useRef<string | null>(null);
  const projectClientRef = useRef<number | undefined>(undefined);
  const projectRequestIdRef = useRef(0);
  const workspaceOwnerMountedRef = useRef(true);
  const [projectOptionsState, setProjectOptionsState] = useState<{
    scopeKey: string;
    value: Array<{ label: string; value: number }>;
    loading: boolean;
  } | null>(null);
  const [orderFormStickyEnabled, setOrderFormStickyEnabled] = useState(false);
  const [orderFormSummaryStuck, setOrderFormSummaryStuck] = useState(false);
  useEffect(() => {
    workspaceOwnerMountedRef.current = true;
    return () => {
      workspaceOwnerMountedRef.current = false;
    };
  }, []);
  const orderFormStickyStyle = useMemo<OrderFormStickyStyle>(() => ({
    '--wb-order-sticky-top': `${workbenchChromeBottom}px`,
    '--wb-order-bar-height': `${WORKBENCH_FORM_BAR_HEIGHT}px`,
    '--order-show-sticky-top': `${workspaceTabsHeight}px`,
    '--order-show-compact-header-height': `${ORDER_FORM_COMPACT_HEADER_STICKY_HEIGHT}px`,
    '--order-show-tabs-shell-height': '0px',
    '--order-show-details-toolbar-height': '0px',
    '--order-show-table-header-top': '0px',
  }), [workbenchChromeBottom, workspaceTabsHeight]);
  const orderFormPageClassName = useMemo(() => [
    'order-show-page',
    'order-form-sticky-page',
    isOperational ? 'order-show-page--operational' : '',
    orderFormStickyEnabled ? 'order-show-page--sticky-enabled' : '',
    isWorkbench ? 'order-form-page--workbench' : '',
  ].filter(Boolean).join(' '), [isOperational, isWorkbench, orderFormStickyEnabled]);

  const {
    defaultOrderStatus,
    defaultPaymentStatus,
    isLoading: statusesLoading,
    error: statusesError,
    retry: retryStatuses,
  } =
    useDefaultStatuses();
  const [deadlineDefaultScheduleState, setDeadlineDefaultScheduleState] = useState<{
    scopeKey: string;
    value: {
      loaded: boolean;
      schedule: DeadlineDefaultScheduleDto | null;
    };
  } | null>(null);
  const {
    saveOrder,
    isSaving,
    validation: saveValidation,
    showValidationErrors,
    clearValidation,
  } = useOrderSave(orderKey, {
    workspaceKey: orderWorkspaceKey,
    isWorkspaceOwnerCurrent: () => workspaceOwnerMountedRef.current,
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
        catalogLines,
        deletedCatalogLineIds,
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
      catalogLines,
      deletedCatalogLineIds,
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
  const bazisDraftClientLocked =
    mode === 'create' && (bazisDraft?.clientId ?? null) != null;
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
  const [activeTab, setActiveTab] = useState(() => (
    typeof restoredOrderFormCheckpoint?.activeTab === 'string'
      ? restoredOrderFormCheckpoint.activeTab
      : activeTabFromUrl
  ));
  // «NewLine» hybrid layout: the main sections live on one page and are always active;
  // the rare ones are folds that start reading only when opened.
  const [hybridOpenSections, setHybridOpenSections] = useState<string[]>([]);
  const hybridSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const hybridInitialTabRef = useRef(true);
  const isFormSectionActive = (key: string) => (
    isWorkbench
      ? HYBRID_MAIN_SECTION_KEYS.includes(key) || hybridOpenSections.includes(key)
      : activeTab === key
  );
  const hybridSpacerRef = useRef<HTMLDivElement>(null);
  const [hybridSpacerHeight, setHybridSpacerHeight] = useState(0);
  const hybridSpacerHeightRef = useRef(0);
  const setHybridSpacer = useCallback((height: number) => {
    hybridSpacerHeightRef.current = height;
    setHybridSpacerHeight(height);
  }, []);
  const hybridScrollTimersRef = useRef<number[]>([]);
  const scrollToFormSection = useCallback((key: string) => {
    hybridScrollTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    hybridScrollTimersRef.current = [];
    const bringToTop = (settle: boolean) => {
      const node = hybridSectionRefs.current[key];
      if (!node) return;
      const stickyBottom = Number.parseFloat(window.getComputedStyle(node).scrollMarginTop) || 0;
      // a section that loads its content after opening changes height: once it has settled,
      // nothing is done if it already stands under the sticky rows
      if (settle && Math.abs(node.getBoundingClientRect().top - stickyBottom) <= 2) return;
      const spacer = hybridSpacerRef.current;
      if (spacer) {
        // the last sections are shorter than the screen: without extra room below, the page ends
        // before the section reaches the sticky rows and the previous block stays in view
        const spacerTop = spacer.getBoundingClientRect().top;
        const belowSpacer = document.documentElement.scrollHeight
          - (window.scrollY + spacerTop + hybridSpacerHeightRef.current);
        const contentBelow = spacerTop - node.getBoundingClientRect().top + Math.max(0, belowSpacer);
        const height = Math.max(0, Math.ceil(window.innerHeight - stickyBottom - contentBelow));
        // the room must exist before the scroll starts, so it is applied to the node right away
        spacer.style.height = `${height}px`;
        setHybridSpacer(height);
      }
      window.requestAnimationFrame(() => node.scrollIntoView({ block: 'start', behavior: settle ? 'auto' : 'smooth' }));
    };
    // two frames: a section opened by this click is in the document before it is measured
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => bringToTop(false)));
    hybridScrollTimersRef.current = [700, 1800].map((delay) => window.setTimeout(() => bringToTop(true), delay));
  }, [setHybridSpacer]);
  const goToFormSection = useCallback((key: string) => {
    if (!HYBRID_MAIN_SECTION_KEYS.includes(key)) {
      setHybridOpenSections((current) => (current.includes(key) ? current : [...current, key]));
    }
    setActiveTab(key);
    setWorkbenchPinnedSection(key);
    scrollToFormSection(key);
  }, [scrollToFormSection]);
  // every existing jump (`?tab=finance`, save validation → details, Ctrl+Tab) lands on its section
  useEffect(() => {
    if (!isWorkbench) return;
    if (!HYBRID_MAIN_SECTION_KEYS.includes(activeTab)) {
      setHybridOpenSections((current) => (current.includes(activeTab) ? current : [...current, activeTab]));
    }
    const initial = hybridInitialTabRef.current;
    hybridInitialTabRef.current = false;
    // the form opens at its top; only an explicit `?tab=` deep link scrolls on open
    if (initial && !new URLSearchParams(window.location.search).get('tab')) return;
    scrollToFormSection(activeTab);
  }, [activeTab, isWorkbench, scrollToFormSection]);
  useWorkspaceCheckpointAdapter(tabKey, 'order-form', {
    capture: () => ({
      activeTab,
      dirty: getOrderDraftStore(orderKey).getState().isDirty,
      draftVersion: getOrderDraftStore(orderKey).getState().version,
      dom: captureOrderFormDomCheckpoint(),
    }),
  });
  useLayoutEffect(() => restoreWorkspaceDomCheckpoint(
    tabKey,
    asWorkspaceRecord(restoredOrderFormCheckpoint?.dom),
  ), [restoredOrderFormCheckpoint, tabKey]);
  const useBackendOrderRead = featureFlags.useBackendOrdersRead;
  const ordersReadBackendMode = getOrdersReadBackendMode(useBackendOrderRead);
  const authCacheNamespace = useAuthCacheNamespace(ordersReadBackendMode);
  const backendOrderLoadGuard = useOrderAsyncReadGuard(
    `order-form-backend-load:${orderId ?? 'new'}`,
  );
  const backendOrderLoadScopeKey = `${backendOrderLoadGuard.authNamespace}|order:${orderId ?? 'new'}`;
  const projectOptionsResourceScope = `order-form-project-options:${mode}:${normalizedClientId ?? 'missing'}`;
  const projectOptionsReadGuard = useOrderAsyncReadGuard(projectOptionsResourceScope);
  const projectOptionsScopeKey = `${projectOptionsReadGuard.authNamespace}|${projectOptionsResourceScope}`;
  const projectOptions = projectOptionsState?.scopeKey === projectOptionsScopeKey
    ? projectOptionsState.value
    : [];
  const projectsLoading = projectOptionsState?.scopeKey === projectOptionsScopeKey
    && projectOptionsState.loading;
  const bazisNameHintGuard = useOrderAsyncReadGuard(
    `order-form-bazis-name-hint:${mode}:${orderKey}:${location.key}`,
  );
  const deadlineDefaultsResourceScope = `order-form-deadline-defaults:${mode}:${orderKey}`;
  const deadlineDefaultsGuard = useOrderAsyncReadGuard(deadlineDefaultsResourceScope);
  const deadlineDefaultsScopeKey = `${deadlineDefaultsGuard.authNamespace}|${deadlineDefaultsResourceScope}`;
  const deadlineDefaultSchedule = deadlineDefaultScheduleState?.scopeKey === deadlineDefaultsScopeKey
    ? deadlineDefaultScheduleState.value
    : {
        loaded:
          mode !== 'create'
          || !featureFlags.useBackendDeadlines
          || !featureFlags.useBackendOrdersWrite,
        schedule: null,
      };
  const [backendOrderLoadingState, setBackendOrderLoadingState] = useState<{
    scopeKey: string;
    value: boolean;
  } | null>(null);
  const backendOrderLoading = backendOrderLoadingState?.scopeKey === backendOrderLoadScopeKey
    && backendOrderLoadingState.value;
  const orderLifecycleCohort = useOrderLifecycleCohort();
  const { params: parsedRouteParams } = useParsed();
  const orderEditLegacyPrimaryIdentity = useMemo(
    () => createOrderEditLegacyPrimaryIdentity({
      orderId: orderId ?? '',
      projectsEnabled: featureFlags.projects,
      authCacheNamespace,
      additionalParams: additionalRouteParams(parsedRouteParams ?? {}),
    }),
    [authCacheNamespace, orderId, parsedRouteParams],
  );
  const labelsEnabled = featureFlags.labels && can('labels.view');
  const cutTabEnabled = featureFlags.useBackendCut && can('cut.view');
  const canDeleteCurrentOrder = !featureFlags.useBackendPermissions
    || canDeleteOrderForUser(authSession.getUser(), header);

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
      setProjectOptionsState({ scopeKey: projectOptionsScopeKey, value: [], loading: false });
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
  }, [header.project_id, mode, normalizedClientId, projectOptionsScopeKey, updateHeaderField]);

  const loadProjectOptions = useCallback(async (search = '') => {
    if (!featureFlags.projects || !normalizedClientId) {
      setProjectOptionsState({ scopeKey: projectOptionsScopeKey, value: [], loading: false });
      return;
    }
    if (!ordinaryReadActive) return;

    const token = projectOptionsReadGuard.capture();
    if (!token) return;
    const scopeKey = projectOptionsScopeKey;
    const clientId = normalizedClientId;
    const requestId = ++projectRequestIdRef.current;
    setProjectOptionsState((current) => ({
      scopeKey,
      value: current?.scopeKey === scopeKey ? current.value : [],
      loading: true,
    }));

    try {
      const response = await projectsApi.list({
        clientId,
        search: search.trim() || undefined,
      });
      if (
        requestId !== projectRequestIdRef.current
        || !projectOptionsReadGuard.isCurrent(token)
      ) {
        return;
      }
      setProjectOptionsState({
        scopeKey,
        value: response.map((project: ProjectDto) => ({
          value: project.projectId,
          label: `${project.code} — ${project.name}`,
        })),
        loading: false,
      });
    } catch (error) {
      if (
        requestId === projectRequestIdRef.current
        && projectOptionsReadGuard.isCurrent(token)
      ) {
        notification.error({
          message: 'Не удалось загрузить проекты',
          description:
            error instanceof Error ? error.message : 'Проверьте подключение и повторите попытку',
        });
      }
    } finally {
      if (
        requestId === projectRequestIdRef.current
        && projectOptionsReadGuard.isCurrent(token)
      ) {
        setProjectOptionsState((current) => current?.scopeKey === scopeKey
          ? { ...current, loading: false }
          : current);
      }
    }
  }, [
    normalizedClientId,
    ordinaryReadActive,
    projectOptionsReadGuard.capture,
    projectOptionsReadGuard.isCurrent,
    projectOptionsScopeKey,
  ]);

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
  const { data: orderData, isLoading: orderLoading, isFetching: orderFetching } = useOne<LoadedFormOrder>({
    resource: orderEditLegacyPrimaryIdentity.resource,
    id: orderEditLegacyPrimaryIdentity.orderId,
    queryOptions: {
      enabled: shouldLoadOrder,
      staleTime: orderLifecycleCohort === 'treatment'
        ? ORDER_PRIMARY_HARD_STALE_TIME_MS
        : undefined,
    },
    meta: orderEditLegacyPrimaryIdentity.meta,
  });

  // Load order details in edit mode (only if orderId is valid number)
  const canLoadOrderChildren = mode === 'edit' && typeof orderId === 'number' && orderId > 0;
  const shouldLoadDetails = canLoadOrderChildren && !useBackendOrderRead;

  const { data: detailsData, isLoading: detailsLoading, isFetching: detailsFetching } = useList({
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
  const { data: detailNamesData, isLoading: detailNamesLoading, isFetching: detailNamesFetching } = useList({
    resource: 'order_details_view',
    filters: [{ field: 'order_id', operator: 'eq', value: orderId || 0 }],
    pagination: { pageSize: 1000 },
    meta: { fields: ['detail_id', 'material_name', 'sheet_material_type_id'] },
    queryOptions: {
      enabled: shouldLoadDetails && featureFlags.sheetMaterialsReads,
    },
  });

  // SP3: server-resolved header material name (COALESCE sheet/material) from orders_view.
  const { data: headerNameData, isLoading: headerNameLoading, isFetching: headerNameFetching } = useOne({
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

  const { data: paymentsData, isLoading: paymentsLoading, isFetching: paymentsFetching } = useList<Payment>({
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
      setDeadlineDefaultScheduleState({
        scopeKey: deadlineDefaultsScopeKey,
        value: { loaded: true, schedule: null },
      });
      return () => {
        cancelled = true;
      };
    }
    if (!ordinaryReadActive) {
      return () => {
        cancelled = true;
      };
    }
    const token = deadlineDefaultsGuard.capture();
    if (!token) {
      return () => {
        cancelled = true;
      };
    }

    setDeadlineDefaultScheduleState((current) => ({
      scopeKey: deadlineDefaultsScopeKey,
      value: {
        loaded: false,
        schedule: current?.scopeKey === deadlineDefaultsScopeKey
          ? current.value.schedule
          : null,
      },
    }));
    void deadlinesApi
      .getDefaultSchedule()
      .then((response) => {
        if (!cancelled && deadlineDefaultsGuard.isCurrent(token)) {
          setDeadlineDefaultScheduleState({
            scopeKey: deadlineDefaultsScopeKey,
            value: { loaded: true, schedule: response.schedule },
          });
        }
      })
      .catch(() => {
        if (!cancelled && deadlineDefaultsGuard.isCurrent(token)) {
          setDeadlineDefaultScheduleState({
            scopeKey: deadlineDefaultsScopeKey,
            value: { loaded: true, schedule: null },
          });
          notification.warning({
            message: 'Срок по умолчанию не применён',
            description: 'Плановую дату можно указать вручную. Сервер повторит проверку при сохранении.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    deadlineDefaultsGuard.capture,
    deadlineDefaultsGuard.isCurrent,
    deadlineDefaultsScopeKey,
    mode,
    ordinaryReadActive,
  ]);

  useEffect(() => {
    if (mode === 'create' && !bazisDraft) {
      bazisDraftRuntimeRef.current = null;
      seededBazisDraftLocationKeyRef.current = null;
    }
  }, [bazisDraft, mode]);

  useEffect(() => {
    if (mode !== 'create' || bazisDraft || orderNameSuggestionRequestedRef.current) {
      return;
    }

    orderNameSuggestionRequestedRef.current = true;
    void ordersApi
      .getNextOrderName()
      .then(({ suggestedOrderName }) => {
        const store = getOrderDraftStore(orderKey).getState();
        if (!store.header.order_name?.trim()) {
          store.updateHeaderField('order_name', suggestedOrderName);
        }
      })
      .catch(() => {
        // Suggestion is non-blocking; server still enforces uniqueness on save.
      });
  }, [bazisDraft, mode, orderKey]);

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
      !ordinaryReadActive ||
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
    const nameHintToken = bazisNameHintGuard.capture();
    if (!nameHintToken) return;
    void (async () => {
      try {
        const response = await ordersApi.list({
          page: 1,
          pageSize: 20,
          sortBy: 'orderDate',
          sortOrder: 'desc',
        });
        const next = buildNextOrderNameFromList(response.data.map((item) => item.orderName));
        if (!next || !bazisNameHintGuard.isCurrent(nameHintToken)) {
          return;
        }
        const store = getOrderDraftStore(orderKey).getState();
        if (!store.header.order_name && bazisNameHintGuard.isCurrent(nameHintToken)) {
          store.updateHeaderField('order_name', next);
        }
      } catch {
        // Non-blocking hint only.
      }
    })();
  }, [
    bazisDraft,
    bazisNameHintGuard.capture,
    bazisNameHintGuard.isCurrent,
    deadlineDefaultSchedule.schedule,
    defaultOrderStatus,
    defaultPaymentStatus,
    loadOrder,
    location.key,
    mode,
    ordinaryReadActive,
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

  // Reset store and didInit when orderId changes (handles navigation between orders)
  const didInit = useRef(false);
  const backendOrderLoadAttemptedRef = useRef(false);
  const prevOrderIdRef = useRef<number | undefined>(undefined);
  const prevAuthNamespaceRef = useRef(authCacheNamespace);

  useLayoutEffect(() => {
    if (prevAuthNamespaceRef.current === authCacheNamespace) return;
    // Actor/permission-scope changes must never preserve another auth owner's draft.
    reset();
    didInit.current = false;
    backendOrderLoadAttemptedRef.current = false;
    prevAuthNamespaceRef.current = authCacheNamespace;
  }, [authCacheNamespace, reset]);

  useEffect(() => {
    // If orderId changed, reset the store and allow re-initialization
    if (prevOrderIdRef.current !== orderId) {
      if (prevOrderIdRef.current !== undefined) {
        // Only reset if we had a previous order (not initial mount)
        reset();
      }
      didInit.current = false;
      backendOrderLoadAttemptedRef.current = false;
      prevOrderIdRef.current = orderId;
    }
  }, [orderId, reset]);

  useEffect(() => {
    if (
      !ordinaryReadActive
      || !useBackendOrderRead
      || didInit.current
      || mode !== 'edit'
      || !orderId
    ) {
      return;
    }

    // A restored dirty draft (sessionStorage rehydration) is authoritative —
    // do not clobber it via a backend reload.
    if (
      !backendOrderLoadAttemptedRef.current
      && isAuthoritativeDirtyOrderDraft(getOrderDraftStore(orderKey).getState(), orderId)
    ) {
      didInit.current = true;
      return;
    }

    const loadToken = backendOrderLoadGuard.capture();
    if (!loadToken) return;
    backendOrderLoadAttemptedRef.current = true;
    let cancelled = false;
    setBackendOrderLoadingState({ scopeKey: backendOrderLoadScopeKey, value: true });

    loadOrderViaBackend(orderId, {
      // peek (non-creating): a load resolving after discard must not resurrect the slice.
      getOrderStore: () => peekOrderDraftStore(orderKey)?.getState() ?? null,
      canPublish: () => backendOrderLoadGuard.isCurrent(loadToken),
      })
      .then((formValues) => {
        if (cancelled || !backendOrderLoadGuard.isCurrent(loadToken) || !formValues) return;
        didInit.current = true;
        setTimeout(() => {
          if (!cancelled && backendOrderLoadGuard.isCurrent(loadToken)) {
            finalizeInitialization();
          }
        }, 200);
      })
      .catch((error) => {
        if (cancelled || !backendOrderLoadGuard.isCurrent(loadToken)) return;
        console.error('[OrderForm] Backend order load failed:', error);
        notification.error({
          message: 'Ошибка загрузки заказа',
          description: error instanceof Error ? error.message : 'Не удалось загрузить заказ',
        });
      })
      .finally(() => {
        if (!cancelled && backendOrderLoadGuard.isCurrent(loadToken)) {
          setBackendOrderLoadingState({ scopeKey: backendOrderLoadScopeKey, value: false });
        }
      });

    return () => {
      cancelled = true;
      setBackendOrderLoadingState((current) => current?.scopeKey === backendOrderLoadScopeKey
        ? { ...current, value: false }
        : current);
    };
  }, [
    backendOrderLoadGuard.active,
    backendOrderLoadGuard.capture,
    backendOrderLoadGuard.isCurrent,
    backendOrderLoadScopeKey,
    finalizeInitialization,
    mode,
    orderId,
    orderKey,
    ordinaryReadActive,
    useBackendOrderRead,
  ]);

  // Load order data in edit mode (one-time per orderId)
  useEffect(() => {
    if (useBackendOrderRead || didInit.current) return;
    // A restored dirty draft is authoritative — do not clobber it via loadOrder().
    if (
      mode === 'edit'
      && orderId
      && isAuthoritativeDirtyOrderDraft(getOrderDraftStore(orderKey).getState(), orderId)
    ) {
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
    useBackendOrderRead,
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

    const autoTotal = Number((autoTotalRaw + orderCatalogSubtotal(catalogLines)).toFixed(2));
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
    catalogLines,
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
  const handleSave = async (): Promise<boolean> => {
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
        return false;
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
        return false;
      }
      console.log('[OrderForm] handleSave - payment edits applied successfully');
    }

    const workspaceKey = orderWorkspaceKey;
    const releaseOperationPin = acquireWorkspaceOperationPin(workspaceKey, 'order-save');
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
        if (result.error.issues.some(issue => issue.path[0] === 'catalogLines')) setActiveTab('services');
        showValidationErrors(result.error.issues, formValues.details);
        return false;
      }

      const saveSignature = computeOrderSaveSignature(formValues);
      if (bazisDraftRuntimeRef.current) {
        formValues.idempotencyKey = bazisDraftRuntimeRef.current.idempotencyKey;
      } else {
        saveKeyRef.current = orderSaveRetryKey(saveKeyRef.current, saveKeySignatureRef.current,
          saveSignature, createOrderSaveIdempotencyKey);
        saveKeySignatureRef.current = saveSignature;
        formValues.idempotencyKey = saveKeyRef.current;
      }

      console.log('[OrderForm] handleSave - calling saveOrder...');
      const savedOrderId = await runPageOwnedWorkspaceOperation(
        workspaceKey,
        'order-save',
        () => saveOrder(formValues, mode === 'edit'),
      );
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

        // Export is optional and runs in background, but remains owned by its
        // workspace/auth scope so stale completions cannot publish.
        console.log('[OrderForm] handleSave - starting background auto-export to Google Drive');
        if (businessOrderDetails(formValues.details).length > 0) void runPageOwnedWorkspaceOperation(
            workspaceKey,
            'order-excel-export',
            (owner) => exportToDrive({
              order_id: savedOrderId,
              order_name: formValues.header.order_name,
              order_date: formValues.header.order_date,
            }, owner),
          )
          .then(() => {
            console.log('[OrderForm] handleSave - background auto-export completed successfully');
          })
          .catch((exportError) => {
            if (isWorkspaceOperationOwnershipLost(exportError)) return;
            console.error('[OrderForm] handleSave - background auto-export failed:', exportError);
          });
        return true;
      }
      return false;
    } catch (error) {
      if (isWorkspaceOperationOwnershipLost(error)) return;
      console.error('[OrderForm] handleSave - CATCH block, error:', error);
      notification.error({
        message: 'Ошибка при сохранении',
        description: error instanceof Error ? error.message : 'Неизвестная ошибка',
        duration: 0,
      });
      return false;
    } finally {
      releaseOperationPin();
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

  // «NewLine»: обычный срок по настройкам сроков — для быстрого выбора рядом с плановой датой.
  const usualPlannedDate = useMemo(
    () => (
      isWorkbench && mode === 'create' && deadlineDefaultSchedule.loaded && header.order_date
        ? computePlannedCompletionDate(
          String(header.order_date),
          deadlineDefaultSchedule.schedule,
          applicableProductionStatusIds,
        )
        : null
    ),
    [
      isWorkbench,
      mode,
      deadlineDefaultSchedule.loaded,
      deadlineDefaultSchedule.schedule,
      header.order_date,
      applicableProductionStatusIds,
    ],
  );
  const workbenchSaveHotkeyRef = useRef<(() => void) | null>(null);
  // вкладки заказов остаются смонтированными: сохранять по клавишам можно только видимую
  const workspaceTabActive = useKeepAlive().isActive;
  useEffect(() => {
    if (!isWorkbench) return undefined;
    // Ctrl+S / ⌘S сохраняет заказ; по коду клавиши, чтобы работало и в русской раскладке
    const handleSaveHotkey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyS') return;
      if (!workbenchSaveHotkeyRef.current) return;
      event.preventDefault();
      workbenchSaveHotkeyRef.current();
    };
    window.addEventListener('keydown', handleSaveHotkey);
    return () => window.removeEventListener('keydown', handleSaveHotkey);
  }, [isWorkbench]);

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
          <OrderLifecycleReadSurface active={isFormSectionActive('basic')}>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <OrderBasicInfo
                clientLocked={bazisDraftClientLocked}
                projectField={projectField}
              />
              <OrderNotesSection />
            </Space>
          </OrderLifecycleReadSurface>
        ),
      },
      {
        key: 'details',
        label: isOperational ? 'Состав' : 'Детали заказа',
        children: (
          <OrderLifecycleReadSurface active={isFormSectionActive('details')}>
            <div ref={orderFormDetailsBlockRef} className="order-form-details-section">
              <OrderSaveValidationContext.Provider value={saveValidation}>
                <OrderDetailsTab
                  ref={detailsTabRef}
                  isSaving={isSaving}
                  isNewOrder={mode === 'create'}
                />
              </OrderSaveValidationContext.Provider>
            </div>
          </OrderLifecycleReadSurface>
        ),
      },
      {
        key: 'hdf',
        label: 'ХДФ',
        children: <OrderLifecycleReadSurface active={isFormSectionActive('hdf')}><OrderHdfTab onSave={handleSave} isSaving={isSaving} /></OrderLifecycleReadSurface>,
      },
      {
        key: 'dates',
        label: isOperational ? 'Логистика' : 'Даты',
        children: <OrderLifecycleReadSurface active={isFormSectionActive('dates')}><OrderDatesSection usualPlannedDate={usualPlannedDate} /></OrderLifecycleReadSurface>,
      },
      {
        key: 'finance',
        label: 'Финансы',
        children: (
          <OrderLifecycleReadSurface active={isFormSectionActive('finance')}>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <OrderFinanceSection />
              <OrderPaymentsTab ref={paymentsTabRef} />
            </Space>
          </OrderLifecycleReadSurface>
        ),
      },
      ...(cutTabEnabled
        ? [
            {
              key: 'cut',
              label: 'Раскрой',
              children: header.order_id ? (
                <OrderLifecycleReadSurface active={isFormSectionActive('cut')}>
                  <CutPage embeddedOrderId={header.order_id} />
                </OrderLifecycleReadSurface>
              ) : null,
              disabled: mode === 'create' && !header.order_id,
            },
          ]
        : []),
      {
        key: 'services',
        label: 'Услуги/товары',
        children: <OrderCatalogLinesTable rows={catalogLines}
          canViewFinancials={can('orders.view_financials')}
          canSelect={can('references.view') || can('references.manage')}
          onChange={!isSaving && featureFlags.useBackendOrdersWrite && can('orders.view_financials') && can(mode === 'create' ? 'orders.create' : 'orders.update') ? setCatalogLines : undefined} />,
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
        children: (
          <OrderLifecycleReadSurface active={isFormSectionActive('requirements')}>
            <OrderMaterialsTab />
          </OrderLifecycleReadSurface>
        ),
        disabled: mode === 'create' && !header.order_id,
      },
      {
        key: 'additional',
        label: isOperational ? 'Бирки' : 'Дополнительно',
        children: (
          <OrderLifecycleReadSurface active={isFormSectionActive('additional')}>
            {isOperational ? (
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
                <OrderFilesSection orderId={header.order_id ?? orderId} />
                {labelsEnabled && (
                  <OrderLabelDataEditor orderId={header.order_id ?? orderId} isOrderDirty={isDirty} />
                )}
              </Space>
            )}
          </OrderLifecycleReadSurface>
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
      activeTab,
      hybridOpenSections,
      isWorkbench,
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
      catalogLines,
      setCatalogLines,
      can,
      usualPlannedDate,
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
      // «NewLine» has its own compact bar; the legacy sticky stack stays off there.
      const next =
        !isWorkbench &&
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
  }, [activeTab, details.length, isMobile, isWorkbench, workspaceTabsHeight]);

  // «NewLine»: the compact bar appears once the page head has scrolled under the app chrome.
  useEffect(() => {
    if (!isWorkbench) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const head = orderFormStickySentinelRef.current?.parentElement?.querySelector('.wb-order-head__top');
      const next = head ? head.getBoundingClientRect().bottom < workbenchChromeBottom : false;
      setWorkbenchHeadHidden((prev) => (prev === next ? prev : next));
      const anchors = workbenchAnchorsRef.current;
      const stuck = anchors
        ? anchors.getBoundingClientRect().top <= workbenchChromeBottom + WORKBENCH_FORM_BAR_HEIGHT + 1
        : false;
      setWorkbenchAnchorsStuck((prev) => (prev === stuck ? prev : stuck));
      // the anchor of the section that is under the sticky rows right now
      const line = workbenchChromeBottom + WORKBENCH_FORM_BAR_HEIGHT + (anchors?.offsetHeight ?? 0) + 24;
      let current: string | null = null;
      let currentTop = -Infinity;
      for (const [key, node] of Object.entries(hybridSectionRefs.current)) {
        if (!node || key === 'dates') continue;
        const top = node.getBoundingClientRect().top;
        if (top <= line && top > currentTop) {
          current = key;
          currentTop = top;
        }
      }
      setWorkbenchSpySection((prev) => (prev === current ? prev : current));
    };
    // the extra room is dropped once the user has scrolled away from it (it is below the screen then)
    const dropSpacer = () => {
      const spacer = hybridSpacerRef.current;
      if (hybridSpacerHeightRef.current > 0 && spacer && spacer.getBoundingClientRect().top >= window.innerHeight) {
        setHybridSpacer(0);
      }
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    const unpin = () => {
      hybridScrollTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      hybridScrollTimersRef.current = [];
      setWorkbenchPinnedSection(null);
      dropSpacer();
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('wheel', unpin, { passive: true });
    window.addEventListener('touchmove', unpin, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      window.removeEventListener('wheel', unpin);
      window.removeEventListener('touchmove', unpin);
    };
  }, [isWorkbench, orderKey, setHybridSpacer, workbenchChromeBottom]);

  useEffect(() => {
    const update = () => {
      if (!orderFormStickyEnabled) {
        orderFormExpandedSummaryHeightRef.current = 0;
      }
      const node = orderFormStickySentinelRef.current;
      const wrapper = orderFormSummaryTabsRef.current;
      const sentinelTop = node ? node.getBoundingClientRect().top : null;
      const currentHeight = wrapper ? wrapper.getBoundingClientRect().height : 0;
      const wasStuck = orderFormSummaryStuckRef.current;
      if (!wasStuck && currentHeight > 0) {
        orderFormExpandedSummaryHeightRef.current = currentHeight;
      }
      const next = resolveStickySummaryStuck({
        enabled: orderFormStickyEnabled,
        wasStuck,
        sentinelTop,
        stickyTop: workspaceTabsHeight,
        expandedHeight: orderFormExpandedSummaryHeightRef.current,
        currentHeight,
      });
      if (orderFormSummaryStuckRef.current !== next) {
        orderFormSummaryStuckRef.current = next;
        setOrderFormSummaryStuck(next);
      }
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
      const closed = closeTab(tabKey, discard ? { discard: true } : undefined);
      if (!closed) {
        notification.warning({
          message: 'Операция выполняется',
          description: 'Дождитесь завершения операции перед закрытием вкладки',
        });
        return;
      }
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
  const isInitialLoading = isLoadingEssential;
  const isRefreshing = !isInitialLoading && (
    orderFetching
    || detailsFetching
    || paymentsFetching
    || detailNamesFetching
    || headerNameFetching
  );
  const formProgressiveLoading = {
    isInitialLoading,
    isRefreshing,
    isSectionLoading: false,
  };

  const orderName = header.order_name?.trim();
  const cardTitle =
    mode === 'create'
      ? `Создание заказа${orderName ? ` «${orderName}»` : ''}`
      : `Редактирование заказа${orderName ? ` «${orderName}»` : ''}`;

  if (isInitialLoading) {
    return (
      <OrderDraftStoreProvider orderKey={orderKey}>
        {isOperational ? (
          <div className="order-form-operational">
            <OperationalPageHeader
              breadcrumbs={<Space split={<span>›</span>} size={6}><Link to="/orders">Заказы</Link><span>Редактирование</span></Space>}
              title={mode === 'create' ? 'Создание заказа' : 'Редактирование заказа'}
              description="Основные данные появятся без перезагрузки рабочего пространства."
            />
            <div className="order-form-operational__workspace">
              <OrderFormProgressiveSurface
                state={formProgressiveLoading}
                error={statusesError ?? null}
                onRetry={() => { void retryStatuses(); }}
              />
            </div>
          </div>
        ) : (
          <Card title={cardTitle}>
            <OrderFormProgressiveSurface
              state={formProgressiveLoading}
              error={statusesError ?? null}
              onRetry={() => { void retryStatuses(); }}
            />
          </Card>
        )}
      </OrderDraftStoreProvider>
    );
  }

  // Customer screen (second monitor): present this order, hide, emergency switch-off. Read-only for the form.
  const clientScreenControl = (
    <ClientScreenOrderHeader
      orderKey={orderKey}
      orderNumber={(headerNameData?.data as { order_full_number?: string | null } | undefined)?.order_full_number ?? null}
      activeTab={activeTab}
      operational={isOperational}
    />
  );

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
                {clientScreenControl}
                {mode === 'edit' && orderId ? (
                  <Button icon={<EyeOutlined />} onClick={() => show('orders_view', orderId)}>
                    Просмотр
                  </Button>
                ) : null}
                {featureFlags.useBackendOrdersWrite && canDeleteCurrentOrder && mode === 'edit' && orderId && !header.delete_flag ? (
                  <Popconfirm
                    title={<PopconfirmContent title={`Удалить заказ №${header.order_name}?`} description="Заказ попадёт в корзину, его можно будет восстановить." />}
                    okText="Удалить"
                    okButtonProps={{ danger: true }}
                    cancelText="Отмена"
                    onConfirm={makeOrderDeleteHandler({
                      capturePublicationGuard: () => {
                        const token = backendOrderLoadGuard.capture();
                        return token ? () => backendOrderLoadGuard.isSameResource(token) : null;
                      },
                      deleteFn: () => runPageOwnedWorkspaceOperation(
                        tabKey,
                        'order-delete',
                        () => ordersApi.delete(Number(orderId), {
                          version: Number(header.version ?? 0),
                        }),
                      ),
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
          <OrderFormProgressiveSurface
            state={formProgressiveLoading}
            error={statusesError ?? null}
            onRetry={() => { void retryStatuses(); }}
          >
            <div className="order-form-operational__workspace">
            <div className={orderFormPageClassName} style={orderFormStickyStyle}>
              <div ref={orderFormStickySentinelRef} className="order-show-sticky-sentinel" aria-hidden />
              <div
                ref={orderFormSummaryTabsRef}
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
          </OrderFormProgressiveSurface>
        </div>
      </OrderDraftStoreProvider>
    );
  }

  const hybridItemByKey = new Map(headerTabItems.map((item) => [String(item.key), item]));
  const hybridSectionTitle = (key: string, label: React.ReactNode): React.ReactNode => (
    key === 'basic' ? 'Клиент и срок' : key === 'services' ? 'Услуги и товары' : label
  );
  const hybridAnchors = [
    ...HYBRID_MAIN_SECTION_ORDER
      .filter((key) => hybridItemByKey.has(key))
      .map((key) => ({
        key,
        label: hybridSectionTitle(key, hybridItemByKey.get(key)!.label),
        disabled: false,
      })),
    ...headerTabItems
      .filter((item) => !HYBRID_MAIN_SECTION_KEYS.includes(String(item.key)))
      .map((item) => ({ key: String(item.key), label: item.label, disabled: Boolean(item.disabled) })),
  ];
  // «Сроки» live inside the first section, so they share its anchor
  const hybridCurrentAnchor = workbenchPinnedSection ?? workbenchSpySection ?? (activeTab === 'dates' ? 'basic' : activeTab);
  const formActions = (
        <Space>
          {clientScreenControl}
          {mode === 'edit' && orderId && (
            <Button
              className="order-form-action order-form-action--view"
              icon={<EyeOutlined />}
              onClick={() => show('orders_view', orderId)}
              style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
            >
              Просмотр
            </Button>
          )}
          {featureFlags.useBackendOrdersWrite && canDeleteCurrentOrder && mode === 'edit' && orderId && !header.delete_flag ? (
            <Popconfirm
              title={<PopconfirmContent title={`Удалить заказ №${header.order_name}?`} description="Заказ попадёт в корзину, его можно будет восстановить." />}
              okText="Удалить"
              okButtonProps={{ danger: true }}
              cancelText="Отмена"
              onConfirm={makeOrderDeleteHandler({
                capturePublicationGuard: () => {
                  const token = backendOrderLoadGuard.capture();
                  return token ? () => backendOrderLoadGuard.isSameResource(token) : null;
                },
                deleteFn: () => runPageOwnedWorkspaceOperation(
                  tabKey,
                  'order-delete',
                  () => ordersApi.delete(Number(orderId), {
                    version: Number(header.version ?? 0),
                  }),
                ),
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
                  className="order-form-action order-form-action--delete"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={isSaving}
                  style={{ height: '27px', fontSize: '13px', padding: '0 8px' }}
                />
              </Tooltip>
            </Popconfirm>
          ) : null}
          <Button
            className="order-form-action order-form-action--save"
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
            className="order-form-action order-form-action--close"
            icon={<CloseOutlined />}
            onClick={handleCancel}
            disabled={isSaving}
            style={{ height: '27px', fontSize: '13px', padding: '0 12px' }}
          >
            Закрыть
          </Button>
        </Space>
  );
  const formHasUnsavedChanges = isDirty || isDetailEditing || isPaymentEditing;
  workbenchSaveHotkeyRef.current = isWorkbench && formHasUnsavedChanges && !isSaving && workspaceTabActive
    ? () => { void handleSave(); }
    : null;
  // «NewLine» compact bar: the two actions needed while editing a long details list.
  const workbenchCompactActions = (
    <>
      <Button icon={<CloseOutlined />} onClick={handleCancel} disabled={isSaving}>Закрыть</Button>
      <Button
        type={formHasUnsavedChanges ? 'primary' : 'default'}
        icon={<SaveOutlined />}
        onClick={handleSave}
        loading={isSaving}
        disabled={!formHasUnsavedChanges}
      >
        Сохранить
      </Button>
    </>
  );

  return (
    <OrderDraftStoreProvider orderKey={orderKey}>
    <Card
      className={isWorkbench ? 'order-form-card order-form-card--workbench' : 'order-form-card'}
      title={isWorkbench ? undefined : cardTitle}
      extra={isWorkbench ? undefined : formActions}
    >
      <OrderFormProgressiveSurface
        state={formProgressiveLoading}
        error={statusesError ?? null}
        onRetry={() => { void retryStatuses(); }}
      >
        {/* Read-only header with order summary (both create and edit modes) */}
        <div className={orderFormPageClassName} style={orderFormStickyStyle}>
        <div ref={orderFormStickySentinelRef} className="order-show-sticky-sentinel" aria-hidden />
        {isWorkbench ? (
          <>
            <nav className="wb-order-crumbs" aria-label="Хлебные крошки">
              <Link to="/orders">Заказы</Link>
              <RightOutlined aria-hidden />
              {mode === 'edit' && orderId ? (
                <>
                  <Link to={`/orders/show/${orderId}`}>{orderName || orderId}</Link>
                  <RightOutlined aria-hidden />
                  <span>Редактирование</span>
                </>
              ) : (
                <span>Новый заказ</span>
              )}
            </nav>
            <div className="wb-order-bar-slot" data-on={workbenchHeadHidden} aria-hidden={!workbenchHeadHidden}>
              <OrderHeaderSummary compactSticky dirty={formHasUnsavedChanges} compactActions={workbenchCompactActions} />
            </div>
            <OrderHeaderSummary pageTitle={cardTitle} actions={formActions} dirty={formHasUnsavedChanges} />
            <nav
              ref={workbenchAnchorsRef}
              className="wb-form-anchors"
              data-stuck={workbenchAnchorsStuck}
              aria-label="Разделы формы"
            >
              {hybridAnchors.map((anchor) => (
                <button
                  key={anchor.key}
                  type="button"
                  className="wb-form-anchors__item"
                  aria-current={hybridCurrentAnchor === anchor.key ? 'true' : undefined}
                  disabled={anchor.disabled}
                  onClick={() => goToFormSection(anchor.key)}
                >
                  {anchor.label}
                </button>
              ))}
            </nav>
            {HYBRID_MAIN_SECTION_ORDER.map((key, index) => {
              const item = hybridItemByKey.get(key);
              if (!item) return null;
              const dates = key === 'basic' ? hybridItemByKey.get('dates') : undefined;
              return (
                <section
                  key={key}
                  ref={(node) => {
                    hybridSectionRefs.current[key] = node;
                    if (key === 'basic') hybridSectionRefs.current.dates = node;
                  }}
                  className="wb-panel wb-form-section"
                >
                  <h2 className="wb-form-section__title">
                    <span className="wb-form-section__num" aria-hidden>{index + 1}</span>
                    {hybridSectionTitle(key, item.label)}
                  </h2>
                  <div className="wb-form-section__body">
                    {key === 'finance' ? (
                      <div className="wb-form-finance">
                        <div className="wb-form-finance__main">{item.children}</div>
                        <OrderFinanceSummary />
                      </div>
                    ) : item.children}
                    {dates ? <div className="wb-form-section__sub">{dates.children}</div> : null}
                    {key === 'details' ? (
                      <p className="wb-form-keys">
                        <span><kbd>Tab</kbd> следующее поле</span>
                        <span><kbd>Enter</kbd> или <kbd>F2</kbd> править ячейку</span>
                        <span><kbd>Esc</kbd> отменить правку</span>
                        <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> по ячейкам</span>
                        <span><kbd>↓</kbd> на последней строке — новая строка</span>
                        <span><kbd>Ctrl</kbd><kbd>D</kbd> дублировать строку</span>
                        <span><kbd>Ctrl</kbd><kbd>S</kbd> сохранить заказ</span>
                      </p>
                    ) : null}
                  </div>
                </section>
              );
            })}
            {headerTabItems
              .filter((item) => !HYBRID_MAIN_SECTION_KEYS.includes(String(item.key)))
              .map((item) => {
                const key = String(item.key);
                const open = hybridOpenSections.includes(key);
                return (
                  <section
                    key={key}
                    ref={(node) => { hybridSectionRefs.current[key] = node; }}
                    className={`wb-panel wb-form-section wb-form-section--fold${open ? ' wb-form-section--open' : ''}`}
                  >
                    <button
                      type="button"
                      className="wb-form-section__toggle"
                      aria-expanded={open}
                      disabled={item.disabled}
                      title={item.disabled ? 'Доступно после сохранения заказа' : undefined}
                      onClick={() => {
                        setHybridOpenSections((current) => (
                          current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
                        ));
                        if (!open) setActiveTab(key);
                      }}
                    >
                      <RightOutlined className="wb-form-section__chevron" aria-hidden />
                      <h2 className="wb-form-section__title">{item.label}</h2>
                      {item.disabled ? <span className="wb-form-section__hint">после сохранения заказа</span> : null}
                    </button>
                    {open ? <div className="wb-form-section__body">{item.children}</div> : null}
                  </section>
                );
              })}
            {/* room below the last sections, so an anchor can bring any of them right under the sticky rows */}
            <div
              ref={hybridSpacerRef}
              className="wb-form-spacer"
              style={{ height: hybridSpacerHeight }}
              aria-hidden
            />
            <OrderFormWorkbenchBar
              dirty={formHasUnsavedChanges}
              saving={isSaving}
              onSave={() => { void handleSave(); }}
              onCancel={handleCancel}
            />
          </>
        ) : (
          <>
        <div
          ref={orderFormSummaryTabsRef}
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
          </>
        )}
        </div>
      </OrderFormProgressiveSurface>
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

function asWorkspaceRecord(value: unknown): WorkspaceSerializableRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as WorkspaceSerializableRecord
    : null;
}

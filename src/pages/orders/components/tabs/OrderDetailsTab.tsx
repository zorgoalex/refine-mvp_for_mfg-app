import { Tooltip } from '../../../../ui/tooltipDelay';
// Order Details Tab
// Container for managing order details with toolbar and CRUD operations

import React, { useState, useRef, forwardRef, useImperativeHandle, useCallback, useMemo, useEffect } from 'react';
import { Card, Button, Space, Modal, message, Alert } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  ReloadOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  ClearOutlined,
  ScissorOutlined,
  TableOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { OrderDetailTable, OrderDetailTableRef } from '../tables/OrderDetailTable';
import { OrderDetailModal } from '../modals/OrderDetailModal';
import { BulkEditModal } from '../modals/BulkEditModal';
import { ImportDropdownButton } from '../import';
import { useOrderFormStore, useOrderDraftStoreApi } from '../../../../stores/orderFormStore';
import { OrderDetail } from '../../../../types/orders';
import { DraggableModalWrapper } from '../../../../components/DraggableModalWrapper';
import { useSheetMaterialOptions, filterCuttableOptions } from '../../../../hooks/useSheetMaterialOptions';
import { useDetailGrouping } from '../../useDetailGrouping';
import { DetailGroupingControls } from '../DetailGroupingControls';
import { authSession } from '../../../../api/authSession';
import { AddToCutModal } from '../AddToCutModal';
import { AddToBazisCutModal } from '../../../bazis-cut/AddToBazisCutModal';
import { selectedDetailIds } from '../../groupSelection';
import {
  EMPTY_GROUP_KEY,
  extractCutJobGroupValue,
  formatBasisProjectGroupLabel,
  formatBazisCutSetsGroupLabel,
  formatCutJobGroupLabel,
  selectedGroupLabelForCut,
  type GroupField,
} from '../../detailGrouping';
import { featureFlags } from '../../../../config/featureFlags';
import { can } from '../../../../utils/permissions';
import { useOrderFormData } from '../../../../hooks/useOrderFormData';
import { calculateOrderDetailArea, calculateOrderTotalArea } from '../../../../utils/orderArea';
import { OrderToolbarLabel } from '../OrderDetailsToolbar';
import { useCutDetailLastReady } from '../../useCutDetailLastReady';
import { buildCutJobLinkMapsFromDetails, mergeCutJobLinkMaps } from '../../cutColumnHelpers';
import { OrderDetailTransferModal } from '../OrderDetailTransferModal';
import { mapOrderDtoToFormValues } from '../../../../api/mappers/orderMapper';
import type { TransferOrderDetailsResponse } from '../../../../api/types/orderApi.types';
import { ordersApi } from '../../../../api/ordersApi';
import { mergeOrderRefreshDetails } from '../../orderRefresh';
import {
  OrderLifecycleReadSurface,
  useOrderAsyncReadGuard,
} from '../../../../query/orderLifecycleQueries';
import { useKeepAlive } from '../../../../components/workspace/KeepAliveContext';
import { useWorkspaceCheckpointAdapter } from '../../../../workspace/workspaceCheckpointReact';
import { readWorkspaceCheckpointAdapterState } from '../../../../workspace/workspaceCheckpointRegistry';
import { useDeferredWorkspaceEntity } from '../../../../workspace/useDeferredWorkspaceEntity';

// Exposed methods via ref
export interface OrderDetailsTabRef {
  applyCurrentEdits: () => Promise<boolean>;
}

// Static defaults for quick add (sheet_material_type_id is resolved dynamically
// from the first active cuttable option in the component body).
const QUICK_ADD_DEFAULTS_BASE = {
  milling_type_id: 1,  // Модерн
  edge_type_id: 1,     // р-1
  priority: 100,
};

// Drag selection confirmation state
interface DragSelectionState {
  pendingKeys: React.Key[];
  confirm: () => void;
  cancel: () => void;
}

const AccessibleToolbarTooltip: React.FC<{
  title: React.ReactNode;
  disabled?: boolean;
  children: React.ReactElement;
}> = ({ title, disabled = false, children }) => (
  <Tooltip title={title}>
    <span
      style={{ display: 'inline-flex' }}
      {...(disabled
        ? {
            tabIndex: 0,
            role: 'button',
            'aria-disabled': true,
            'aria-label': String(title),
          }
        : {})}
    >
      {children}
    </span>
  </Tooltip>
);

export const OrderDetailsTab = forwardRef<OrderDetailsTabRef, { isSaving?: boolean }>(({ isSaving = false }, ref) => {
  const {
    details,
    addDetail,
    insertDetailAfter,
    updateDetail,
    deleteDetail,
    reorderDetails,
    header,
    updateHeaderField,
    isDirty,
    version,
    loadOrder,
    applyOrderRefresh,
  } = useOrderFormStore();
  const storeApi = useOrderDraftStoreApi();
  const { tabKey } = useKeepAlive();
  const workspaceKey = tabKey || `/orders/edit/${header?.order_id ?? 'new'}`;
  const restored = useRef(
    readWorkspaceCheckpointAdapterState(workspaceKey, 'order-details-tab'),
  ).current;
  const refreshGuard = useOrderAsyncReadGuard(`order-details-refresh:${header?.order_id ?? 'new'}`);
  const refreshScopeKey = `${refreshGuard.authNamespace}|order:${header?.order_id ?? 'new'}`;

  const groupingUserId = authSession.getUser()?.id ?? 'anon';
  const grouping = useDetailGrouping(groupingUserId, header?.order_id ?? 'new');
  const orderFormData = useOrderFormData(featureFlags.useBackendReferences);

  // Sheet-material quick-add default: first active cuttable type; falls back to
  // undefined so form validation prompts the user if no cuttable types are loaded.
  const sheetMaterials = useSheetMaterialOptions();
  const defaultSheetMaterialTypeId = React.useMemo(() => {
    const cuttable = filterCuttableOptions(sheetMaterials.options).filter((o) => o.isActive);
    return cuttable[0]?.value ?? undefined;
  }, [sheetMaterials.options]);

  const QUICK_ADD_DEFAULTS = React.useMemo(
    () => ({
      ...QUICK_ADD_DEFAULTS_BASE,
      ...(defaultSheetMaterialTypeId != null
        ? { sheet_material_type_id: defaultSheetMaterialTypeId }
        : {}),
    }),
    [defaultSheetMaterialTypeId],
  );

  const restoredModalOpen = restored?.detailModalOpen === true;
  const restoredModalMode = restored?.detailModalMode === 'edit' ? 'edit' : 'create';
  const restoredEditingDetailKey = readReactKey(restored?.editingDetailKey);
  const restoreEditRequested = restoredModalOpen && restoredModalMode === 'edit';
  const {
    entity: editingDetail,
    setEntity: setEditingDetail,
    restoreReady: restoredEditReady,
    restorePending: restoredEditPending,
    cancelDeferredRestore: cancelDeferredDetailRestore,
  } = useDeferredWorkspaceEntity({
    restoreRequested: restoreEditRequested,
    restoredKey: restoredEditingDetailKey,
    entities: details,
    getKey: (detail: OrderDetail) => detail.temp_id ?? detail.detail_id ?? null,
  });
  const [modalOpen, setModalOpen] = useState(
    () => restoredModalOpen && (!restoreEditRequested || restoredEditReady),
  );
  const [refreshState, setRefreshState] = useState<{
    scopeKey: string;
    inFlight: boolean;
  } | null>(null);
  const isRefreshing = refreshState?.scopeKey === refreshScopeKey
    && refreshState.inFlight;
  const [modalMode, setModalMode] = useState<'create' | 'edit'>(
    restoredModalMode,
  );
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>(
    () => readReactKeys(restored?.selectedRowKeys),
  );
  const [highlightedRowKey, setHighlightedRowKey] = useState<React.Key | null>(
    () => readReactKey(restored?.highlightedRowKey),
  );
  const [bulkEditModalOpen, setBulkEditModalOpen] = useState(
    () => restored?.bulkEditModalOpen === true,
  );
  const [dragSelectionState, setDragSelectionState] = useState<DragSelectionState | null>(null);
  const tableRef = useRef<OrderDetailTableRef>(null);

  useEffect(() => {
    if (restoreEditRequested && restoredEditReady && editingDetail) setModalOpen(true);
  }, [editingDetail, restoreEditRequested, restoredEditReady]);

  const cutEnabled = featureFlags.useBackendCut && can('cut.manage');
  const cutColumnEnabled = featureFlags.useBackendCut && can('cut.view');
  const [addToCutOpen, setAddToCutOpen] = useState(() => restored?.addToCutOpen === true);
  const bazisCutVisible = featureFlags.bazisCut;
  const bazisCutManage = can('cut.manage');
  const canRefreshOrder = !featureFlags.useBackendPermissions || can('orders.update');
  const [addToBazisCutOpen, setAddToBazisCutOpen] = useState(
    () => restored?.addToBazisCutOpen === true,
  );
  const selectedPersistedDetailIds = useMemo(
    () => selectedDetailIds(details as any[], selectedRowKeys),
    [details, selectedRowKeys],
  );
  const bazisCutDetailIds = selectedPersistedDetailIds;
  const eligibleCutDetailIds = useMemo(
    () => (cutEnabled ? selectedPersistedDetailIds : []),
    [cutEnabled, selectedPersistedDetailIds],
  );
  const persistedDetailIds = useMemo(
    () =>
      details
        .map((detail) => detail.detail_id)
        .filter((detailId): detailId is number => Number.isInteger(detailId) && detailId > 0),
    [details],
  );
  const [transferOpen, setTransferOpen] = useState(() => restored?.transferOpen === true);
  const transferDetailIds = selectedPersistedDetailIds;
  const canTransferDetails = can('orders.update') && can('orders.view_financials');
  const canCreateTransferTarget = can('orders.create');
  const sourceVersion = Number(version ?? header?.version ?? 0);
  const getTransferDetailIdsForRowKeys = useCallback(
    (rowKeys: React.Key[]) => selectedDetailIds(details as any[], rowKeys),
    [details],
  );
  const getTransferRowsDisabledReason = useCallback((rowKeys: React.Key[]) => {
    const detailIds = getTransferDetailIdsForRowKeys(rowKeys);
    if (!canTransferDetails) return 'Недостаточно прав';
    if (isDirty || isSaving) return 'Сначала сохраните изменения заказа';
    if (header?.order_id == null) return 'Сначала сохраните заказ';
    if (!Number.isInteger(sourceVersion)) return 'Неизвестная версия заказа';
    if (rowKeys.length === 0) return 'Выберите детали';
    if (detailIds.length === 0) return 'Выберите сохраненные детали';
    if (detailIds.length !== rowKeys.length) return 'Сначала сохраните выбранные новые строки';
    if (detailIds.length >= persistedDetailIds.length) return 'В исходном заказе должна остаться хотя бы одна деталь';
    return null;
  }, [
    canTransferDetails,
    getTransferDetailIdsForRowKeys,
    header?.order_id,
    isDirty,
    isSaving,
    persistedDetailIds.length,
    sourceVersion,
  ]);
  const transferDisabledReason = getTransferRowsDisabledReason(selectedRowKeys);
  const transferDisabled = !!transferDisabledReason;
  const transferTooltip = transferDisabledReason ?? `Перенести детали (${transferDetailIds.length})`;

  useWorkspaceCheckpointAdapter(workspaceKey, 'order-details-tab', {
    canCapture: () => dragSelectionState === null && !restoredEditPending,
    capture: () => ({
      detailModalOpen: modalOpen,
      detailModalMode: modalMode,
      editingDetailKey: editingDetail?.temp_id ?? editingDetail?.detail_id ?? null,
      selectedRowKeys: selectedRowKeys.filter(isSerializableReactKey),
      highlightedRowKey: isSerializableReactKey(highlightedRowKey) ? highlightedRowKey : null,
      bulkEditModalOpen,
      addToCutOpen,
      addToBazisCutOpen,
      transferOpen,
    }),
  });
  const embeddedCutJobMaps = useMemo(() => buildCutJobLinkMapsFromDetails(details), [details]);
  const fetchedCutJobMaps = useCutDetailLastReady({
    enabled: cutColumnEnabled,
    detailIds: persistedDetailIds,
    orderId: header?.order_id,
  });
  const cutJobMaps = useMemo(
    () => fetchedCutJobMaps.loaded ? fetchedCutJobMaps : mergeCutJobLinkMaps(embeddedCutJobMaps, fetchedCutJobMaps),
    [embeddedCutJobMaps, fetchedCutJobMaps],
  );
  const sheetNameById = useMemo(
    () => new Map(orderFormData.references.sheetMaterialTypes.map((option) => [option.value, option.label])),
    [orderFormData.references.sheetMaterialTypes],
  );
  const groupNumberLabel = useCallback((value: unknown, digits = 0): string => {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    return Number.isFinite(num)
      ? num.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : '—';
  }, []);
  const groupValueOf = useCallback(
    (sample: OrderDetail, field: GroupField): string | null | undefined => {
      switch (field) {
        case 'production_status': {
          const statusId = Number(sample.production_status_id);
          return Number.isFinite(statusId) && statusId > 0 ? String(statusId) : EMPTY_GROUP_KEY;
        }
        case 'cut_job': {
          const detailId = Number(sample.detail_id);
          const ref = Number.isInteger(detailId) ? cutJobMaps.cutJobByDetailId.get(detailId) : undefined;
          return extractCutJobGroupValue(ref ?? sample.cut_job);
        }
        case 'bath_cut_job': {
          const detailId = Number(sample.detail_id);
          const ref = Number.isInteger(detailId) ? cutJobMaps.bathCutJobByDetailId.get(detailId) : undefined;
          return extractCutJobGroupValue(ref ?? sample.bath_cut_job);
        }
        default:
          return undefined;
      }
    },
    [cutJobMaps.bathCutJobByDetailId, cutJobMaps.cutJobByDetailId],
  );
  const groupLabelOf = useCallback(
    (sample: OrderDetail, field: GroupField) => {
      switch (field) {
        case 'detail_number':
          return groupNumberLabel(sample.detail_number);
        case 'area':
          return `${groupNumberLabel(sample.area, 2)} м²`;
        case 'milling':
          return orderFormData.references.millingTypeNameById.get(sample.milling_type_id) || '—';
        case 'hdf_parameter':
          return groupNumberLabel(sample.hdf_parameter_override_mm, 2);
        case 'edge':
          return orderFormData.references.edgeTypeNameById.get(sample.edge_type_id) || '—';
        case 'material':
          return sample.material_name_resolved || sheetNameById.get(sample.sheet_material_type_id ?? 0) || '—';
        case 'note':
          return (sample.note || '').trim() || '—';
        case 'price':
          return sample.milling_cost_per_sqm != null ? String(sample.milling_cost_per_sqm) : '—';
        case 'detail_cost':
          return groupNumberLabel(sample.detail_cost);
        case 'film':
          return sample.film_id != null ? (orderFormData.references.filmNameById.get(sample.film_id) || '—') : '—';
        case 'production_status':
          return sample.production_status_id != null
            ? orderFormData.references.productionStatusNameById.get(sample.production_status_id) || sample.production_status_name || '—'
            : '—';
        case 'doweling':
          return sample.doweling === true ? 'Присадка' : '—';
        case 'cut_job': {
          const detailId = Number(sample.detail_id);
          const ref = Number.isInteger(detailId) ? cutJobMaps.cutJobByDetailId.get(detailId) : undefined;
          return formatCutJobGroupLabel(ref ?? sample.cut_job);
        }
        case 'bath_cut_job': {
          const detailId = Number(sample.detail_id);
          const ref = Number.isInteger(detailId) ? cutJobMaps.bathCutJobByDetailId.get(detailId) : undefined;
          return formatCutJobGroupLabel(ref ?? sample.bath_cut_job);
        }
        case 'basis_project':
          return formatBasisProjectGroupLabel(sample);
        case 'bazis_cut_sets':
          return formatBazisCutSetsGroupLabel(sample.bazis_cut_sets);
        default:
          return '—';
      }
    },
    [
      cutJobMaps.bathCutJobByDetailId,
      cutJobMaps.cutJobByDetailId,
      groupNumberLabel,
      orderFormData.references.edgeTypeNameById,
      orderFormData.references.filmNameById,
      orderFormData.references.millingTypeNameById,
      orderFormData.references.productionStatusNameById,
      sheetNameById,
    ],
  );
  const cutSelectedGroupName = useMemo(
    () =>
      selectedGroupLabelForCut(
        details,
        eligibleCutDetailIds,
        grouping.state.showSeparation ? grouping.state.field : null,
        groupLabelOf,
        groupValueOf,
      ),
    [details, eligibleCutDetailIds, grouping.state.field, grouping.state.showSeparation, groupLabelOf, groupValueOf],
  );

  // Expose methods via ref for parent (OrderForm) to call
  useImperativeHandle(ref, () => ({
    applyCurrentEdits: async () => {
      if (tableRef.current) {
        return await tableRef.current.applyCurrentEdits();
      }
      return true;
    },
  }));

  // Handle create new detail via modal
  const handleCreate = () => {
    cancelDeferredDetailRestore();
    setModalMode('create');
    setEditingDetail(undefined);
    setModalOpen(true);
  };

  // Handle quick inline add
  const handleQuickAdd = async (): Promise<boolean> => {
    // Add new detail with defaults
    addDetail(QUICK_ADD_DEFAULTS as Omit<OrderDetail, 'temp_id'>);

    // Get the newly added detail
    await new Promise(resolve => setTimeout(resolve, 50));
    const updatedDetails = storeApi.getState().details;
    const lastDetail = [...updatedDetails].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];

    if (!lastDetail || !tableRef.current) return false;

    // If currently editing another row, save it first then start new
    if (tableRef.current.isEditing()) {
      const saved = await tableRef.current.saveCurrentAndStartNew(lastDetail);
      if (!saved) {
        // Validation failed - remove the just-added detail
        const tempId = lastDetail.temp_id || lastDetail.detail_id;
        if (tempId) {
          deleteDetail(tempId, lastDetail.detail_id);
        }
        message.warning('Сначала заполните обязательные поля текущей позиции');
        return false;
      }
    } else {
      // No row being edited, just start editing the new one
      tableRef.current.startEditRow(lastDetail);
    }
    return true;
  };

  // Handle edit existing detail
  const handleEdit = (detail: OrderDetail) => {
    cancelDeferredDetailRestore();
    setModalMode('edit');
    setEditingDetail(detail);
    setModalOpen(true);
  };

  // Handle save (create or update)
  const handleSave = (detailData: Omit<OrderDetail, 'temp_id'>) => {
    let rowKey: React.Key;

    if (modalMode === 'create') {
      // addDetail will assign temp_id internally
      addDetail(detailData);
      // Get the last added detail's temp_id (it will be the last one in the array)
      const lastDetail = [...details].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      rowKey = lastDetail?.temp_id || Date.now();
      message.success('Деталь добавлена');
    } else if (editingDetail) {
      const tempId = editingDetail.temp_id || editingDetail.detail_id!;
      updateDetail(tempId, detailData);
      rowKey = tempId;
      message.success('Деталь обновлена');
    } else {
      setModalOpen(false);
      setEditingDetail(undefined);
      return;
    }

    if (
      Number.isSafeInteger(detailData.sheet_material_type_id) &&
      Number(detailData.sheet_material_type_id) > 0
    ) {
      sheetMaterials.promoteUsage(Number(detailData.sheet_material_type_id));
    }

    setModalOpen(false);
    setEditingDetail(undefined);

    // Highlight the row and auto-clear after 2 seconds
    // Use setTimeout to ensure the detail is added to the list first
    setTimeout(() => {
      // Re-get the last detail after state update
      const updatedDetails = storeApi.getState().details;
      const lastDetail = [...updatedDetails].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];
      const actualRowKey = lastDetail?.temp_id || lastDetail?.detail_id || rowKey;

      setHighlightedRowKey(actualRowKey);
      setTimeout(() => {
        setHighlightedRowKey(null);
      }, 2000);
    }, 100);
  };

  // Handle delete single detail
  const handleDelete = (tempId: number, detailId?: number) => {
    Modal.confirm({
      title: 'Удалить деталь?',
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk() {
        deleteDetail(tempId, detailId);
        message.success('Деталь удалена');
      },
    });
  };

  // Handle delete multiple details
  const handleDeleteSelected = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('Выберите детали для удаления');
      return;
    }

    Modal.confirm({
      title: `Удалить выбранные детали (${selectedRowKeys.length})?`,
      content: 'Это действие нельзя отменить.',
      okText: 'Удалить',
      okType: 'danger',
      cancelText: 'Отмена',
      modalRender: (modal) => <DraggableModalWrapper>{modal}</DraggableModalWrapper>,
      onOk() {
        selectedRowKeys.forEach((key) => {
          const detail = details.find(
            (d) => (d.temp_id || d.detail_id) === key
          );
          if (detail) {
            const tempId = detail.temp_id || detail.detail_id!;
            deleteDetail(tempId, detail.detail_id);
          }
        });
        message.success(`Удалено деталей: ${selectedRowKeys.length}`);
        setSelectedRowKeys([]);
        reorderDetails(); // Renumber after deletion
      },
    });
  };

  // Handle row selection change
  const handleSelectChange = (newSelectedRowKeys: React.Key[]) => {
    setSelectedRowKeys(newSelectedRowKeys);
    // Clear drag selection state when selection changes
    setDragSelectionState(null);
  };

  const handleTransferDone = useCallback((response: TransferOrderDetailsResponse) => {
    loadOrder(mapOrderDtoToFormValues(response.sourceOrder));
    setTransferOpen(false);
    setSelectedRowKeys([]);
    setDragSelectionState(null);
    window.setTimeout(() => {
      storeApi.getState().finalizeInitialization();
    }, 200);
    message.success(
      response.targetCreated
        ? `Создан заказ ${response.targetOrder.header.orderName}, перенесено: ${response.movedDetailIds.length}`
        : `Перенесено деталей: ${response.movedDetailIds.length}`,
    );
  }, [loadOrder, storeApi]);

  const handleTransferRows = useCallback((rowKeys: React.Key[]) => {
    const disabledReason = getTransferRowsDisabledReason(rowKeys);
    if (disabledReason) {
      message.warning(disabledReason);
      return;
    }
    setSelectedRowKeys(rowKeys);
    setDragSelectionState(null);
    setTransferOpen(true);
  }, [getTransferRowsDisabledReason]);

  // Handle drag selection pending - show confirmation bar
  const handleDragSelectionPending = useCallback((
    pendingKeys: React.Key[],
    confirm: () => void,
    cancel: () => void
  ) => {
    if (pendingKeys.length > 0) {
      setDragSelectionState({ pendingKeys, confirm, cancel });
    } else {
      setDragSelectionState(null);
    }
  }, []);

  // Confirm drag selection
  const handleConfirmDragSelection = useCallback(() => {
    if (dragSelectionState) {
      dragSelectionState.confirm();
      setDragSelectionState(null);
    }
  }, [dragSelectionState]);

  // Cancel drag selection
  const handleCancelDragSelection = useCallback(() => {
    if (dragSelectionState) {
      dragSelectionState.cancel();
      setDragSelectionState(null);
    }
  }, [dragSelectionState]);

  // One-click reset of ANY selection: checked rows + pending drag selection.
  const handleClearSelection = useCallback(() => {
    dragSelectionState?.cancel();
    setDragSelectionState(null);
    setSelectedRowKeys([]);
  }, [dragSelectionState]);

  // Handle copy row - duplicate the row and insert after original
  const handleCopyRow = (detail: OrderDetail) => {
    // Create copy without identifiers
    const { temp_id, detail_id, detail_number, ...detailData } = detail;

    // Insert copy after the original
    const afterTempId = temp_id || detail_id;
    if (afterTempId) {
      insertDetailAfter(afterTempId, detailData as Omit<OrderDetail, 'temp_id'>);
      message.success('Строка скопирована');
    }
  };

  // Handle insert new row after current - insert empty row with defaults after selected
  const handleInsertAfter = async (detail: OrderDetail) => {
    const afterTempId = detail.temp_id || detail.detail_id;
    if (!afterTempId) return;

    // Insert new row with defaults after the selected row
    insertDetailAfter(afterTempId, QUICK_ADD_DEFAULTS as Omit<OrderDetail, 'temp_id'>);

    // Get the newly inserted detail and start editing it
    await new Promise(resolve => setTimeout(resolve, 50));
    const updatedDetails = storeApi.getState().details;

    // Find the detail that was just inserted (it will have the highest temp_id)
    const newDetail = [...updatedDetails].sort((a, b) => (b.temp_id || 0) - (a.temp_id || 0))[0];

    if (newDetail && tableRef.current) {
      tableRef.current.startEditRow(newDetail);
    }
  };

  // Handle recalculate all areas and sums
  const recalculateSums = () => {
    if (details.length === 0) {
      message.warning('Нет позиций для пересчёта');
      return;
    }

    let areaUpdatedCount = 0;
    let costUpdatedCount = 0;
    let totalAmount = 0;

    // First pass: recalculate area for each detail, then cost
    details.forEach((detail, index) => {
      const height = Number(detail.height) || 0;
      const width = Number(detail.width) || 0;
      const quantity = Number(detail.quantity) || 0;

      let newArea = 0;
      if (height > 0 && width > 0 && quantity > 0) {
        newArea = calculateOrderDetailArea(height, width, quantity);
      }

      const identifier = detail.temp_id || detail.detail_id;
      const currentArea = Number(detail.area) || 0;

      console.log(`[Recalc] #${index + 1}: h=${height}, w=${width}, q=${quantity}, rawArea=${(height/1000)*(width/1000)*quantity}, newArea=${newArea}, currentArea=${currentArea}, diff=${Math.abs(newArea - currentArea)}, identifier=${identifier}`);

      // Update area if changed (compare as numbers with tolerance)
      if (identifier && Math.abs(newArea - currentArea) > 0.001) {
        console.log(`[Recalc] #${index + 1}: UPDATING area from ${currentArea} to ${newArea}`);
        updateDetail(identifier, { area: newArea });
        areaUpdatedCount++;
      } else {
        console.log(`[Recalc] #${index + 1}: SKIPPED - no identifier or no change`);
      }

      // Use new area for cost calculation
      const areaForCost = newArea > 0 ? newArea : currentArea;
      const pricePerSqm = Number(detail.milling_cost_per_sqm) || 0;
      const newDetailCost = Number((areaForCost * pricePerSqm).toFixed(2));
      const currentDetailCost = Number(detail.detail_cost) || 0;

      // Update cost if changed (compare as numbers with tolerance)
      if (identifier && Math.abs(newDetailCost - currentDetailCost) > 0.001) {
        updateDetail(identifier, { detail_cost: newDetailCost });
        costUpdatedCount++;
      }

      totalAmount += newDetailCost;
    });

    // Round totals
    const totalArea = calculateOrderTotalArea(details);
    totalAmount = Number(totalAmount.toFixed(2));

    // Update total_amount in header
    updateHeaderField('total_amount', totalAmount);

    // Calculate final_amount
    // Note: discount is now stored as absolute amount (not percent)
    const discount = header.discount || 0;
    const discountedAmount = Math.max(0, Number((totalAmount - discount).toFixed(2)));
    updateHeaderField('final_amount', discountedAmount);

    if (discount > 0) {
      const discountPercent = totalAmount > 0 ? (discount / totalAmount) * 100 : 0;
      message.success(
        `Пересчитано: площадь ${areaUpdatedCount} поз., стоимость ${costUpdatedCount} поз. ` +
        `Площадь: ${totalArea.toLocaleString('ru-RU')} м², ` +
        `Сумма: ${totalAmount.toLocaleString('ru-RU')} ₸, скидка ${discount.toLocaleString('ru-RU')} ₸ (${discountPercent.toFixed(1)}%): ${discountedAmount.toLocaleString('ru-RU')} ₸`
      );
    } else {
      message.success(
        `Пересчитано: площадь ${areaUpdatedCount} поз., стоимость ${costUpdatedCount} поз. ` +
        `Площадь: ${totalArea.toLocaleString('ru-RU')} м², Сумма: ${totalAmount.toLocaleString('ru-RU')} ₸`
      );
    }
  };

  const handleRefresh = async () => {
    if (details.length === 0) {
      message.warning('Нет позиций для обновления');
      return;
    }
    const orderId = Number(header.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      message.warning('Сначала сохраните заказ');
      return;
    }
    const refreshToken = refreshGuard.capture();
    if (!refreshToken) return;

    recalculateSums();
    const afterRecalculate = storeApi.getState();
    applyOrderRefresh(
      mergeOrderRefreshDetails(afterRecalculate.details, []),
      afterRecalculate.version,
    );

    setRefreshState({ scopeKey: refreshScopeKey, inFlight: true });
    try {
      const baseVersion = storeApi.getState().version;
      const response = await ordersApi.refresh(orderId, { version: baseVersion });
      if (!refreshGuard.isSameResource(refreshToken)) return;
      if (response.order.version !== response.version) {
        message.error('Заказ изменён другим пользователем. Перезагрузите карточку перед сохранением.');
        return;
      }
      const serverDetails = mapOrderDtoToFormValues(response.order).details;
      const currentDetails = storeApi.getState().details;
      applyOrderRefresh(
        mergeOrderRefreshDetails(currentDetails, serverDetails),
        response.version,
      );
      message.success(
        response.updatedDowelingDetailIds.length > 0
          ? `Обновлено. Присадка установлена для ${response.updatedDowelingDetailIds.length} поз.`
          : 'Заказ и связи с документами обновлены',
      );
    } catch (error) {
      if (refreshGuard.isSameResource(refreshToken)) {
        console.error('Order refresh failed:', error);
        message.error('Не удалось обновить заказ. Обновите карточку и повторите действие.');
      }
    } finally {
      if (refreshGuard.isSameResource(refreshToken)) {
        setRefreshState({ scopeKey: refreshScopeKey, inFlight: false });
      }
    }
  };

  // Handle bulk edit apply
  const handleBulkEditApply = (changes: Partial<OrderDetail>, applyToAll: boolean) => {
    // Determine which details to update
    const detailsToUpdate = applyToAll
      ? details
      : details.filter((d) => selectedRowKeys.includes(d.temp_id || d.detail_id || 0));

    if (detailsToUpdate.length === 0) {
      message.warning('Нет позиций для обновления');
      return;
    }

    // Check if dimensions or price changed - need to recalculate
    const dimensionsChanged = changes.height !== undefined || changes.width !== undefined || changes.quantity !== undefined;
    const priceChanged = changes.milling_cost_per_sqm !== undefined;

    // Apply changes to each detail
    let updatedCount = 0;
    detailsToUpdate.forEach((detail) => {
      const tempId = detail.temp_id || detail.detail_id;
      if (tempId) {
        // Build update object
        const updateData: Partial<OrderDetail> = { ...changes };

        // Calculate new dimensions (use new value if changed, otherwise keep existing)
        const newHeight = changes.height ?? detail.height ?? 0;
        const newWidth = changes.width ?? detail.width ?? 0;
        const newQuantity = changes.quantity ?? detail.quantity ?? 0;
        const newPricePerSqm = changes.milling_cost_per_sqm ?? detail.milling_cost_per_sqm ?? 0;

        // If dimensions changed, recalculate area
        if (dimensionsChanged && newHeight > 0 && newWidth > 0 && newQuantity > 0) {
          const newArea = calculateOrderDetailArea(newHeight, newWidth, newQuantity);
          updateData.area = newArea;

          // Recalculate cost based on new area
          if (newPricePerSqm > 0) {
            updateData.detail_cost = Number((newArea * newPricePerSqm).toFixed(2));
          }
        } else if (priceChanged && detail.area) {
          // Only price changed, recalculate cost with existing area
          updateData.detail_cost = Number((detail.area * changes.milling_cost_per_sqm!).toFixed(2));
        }

        updateDetail(tempId, updateData);
        updatedCount++;
      }
    });

    // Recalculate totals if cost could have changed
    if (dimensionsChanged || priceChanged) {
      // Update total_amount in header
      const updatedDetails = storeApi.getState().details;
      const totalAmount = updatedDetails.reduce((sum, d) => sum + (d.detail_cost || 0), 0);
      updateHeaderField('total_amount', Number(totalAmount.toFixed(2)));

      // Calculate final_amount (considering discount/surcharge)
      const discount = header.discount || 0;
      const surcharge = header.surcharge || 0;
      let finalAmount = totalAmount;
      if (discount > 0) {
        finalAmount = Math.max(0, totalAmount - discount);
      } else if (surcharge > 0) {
        finalAmount = totalAmount + surcharge;
      }
      updateHeaderField('final_amount', Number(finalAmount.toFixed(2)));
    }

    message.success(`Обновлено позиций: ${updatedCount}`);
    if (
      Number.isSafeInteger(changes.sheet_material_type_id) &&
      Number(changes.sheet_material_type_id) > 0
    ) {
      sheetMaterials.promoteUsage(Number(changes.sheet_material_type_id));
    }
    setBulkEditModalOpen(false);

    // Clear selection after bulk edit
    setSelectedRowKeys([]);
  };

  return (
    <Card size="small">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {/* Drag Selection Confirmation Bar */}
        {dragSelectionState && dragSelectionState.pendingKeys.length > 0 && (
          <Alert
            className="drag-selection-confirm-bar"
            type="info"
            showIcon
            message={
              <span>
                Выделено строк: <strong>{dragSelectionState.pendingKeys.length}</strong>.
                Подтвердите или отмените выделение на панели действий.
              </span>
            }
            style={{ marginBottom: 8 }}
          />
        )}

        {/* Table — grouping controls are rendered inline on the gear row (right-aligned) */}
        <OrderDetailTable
          ref={tableRef}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onQuickAdd={handleQuickAdd}
          onInsertAfter={handleInsertAfter}
          onCopyRow={handleCopyRow}
          onTransferRows={handleTransferRows}
          getTransferRowsDisabledReason={getTransferRowsDisabledReason}
          selectedRowKeys={selectedRowKeys}
          onSelectChange={handleSelectChange}
          highlightedRowKey={highlightedRowKey}
          onDragSelectionPending={handleDragSelectionPending}
          groupField={grouping.state.field}
          showSeparation={grouping.state.showSeparation}
          cutSelectable={cutEnabled}
          cutJobByDetailId={cutColumnEnabled ? cutJobMaps.cutJobByDetailId : undefined}
          bathCutJobByDetailId={cutColumnEnabled ? cutJobMaps.bathCutJobByDetailId : undefined}
          toolbarActions={
            <>
              <AccessibleToolbarTooltip title="Быстрое добавление">
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  onClick={handleQuickAdd}
                  aria-label="Быстрое добавление"
                >
                  <OrderToolbarLabel>Быстро добавить</OrderToolbarLabel>
                </Button>
              </AccessibleToolbarTooltip>
              <AccessibleToolbarTooltip title="Добавить через форму">
                <Button icon={<PlusOutlined />} onClick={handleCreate} aria-label="Добавить через форму">
                  <OrderToolbarLabel>Добавить</OrderToolbarLabel>
                </Button>
              </AccessibleToolbarTooltip>
              <AccessibleToolbarTooltip title={transferTooltip} disabled={transferDisabled}>
                <Button
                  icon={<SwapOutlined />}
                  onClick={() => setTransferOpen(true)}
                  disabled={transferDisabled}
                  aria-label={transferTooltip}
                >
                  Перенести
                </Button>
              </AccessibleToolbarTooltip>
              <AccessibleToolbarTooltip title="Групповые действия" disabled={details.length === 0}>
                <Button
                  icon={<EditOutlined />}
                  onClick={() => setBulkEditModalOpen(true)}
                  disabled={details.length === 0}
                  aria-label="Групповые действия"
                >
                  <OrderToolbarLabel>Групповые действия</OrderToolbarLabel>
                </Button>
              </AccessibleToolbarTooltip>
              <ImportDropdownButton />
              <AccessibleToolbarTooltip
                title={`Удалить выбранные (${selectedRowKeys.length})`}
                disabled={selectedRowKeys.length === 0}
              >
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  onClick={handleDeleteSelected}
                  disabled={selectedRowKeys.length === 0}
                  aria-label={`Удалить выбранные (${selectedRowKeys.length})`}
                />
              </AccessibleToolbarTooltip>
              <AccessibleToolbarTooltip
                title="Сбросить выделение"
                disabled={selectedRowKeys.length === 0 && !dragSelectionState}
              >
                <Button
                  icon={<ClearOutlined />}
                  onClick={handleClearSelection}
                  disabled={selectedRowKeys.length === 0 && !dragSelectionState}
                  aria-label="Сбросить выделение"
                />
              </AccessibleToolbarTooltip>
              {cutEnabled && (
                <AccessibleToolbarTooltip
                  title={`Добавить выбранные в раскрой (${eligibleCutDetailIds.length})`}
                  disabled={eligibleCutDetailIds.length === 0}
                >
                  <Button
                    icon={<ScissorOutlined />}
                    onClick={() => setAddToCutOpen(true)}
                    disabled={eligibleCutDetailIds.length === 0}
                    aria-label={`Добавить выбранные в раскрой (${eligibleCutDetailIds.length})`}
                  />
                </AccessibleToolbarTooltip>
              )}
              {bazisCutVisible && (() => {
                const disabled = !bazisCutManage || isDirty || isSaving || header?.order_id == null || bazisCutDetailIds.length === 0;
                const reason = isDirty || isSaving
                  ? 'Сначала сохраните изменения заказа'
                  : !bazisCutManage
                    ? 'Недостаточно прав'
                    : `Добавить в Базис раскрой (${bazisCutDetailIds.length})`;
                return (
                  <AccessibleToolbarTooltip title={reason} disabled={disabled}>
                    <Button
                      icon={<TableOutlined />}
                      onClick={() => setAddToBazisCutOpen(true)}
                      disabled={disabled}
                      aria-label="Добавить в Базис раскрой"
                    >
                      <OrderToolbarLabel>В Базис раскрой</OrderToolbarLabel>
                    </Button>
                  </AccessibleToolbarTooltip>
                );
              })()}
              <AccessibleToolbarTooltip title="Обновить" disabled={details.length === 0 || isSaving || isRefreshing || !canRefreshOrder}>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => void handleRefresh()}
                  disabled={details.length === 0 || isSaving || isRefreshing || !canRefreshOrder}
                  loading={isRefreshing}
                  aria-label="Обновить"
                >
                  <OrderToolbarLabel>Обновить</OrderToolbarLabel>
                </Button>
              </AccessibleToolbarTooltip>
              {dragSelectionState && dragSelectionState.pendingKeys.length > 0 && (
                <>
                  <AccessibleToolbarTooltip title="Подтвердить выделение">
                    <Button
                      type="primary"
                      icon={<CheckOutlined />}
                      onClick={handleConfirmDragSelection}
                      aria-label="Подтвердить выделение"
                    >
                      <OrderToolbarLabel>Подтвердить</OrderToolbarLabel>
                    </Button>
                  </AccessibleToolbarTooltip>
                  <AccessibleToolbarTooltip title="Отменить выделение">
                    <Button
                      icon={<CloseOutlined />}
                      onClick={handleCancelDragSelection}
                      aria-label="Отменить выделение"
                    >
                      <OrderToolbarLabel>Отмена</OrderToolbarLabel>
                    </Button>
                  </AccessibleToolbarTooltip>
                </>
              )}
              <span className="order-details-toolbar__summary">
                Всего: {details.length}
                {selectedRowKeys.length > 0 ? ` · выбрано: ${selectedRowKeys.length}` : ''}
              </span>
            </>
          }
          groupingControls={
            <DetailGroupingControls
              state={grouping.state}
              onFieldChange={grouping.setField}
              onToggleSeparation={grouping.setShowSeparation}
            />
          }
        />

        {/* Modal */}
        <OrderLifecycleReadSurface active={modalOpen}>
          <OrderDetailModal
            open={modalOpen}
            mode={modalMode}
            detail={editingDetail}
            onSave={handleSave}
            onCancel={() => {
              cancelDeferredDetailRestore();
              setModalOpen(false);
              setEditingDetail(undefined);
            }}
          />
        </OrderLifecycleReadSurface>

        {/* Bulk Edit Modal */}
        <OrderLifecycleReadSurface active={bulkEditModalOpen}>
          <BulkEditModal
            open={bulkEditModalOpen}
            selectedCount={selectedRowKeys.length}
            totalCount={details.length}
            onApply={handleBulkEditApply}
            onCancel={() => setBulkEditModalOpen(false)}
          />
        </OrderLifecycleReadSurface>

        {/* Add to Cut Modal */}
        {cutEnabled && header?.order_id != null && (
          <OrderLifecycleReadSurface active={addToCutOpen}>
            <AddToCutModal
              open={addToCutOpen}
              orderIds={[header.order_id]}
              orderNames={[header.order_name]}
              detailIds={eligibleCutDetailIds}
              nameSuffix={cutSelectedGroupName}
              onClose={() => setAddToCutOpen(false)}
              onDone={() => { setAddToCutOpen(false); handleSelectChange([]); }}
            />
          </OrderLifecycleReadSurface>
        )}
        {bazisCutVisible && header?.order_id != null && (
          <OrderLifecycleReadSurface active={addToBazisCutOpen}>
            <AddToBazisCutModal
              open={addToBazisCutOpen}
              orderId={header.order_id}
              detailIds={bazisCutDetailIds}
              onClose={() => setAddToBazisCutOpen(false)}
              onDone={() => handleSelectChange([])}
            />
          </OrderLifecycleReadSurface>
        )}
        {header?.order_id != null && (
          <OrderLifecycleReadSurface active={transferOpen}>
            <OrderDetailTransferModal
              open={transferOpen}
              sourceOrderId={header.order_id}
              sourceOrderName={header.order_name || ''}
              sourceVersion={sourceVersion}
              detailIds={transferDetailIds}
              canCreateTarget={canCreateTransferTarget}
              onClose={() => setTransferOpen(false)}
              onDone={handleTransferDone}
            />
          </OrderLifecycleReadSurface>
        )}
      </Space>
    </Card>
  );
});

function isSerializableReactKey(value: React.Key | null | undefined): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function readReactKey(value: unknown): React.Key | null {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : null;
}

function readReactKeys(value: unknown): React.Key[] {
  return Array.isArray(value) ? value.map(readReactKey).filter(isSerializableReactKey) : [];
}

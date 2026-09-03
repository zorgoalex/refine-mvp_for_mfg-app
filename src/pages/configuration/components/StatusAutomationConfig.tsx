import { Table } from '../../../ui/tooltipDelay';
import { DownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import {
  Alert, Button, Card, Checkbox, Collapse, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Switch, Typography, Upload, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/apiError';
import { cncTelegramApi } from '../../../api/cncTelegramApi';
import { statusAutomationApi } from '../../../api/statusAutomationApi';
import type {
  StatusAutomationActionType,
  StatusAutomationEventType,
  StatusAutomationEventTypeDto,
  StatusAutomationOrderSource,
  StatusAutomationRuleDto,
} from '../../../api/types/statusAutomationApi.types';
import { featureFlags } from '../../../config/featureFlags';
import { SETTING_KEYS, useAppSettings } from '../../../hooks/useAppSettings';
import { can } from '../../../utils/permissions';
import {
  DEFAULT_MDF_BOARD_HIDDEN_PRODUCTION_STATUS_NAMES,
  MDF_BOARD_HIDDEN_CARD_KINDS,
  normalizeMdfBoardHiddenCardRules,
  resolveDefaultMdfBoardHiddenOrderStatusIds,
  type MdfBoardHiddenCardKind,
  type MdfBoardHiddenCardRule,
  type MdfBoardHiddenStatusesSetting,
} from '../../orderStatusBoard/model';
import { DeadlineTransitionRulesConfig } from './DeadlineTransitionRulesConfig';
import {
  allowedConditionKeysForEvent,
  addStatusAutomationCondition,
  buildEventTypeSelectOptions,
  buildStatusAutomationRulesExportFile,
  buildCreatePayload,
  buildUpdatePayload,
  describeAction,
  describeConditions,
  describeFormAction,
  describeFormConditions,
  changeStatusAutomationAction,
  changeStatusAutomationEvent,
  isStatusMappingAction,
  planStatusAutomationRulesImport,
  readStatusAutomationRulesImportSource,
  removeStatusAutomationCondition,
  STATUS_AUTOMATION_CONDITION_KEYS,
  statusAutomationConditionIsFilled,
  statusAutomationConditionKeysFromForm,
  validateStatusAutomationRuleBuilder,
  type StatusAutomationConditionKey,
  type StatusAutomationImportIssue,
  type StatusAutomationCatalogs,
  type StatusAutomationFormValues,
  type StatusAutomationStatusCatalog,
} from './statusAutomationView';

const { Text } = Typography;

interface OrderStatusRow {
  order_status_id: number;
  order_status_name: string;
  sort_order?: number;
  is_active?: boolean;
}

interface PaymentStatusRow {
  payment_status_id: number;
  payment_status_name: string;
  sort_order?: number;
  is_active?: boolean;
}

interface ProductionStatusRow {
  production_status_id: number;
  production_status_name: string;
  production_status_code?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

interface MdfBoardHiddenCardRuleRow {
  cardKind: MdfBoardHiddenCardKind;
  title: string;
  target: string;
  orderStatusIds: number[];
}

type EditorMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; rule: StatusAutomationRuleDto };

interface StatusAutomationRulesImportReport {
  createdCount: number;
  skippedDuplicates: StatusAutomationImportIssue[];
  failedRules: StatusAutomationImportIssue[];
}

const ACTION_LABELS: Record<StatusAutomationActionType, string> = {
  change_order_status: 'Изменить статус заказа',
  change_production_status: 'Изменить общий статус производства заказа',
  change_details_production_status: 'Изменить статус всех производственных деталей',
  map_order_status_to_details_production_status: 'Менять статус деталей по статусу заказа',
  map_production_status_to_order_status: 'Менять статус заказа по статусу производства',
};

const SOURCE_OPTIONS: Array<{ value: StatusAutomationOrderSource; label: string }> = [
  { value: 'manual', label: 'Вручную' },
  { value: 'bazis', label: 'Базис' },
  { value: 'import', label: 'Импорт' },
];

const MDF_BOARD_CARD_RULE_LABELS: Record<
  MdfBoardHiddenCardKind,
  { title: string; target: string }
> = {
  packet: { title: 'Файлы станка', target: 'Распиленные файлы' },
  bazisCutSet: { title: 'Базис-раскрой', target: 'Распиленные файлы' },
  bath: { title: 'Карты ванн', target: 'Завершённые ванны' },
};

const ALL_STATUS_FILTER = [{ field: 'is_active', operator: 'in' as const, value: [true, false] }];

type ConditionKey = StatusAutomationConditionKey;

const CONDITION_LABELS: Record<ConditionKey, string> = {
  currentOrderStatusIn: 'Статус заказа — один из',
  currentOrderStatusNotIn: 'Статус заказа — не входит в',
  previousOrderStatusIn: 'Предыдущий статус заказа — один из',
  currentPaymentStatusIn: 'Статус оплаты — один из',
  currentPaymentStatusNotIn: 'Статус оплаты — не входит в',
  currentProductionStatusIn: 'Общий статус производства заказа — один из',
  currentProductionStatusNotIn: 'Общий статус производства заказа — не входит в',
  paidShareGte: 'Оплачено не менее',
  orderSourceIn: 'Источник заказа — один из',
  firstPaymentOnly: 'Это первый платёж по заказу',
};

function emptyForm(eventType: StatusAutomationEventType = 'order.created'): StatusAutomationFormValues {
  return {
    name: '',
    eventType,
    actionType: 'change_order_status',
    targetStatusId: null,
    statusMappingEntries: [{ sourceStatusIds: [], targetStatusId: 0 }],
    detailTransitionMode: 'set_exact',
    currentOrderStatusIn: [],
    currentOrderStatusNotIn: [],
    previousOrderStatusIn: [],
    currentPaymentStatusIn: [],
    currentPaymentStatusNotIn: [],
    currentProductionStatusIn: [],
    currentProductionStatusNotIn: [],
    paidShareGte: undefined,
    orderSourceIn: [],
    firstPaymentOnly: undefined,
    priority: 100,
    isEnabled: false,
  };
}

function formFromRule(rule: StatusAutomationRuleDto): StatusAutomationFormValues {
  return {
    name: rule.name,
    eventType: rule.eventType,
    actionType: rule.actionType,
    targetStatusId: rule.targetStatusId,
    statusMappingEntries: rule.actionConfig?.statusMapping?.entries.map((entry) => ({
      sourceStatusIds: [...entry.sourceStatusIds],
      targetStatusId: entry.targetStatusId,
    })) ?? [{ sourceStatusIds: [], targetStatusId: 0 }],
    detailTransitionMode: rule.actionConfig?.detailTransitionMode ?? 'set_exact',
    currentOrderStatusIn: [...(rule.conditions.currentOrderStatusIn ?? [])],
    currentOrderStatusNotIn: [...(rule.conditions.currentOrderStatusNotIn ?? [])],
    previousOrderStatusIn: [...(rule.conditions.previousOrderStatusIn ?? [])],
    currentPaymentStatusIn: [...(rule.conditions.currentPaymentStatusIn ?? [])],
    currentPaymentStatusNotIn: [...(rule.conditions.currentPaymentStatusNotIn ?? [])],
    currentProductionStatusIn: [...(rule.conditions.currentProductionStatusIn ?? [])],
    currentProductionStatusNotIn: [
      ...(rule.conditions.currentProductionStatusNotIn ?? []),
    ],
    paidShareGte: rule.conditions.paidShareGte,
    orderSourceIn: [...(rule.conditions.orderSourceIn ?? [])],
    firstPaymentOnly: rule.conditions.firstPaymentOnly,
    priority: rule.priority,
    isEnabled: rule.isEnabled,
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

function normalizeStatusIds(value: readonly unknown[] | null | undefined): number[] {
  const ids = new Set<number>();
  for (const item of value ?? []) {
    const numeric = typeof item === 'number' ? item : Number(item);
    if (Number.isInteger(numeric) && numeric > 0) ids.add(numeric);
  }
  return Array.from(ids).sort((left, right) => left - right);
}

function statusIdsEqual(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function cardRulesEqual(
  left: readonly MdfBoardHiddenCardRule[],
  right: readonly MdfBoardHiddenCardRule[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((rule, index) =>
    rule.cardKind === right[index]?.cardKind
    && statusIdsEqual(rule.orderStatusIds, right[index]?.orderStatusIds ?? []));
}

export function StatusAutomationConfig() {
  const canView = !featureFlags.useBackendPermissions || can('status_automation.view');
  const canManage = !featureFlags.useBackendPermissions || can('status_automation.manage');

  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<StatusAutomationRuleDto[]>([]);
  const [eventTypes, setEventTypes] = useState<StatusAutomationEventTypeDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorMode>({ kind: 'closed' });
  const [form, setForm] = useState<StatusAutomationFormValues>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [rulesImporting, setRulesImporting] = useState(false);
  const [refreshingRecentOrders, setRefreshingRecentOrders] = useState(false);
  const [rulesImportReport, setRulesImportReport] =
    useState<StatusAutomationRulesImportReport | null>(null);
  const [autoCutStatusSaving, setAutoCutStatusSaving] = useState(false);
  const [autoCutStatusEnabled, setAutoCutStatusEnabled] = useState(false);
  const [confirmedAutoCutStatusEnabled, setConfirmedAutoCutStatusEnabled] =
    useState<boolean | null>(null);
  const [mdfBoardHiddenStatusesSaving, setMdfBoardHiddenStatusesSaving] = useState(false);
  const [mdfBoardHiddenProductionStatusIds, setMdfBoardHiddenProductionStatusIds] =
    useState<number[]>([]);
  const [mdfBoardHiddenOrderStatusIds, setMdfBoardHiddenOrderStatusIds] = useState<number[]>([]);
  const [mdfBoardHiddenCardRules, setMdfBoardHiddenCardRules] =
    useState<MdfBoardHiddenCardRule[]>([]);
  const [deletingRuleId, setDeletingRuleId] = useState<number | null>(null);
  const [updatingRuleId, setUpdatingRuleId] = useState<number | null>(null);
  const [activeConditionKeys, setActiveConditionKeys] = useState<ConditionKey[]>([]);
  const {
    getSetting,
    saveSetting,
    refetch: refetchAppSettings,
    isLoading: appSettingsLoading,
  } = useAppSettings({ enabled: canView });

  const { data: orderStatusesData, isLoading: orderStatusesLoading, error: orderStatusesError } =
    useList<OrderStatusRow>({
      resource: 'order_statuses',
      pagination: { pageSize: 200 },
      filters: ALL_STATUS_FILTER,
      sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'order_status_id', order: 'asc' }],
      queryOptions: { enabled: canView },
    });
  const {
    data: paymentStatusesData,
    isLoading: paymentStatusesLoading,
    error: paymentStatusesError,
  } = useList<PaymentStatusRow>({
    resource: 'payment_statuses',
    pagination: { pageSize: 200 },
    filters: ALL_STATUS_FILTER,
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'payment_status_id', order: 'asc' }],
    queryOptions: { enabled: canView },
  });
  const {
    data: productionStatusesData,
    isLoading: productionStatusesLoading,
    error: productionStatusesError,
  } = useList<ProductionStatusRow>({
    resource: 'production_statuses',
    pagination: { pageSize: 200 },
    filters: ALL_STATUS_FILTER,
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
    queryOptions: { enabled: canView },
  });

  const orderStatusOptions = useMemo(
    () =>
      (orderStatusesData?.data ?? []).map((status) => ({
        value: status.order_status_id,
        label: status.order_status_name,
      })),
    [orderStatusesData],
  );
  const activeOrderStatusOptions = useMemo(
    () =>
      (orderStatusesData?.data ?? [])
        .filter((status) => status.is_active !== false)
        .map((status) => ({
          value: status.order_status_id,
          label: status.order_status_name,
        })),
    [orderStatusesData],
  );
  const paymentStatusOptions = useMemo(
    () =>
      (paymentStatusesData?.data ?? []).map((status) => ({
        value: status.payment_status_id,
        label: status.payment_status_name,
      })),
    [paymentStatusesData],
  );
  const activePaymentStatusOptions = useMemo(
    () =>
      (paymentStatusesData?.data ?? [])
        .filter((status) => status.is_active !== false)
        .map((status) => ({
          value: status.payment_status_id,
          label: status.payment_status_name,
        })),
    [paymentStatusesData],
  );
  const productionStatusOptions = useMemo(
    () =>
      (productionStatusesData?.data ?? []).map((status) => ({
        value: status.production_status_id,
        label: status.production_status_name,
      })),
    [productionStatusesData],
  );
  const activeProductionStatusOptions = useMemo(
    () =>
      (productionStatusesData?.data ?? [])
        .filter((status) => status.is_active !== false)
        .map((status) => ({
          value: status.production_status_id,
          label: status.production_status_name,
        })),
    [productionStatusesData],
  );
  const cutProductionStatusAvailable = useMemo(
    () => (productionStatusesData?.data ?? []).some((status) =>
      status.is_active !== false
      && (
        status.production_status_name.trim().toLocaleLowerCase('ru-RU') === 'распилен'
        || status.production_status_code?.trim().toLocaleLowerCase('ru-RU') === 'cut'
      ),
    ),
    [productionStatusesData],
  );
  const storedAutoCutStatusEnabled =
    getSetting<boolean>(SETTING_KEYS.STATUS_AUTOMATION_CNC_MARK_CUT_DETAILS) === true;
  const storedMdfBoardHiddenStatusSetting =
    getSetting<MdfBoardHiddenStatusesSetting>(
      SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES,
    );
  const defaultMdfBoardHiddenProductionStatusIds = useMemo(() => {
    const defaultNames = new Set<string>(DEFAULT_MDF_BOARD_HIDDEN_PRODUCTION_STATUS_NAMES);
    return normalizeStatusIds(
      (productionStatusesData?.data ?? [])
        .filter((status) => defaultNames.has(
          status.production_status_name.trim().toLocaleLowerCase('ru-RU'),
        ))
        .map((status) => status.production_status_id),
    );
  }, [productionStatusesData]);
  const defaultMdfBoardHiddenOrderStatusIds = useMemo(
    () => resolveDefaultMdfBoardHiddenOrderStatusIds(
      (orderStatusesData?.data ?? []).map((status) => ({
        id: status.order_status_id,
        name: status.order_status_name,
        sortOrder: status.sort_order,
      })),
    ),
    [orderStatusesData],
  );
  const storedMdfBoardHiddenProductionStatusIds = useMemo(
    () => normalizeStatusIds(storedMdfBoardHiddenStatusSetting?.productionStatusIds),
    [storedMdfBoardHiddenStatusSetting],
  );
  const storedMdfBoardHiddenOrderStatusIds = useMemo(
    () => normalizeStatusIds(storedMdfBoardHiddenStatusSetting?.orderStatusIds),
    [storedMdfBoardHiddenStatusSetting],
  );
  const effectiveMdfBoardHiddenProductionStatusIds =
    storedMdfBoardHiddenStatusSetting && Array.isArray(storedMdfBoardHiddenStatusSetting.productionStatusIds)
      ? storedMdfBoardHiddenProductionStatusIds
      : defaultMdfBoardHiddenProductionStatusIds;
  const effectiveMdfBoardHiddenOrderStatusIds =
    storedMdfBoardHiddenStatusSetting && Array.isArray(storedMdfBoardHiddenStatusSetting.orderStatusIds)
      ? storedMdfBoardHiddenOrderStatusIds
      : defaultMdfBoardHiddenOrderStatusIds;
  const defaultMdfBoardHiddenCardRules = useMemo(
    () => MDF_BOARD_HIDDEN_CARD_KINDS.map((cardKind) => ({
      cardKind,
      orderStatusIds: [...defaultMdfBoardHiddenOrderStatusIds],
    })),
    [defaultMdfBoardHiddenOrderStatusIds],
  );
  const effectiveMdfBoardHiddenCardRules = useMemo(
    () => Array.isArray(storedMdfBoardHiddenStatusSetting?.cardRules)
      ? normalizeMdfBoardHiddenCardRules(storedMdfBoardHiddenStatusSetting)
      : normalizeMdfBoardHiddenCardRules(
          null,
          effectiveMdfBoardHiddenOrderStatusIds,
        ),
    [effectiveMdfBoardHiddenOrderStatusIds, storedMdfBoardHiddenStatusSetting],
  );
  const mdfBoardHiddenStatusesDirty = !statusIdsEqual(
    mdfBoardHiddenProductionStatusIds,
    effectiveMdfBoardHiddenProductionStatusIds,
  ) || !statusIdsEqual(
    mdfBoardHiddenOrderStatusIds,
    effectiveMdfBoardHiddenOrderStatusIds,
  ) || !cardRulesEqual(
    mdfBoardHiddenCardRules,
    effectiveMdfBoardHiddenCardRules,
  );
  const mdfBoardHiddenCardRuleRows = useMemo<MdfBoardHiddenCardRuleRow[]>(
    () => MDF_BOARD_HIDDEN_CARD_KINDS.map((cardKind) => {
      const rule = mdfBoardHiddenCardRules.find((candidate) => candidate.cardKind === cardKind);
      return {
        cardKind,
        orderStatusIds: rule?.orderStatusIds ?? [],
        ...MDF_BOARD_CARD_RULE_LABELS[cardKind],
      };
    }),
    [mdfBoardHiddenCardRules],
  );
  const catalogs = useMemo<StatusAutomationCatalogs>(
    () => ({
      orderStatusNames: new Map(orderStatusOptions.map((option) => [option.value, option.label])),
      paymentStatusNames: new Map(paymentStatusOptions.map((option) => [option.value, option.label])),
      productionStatusNames: new Map(
        productionStatusOptions.map((option) => [option.value, option.label]),
      ),
    }),
    [orderStatusOptions, paymentStatusOptions, productionStatusOptions],
  );
  const importStatusCatalog = useMemo<StatusAutomationStatusCatalog>(
    () => {
      const orderStatusRows = orderStatusesData?.data ?? [];
      const paymentStatusRows = paymentStatusesData?.data ?? [];
      const productionStatusRows = productionStatusesData?.data ?? [];
      return {
        orderStatusIds: new Set(orderStatusRows.map((status) => status.order_status_id)),
        activeOrderStatusIds: new Set(
          orderStatusRows
            .filter((status) => status.is_active !== false)
            .map((status) => status.order_status_id),
        ),
        paymentStatusIds: new Set(paymentStatusRows.map((status) => status.payment_status_id)),
        productionStatusIds: new Set(
          productionStatusRows.map((status) => status.production_status_id),
        ),
        activeProductionStatusIds: new Set(
          productionStatusRows
            .filter((status) => status.is_active !== false)
            .map((status) => status.production_status_id),
        ),
      };
    },
    [orderStatusesData, paymentStatusesData, productionStatusesData],
  );

  const eventTypeByName = useMemo(
    () => new Map(eventTypes.map((eventType) => [eventType.eventType, eventType])),
    [eventTypes],
  );
  const eventTypeOptions = useMemo(() => buildEventTypeSelectOptions(eventTypes), [eventTypes]);
  const selectedEvent = editor.kind === 'closed' ? null : eventTypeByName.get(form.eventType) ?? null;
  const allowedConditionKeys = allowedConditionKeysForEvent(selectedEvent);
  const allowedConditionSet = useMemo(() => new Set(allowedConditionKeys), [allowedConditionKeys]);
  const mappingAction = isStatusMappingAction(form.actionType);
  const targetStatusOptions =
    form.actionType === 'change_order_status'
      ? activeOrderStatusOptions
      : activeProductionStatusOptions;
  const mappingSourceOptions =
    form.actionType === 'map_order_status_to_details_production_status'
      ? activeOrderStatusOptions
      : activeProductionStatusOptions;
  const mappingTargetOptions =
    form.actionType === 'map_order_status_to_details_production_status'
      ? activeProductionStatusOptions
      : activeOrderStatusOptions;
  const targetStatusQuestion =
    form.actionType === 'change_order_status'
      ? 'Какой статус установить заказу?'
      : form.actionType === 'change_details_production_status'
        ? 'Какой статус установить всем деталям?'
        : 'Какой общий статус производства установить?';
  const availableConditionOptions = STATUS_AUTOMATION_CONDITION_KEYS
    .filter((key) => allowedConditionSet.has(key) && !activeConditionKeys.includes(key))
    .map((key) => ({ value: key, label: CONDITION_LABELS[key] }));
  const builderErrors = validateStatusAutomationRuleBuilder(
    { form, activeConditionKeys },
    selectedEvent,
  );
  const rulePreviewComplete = builderErrors.length === 0;

  const loadRules = useCallback(async () => {
    if (!canView) {
      setRules([]);
      setEventTypes([]);
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const [loadedRules, loadedEventTypes] = await Promise.all([
        statusAutomationApi.list(),
        statusAutomationApi.listEventTypes(),
      ]);
      setRules(loadedRules);
      setEventTypes(loadedEventTypes);
    } catch (error) {
      const text = errorText(error, 'Не удалось загрузить правила автостатусов');
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  useEffect(() => {
    if (autoCutStatusSaving) return;
    if (confirmedAutoCutStatusEnabled !== null) {
      setAutoCutStatusEnabled(confirmedAutoCutStatusEnabled);
      if (storedAutoCutStatusEnabled === confirmedAutoCutStatusEnabled) {
        setConfirmedAutoCutStatusEnabled(null);
      }
      return;
    }
    setAutoCutStatusEnabled(storedAutoCutStatusEnabled);
  }, [autoCutStatusSaving, confirmedAutoCutStatusEnabled, storedAutoCutStatusEnabled]);

  useEffect(() => {
    if (mdfBoardHiddenStatusesSaving) return;
    setMdfBoardHiddenProductionStatusIds(effectiveMdfBoardHiddenProductionStatusIds);
    setMdfBoardHiddenOrderStatusIds(effectiveMdfBoardHiddenOrderStatusIds);
    setMdfBoardHiddenCardRules(effectiveMdfBoardHiddenCardRules);
  }, [
    effectiveMdfBoardHiddenCardRules,
    effectiveMdfBoardHiddenOrderStatusIds,
    effectiveMdfBoardHiddenProductionStatusIds,
    mdfBoardHiddenStatusesSaving,
  ]);

  useEffect(() => {
    const catalogError = orderStatusesError ?? paymentStatusesError ?? productionStatusesError;
    if (catalogError) {
      message.error(errorText(catalogError, 'Не удалось загрузить справочник статусов'));
    }
  }, [orderStatusesError, paymentStatusesError, productionStatusesError]);

  const updateForm = (patch: Partial<StatusAutomationFormValues>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const openCreate = () => {
    const eventType =
      eventTypes.find((candidate) => candidate.eventType === 'order.created')?.eventType ??
      eventTypes[0]?.eventType ??
      'order.created';
    const descriptor = eventTypeByName.get(eventType);
    const firstAction = descriptor?.allowedActions[0] ?? 'change_order_status';
    setForm({ ...emptyForm(eventType), actionType: firstAction });
    setActiveConditionKeys([]);
    setEditor({ kind: 'create' });
  };

  const openEdit = (rule: StatusAutomationRuleDto) => {
    const nextForm = formFromRule(rule);
    setForm(nextForm);
    setActiveConditionKeys(statusAutomationConditionKeysFromForm(nextForm));
    setEditor({ kind: 'edit', rule });
  };

  const closeEditor = () => {
    setEditor({ kind: 'closed' });
    setForm(emptyForm());
    setActiveConditionKeys([]);
  };

  const handleEventChange = (eventType: StatusAutomationEventType) => {
    const descriptor = eventTypeByName.get(eventType);
    if (!descriptor) {
      updateForm({ eventType });
      return;
    }
    const next = changeStatusAutomationEvent({ form, activeConditionKeys }, descriptor);
    setForm(next.form);
    setActiveConditionKeys(next.activeConditionKeys);
  };

  const handleActionChange = (actionType: StatusAutomationActionType) => {
    setForm((current) => changeStatusAutomationAction(current, actionType));
  };

  const updateMappingEntry = (
    index: number,
    patch: Partial<{ sourceStatusIds: number[]; targetStatusId: number }>,
  ) => {
    setForm((current) => ({
      ...current,
      statusMappingEntries: (current.statusMappingEntries ?? []).map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    }));
  };

  const addMappingEntry = () => {
    setForm((current) => ({
      ...current,
      statusMappingEntries: [...(current.statusMappingEntries ?? []), { sourceStatusIds: [], targetStatusId: 0 }],
    }));
  };

  const removeMappingEntry = (index: number) => {
    setForm((current) => ({
      ...current,
      statusMappingEntries: (current.statusMappingEntries ?? []).length <= 1
        ? [{ sourceStatusIds: [], targetStatusId: 0 }]
        : (current.statusMappingEntries ?? []).filter((_, entryIndex) => entryIndex !== index),
    }));
  };

  const addCondition = (key: ConditionKey) => {
    const next = addStatusAutomationCondition({ form, activeConditionKeys }, key);
    setForm(next.form);
    setActiveConditionKeys(next.activeConditionKeys);
  };

  const removeCondition = (key: ConditionKey) => {
    const next = removeStatusAutomationCondition({ form, activeConditionKeys }, key);
    setForm(next.form);
    setActiveConditionKeys(next.activeConditionKeys);
  };

  const handleSave = async () => {
    if (builderErrors.length > 0) {
      message.warning(builderErrors[0]);
      return;
    }

    setSaving(true);
    try {
      if (editor.kind === 'create') {
        const created = await statusAutomationApi.create(buildCreatePayload(form));
        setRules((current) => [...current, created]);
        message.success('Правило создано');
      } else if (editor.kind === 'edit') {
        const updated = await statusAutomationApi.update(
          editor.rule.id,
          buildUpdatePayload(editor.rule, form),
        );
        setRules((current) =>
          current.map((rule) => (rule.id === updated.id ? updated : rule)),
        );
        message.success('Правило сохранено');
      }
      closeEditor();
    } catch (error) {
      message.error(
        isConflict(error)
          ? 'Правило изменено параллельно, обновите список'
          : errorText(error, 'Не удалось сохранить правило'),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: StatusAutomationRuleDto, isEnabled: boolean) => {
    setUpdatingRuleId(rule.id);
    try {
      const updated = await statusAutomationApi.update(rule.id, {
        isEnabled,
        version: rule.version,
      });
      setRules((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      message.error(
        isConflict(error)
          ? 'Правило изменено параллельно, обновите список'
          : errorText(error, 'Не удалось изменить состояние правила'),
      );
    } finally {
      setUpdatingRuleId(null);
    }
  };

  const handleDelete = async (rule: StatusAutomationRuleDto) => {
    setDeletingRuleId(rule.id);
    try {
      await statusAutomationApi.remove(rule.id);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      message.success('Правило удалено');
    } catch (error) {
      message.error(errorText(error, 'Не удалось удалить правило'));
    } finally {
      setDeletingRuleId(null);
    }
  };

  const handleRulesExport = () => {
    const exportFile = buildStatusAutomationRulesExportFile(rules);
    const blob = new Blob([JSON.stringify(exportFile, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `status-automation-rules-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    message.success(`Выгружено правил: ${exportFile.rules.length}`);
  };

  const handleRulesImport = async (file: File) => {
    setRulesImporting(true);
    try {
      const parsedJson = JSON.parse(await file.text()) as unknown;
      const rawRules = readStatusAutomationRulesImportSource(parsedJson);
      const importPlan = planStatusAutomationRulesImport(rawRules, {
        existingRules: rules,
        eventTypes,
        statusCatalog: importStatusCatalog,
      });
      const failedRules = [...importPlan.failedRules];
      let createdCount = 0;

      for (const item of importPlan.rulesToCreate) {
        try {
          await statusAutomationApi.create(item.rule);
          createdCount += 1;
        } catch (error) {
          failedRules.push({
            index: item.index,
            name: item.name,
            reasons: [errorText(error, 'Не удалось создать правило')],
          });
        }
      }

      if (createdCount > 0) {
        await loadRules();
      }
      setRulesImportReport({
        createdCount,
        skippedDuplicates: importPlan.skippedDuplicates,
        failedRules,
      });

      if (createdCount > 0) {
        message.success(`Загружено правил: ${createdCount}`);
      } else if (failedRules.length > 0) {
        message.warning('Правила не загружены, проверьте отчет');
      } else {
        message.info('Новых правил для загрузки нет');
      }
    } catch (error) {
      message.error(errorText(error, 'Не удалось прочитать JSON-файл правил'));
    } finally {
      setRulesImporting(false);
    }
  };

  const handleRefreshRecentOrders = async () => {
    setRefreshingRecentOrders(true);
    try {
      const result = await statusAutomationApi.refreshRecentOrders();
      const text =
        `Автостатусы проверены: заказов ${result.processedOrderCount}/${result.orderCount}, `
        + `действий ${result.totals.executedActionCount}`;
      if (result.failedOrderCount > 0) {
        message.warning(`${text}. Ошибок: ${result.failedOrderCount}`);
      } else {
        message.success(text);
      }
    } catch (error) {
      message.error(errorText(error, 'Не удалось запустить проверку автостатусов'));
    } finally {
      setRefreshingRecentOrders(false);
    }
  };

  const handleAutoCutStatusToggle = async (enabled: boolean) => {
    if (enabled && !cutProductionStatusAvailable) {
      message.warning('Сначала добавьте активный производственный статус «Распилен»');
      return;
    }
    const previous = autoCutStatusEnabled;
    setAutoCutStatusEnabled(enabled);
    setAutoCutStatusSaving(true);
    try {
      const result = await cncTelegramApi.configureAutoCutStatus(enabled);
      setConfirmedAutoCutStatusEnabled(result.settingEnabled);
      setAutoCutStatusEnabled(result.settingEnabled);
      await refetchAppSettings().catch(() => undefined);
      message.success(
        enabled
          ? result.changedDetailCount > 0
            ? `Автостатус распила включён. Обновлено деталей: ${result.changedDetailCount}, заказов: ${result.changedOrderCount}`
            : 'Автостатус распила включён. Существующие карточки уже обработаны'
          : 'Автостатус распила выключен',
      );
    } catch (error) {
      setAutoCutStatusEnabled(previous);
      message.error(errorText(error, 'Не удалось сохранить настройку автостатуса распила'));
    } finally {
      setAutoCutStatusSaving(false);
    }
  };

  const handleMdfBoardHiddenStatusesSave = async () => {
    setMdfBoardHiddenStatusesSaving(true);
    const nextProductionStatusIds = normalizeStatusIds(mdfBoardHiddenProductionStatusIds);
    const nextOrderStatusIds = normalizeStatusIds(mdfBoardHiddenOrderStatusIds);
    const nextCardRules = normalizeMdfBoardHiddenCardRules({
      cardRules: mdfBoardHiddenCardRules,
    });
    setMdfBoardHiddenProductionStatusIds(nextProductionStatusIds);
    setMdfBoardHiddenOrderStatusIds(nextOrderStatusIds);
    setMdfBoardHiddenCardRules(nextCardRules);
    try {
      await saveSetting(
        SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES,
        {
          productionStatusIds: nextProductionStatusIds,
          orderStatusIds: nextOrderStatusIds,
          cardRules: nextCardRules,
        },
        'Правила автопереноса карточек МДФ-доски в служебные колонки',
      );
      message.success('Настройка МДФ-доски сохранена');
    } catch (error) {
      message.error(errorText(error, 'Не удалось сохранить настройку МДФ-доски'));
    } finally {
      setMdfBoardHiddenStatusesSaving(false);
    }
  };

  const handleMdfBoardHiddenStatusesReset = () => {
    setMdfBoardHiddenProductionStatusIds(defaultMdfBoardHiddenProductionStatusIds);
    setMdfBoardHiddenOrderStatusIds(defaultMdfBoardHiddenOrderStatusIds);
    setMdfBoardHiddenCardRules(defaultMdfBoardHiddenCardRules);
  };

  const updateMdfBoardHiddenCardRule = (
    cardKind: MdfBoardHiddenCardKind,
    orderStatusIds: readonly unknown[],
  ) => {
    const nextOrderStatusIds = normalizeStatusIds(orderStatusIds);
    setMdfBoardHiddenCardRules((current) =>
      normalizeMdfBoardHiddenCardRules({
        cardRules: normalizeMdfBoardHiddenCardRules({ cardRules: current }).map((rule) =>
          rule.cardKind === cardKind
            ? { ...rule, orderStatusIds: nextOrderStatusIds }
            : rule,
        ),
      }));
  };

  if (!canView) {
    return (
      <Alert
        type="info"
        showIcon
        message="Нет доступа к настройкам автостатусов"
        description="Для просмотра нужен status_automation.view."
      />
    );
  }

  const catalogsLoading = orderStatusesLoading || paymentStatusesLoading || productionStatusesLoading;
  const editorOpen = editor.kind !== 'closed';
  const editorTitle = editor.kind === 'create' ? 'Новое правило автостатусов' : 'Изменить правило';
  const rulesImportDisabled =
    !canManage || loading || catalogsLoading || rulesImporting || eventTypes.length === 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', padding: '16px 0' }}>
      <Card size="small" title="Автостатус распила">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space
            wrap
            style={{ width: '100%', justifyContent: 'space-between' }}
            align="center"
          >
            <div style={{ flex: 1, minWidth: 260 }}>
              <Text strong>Детали из завершённых файлов станка</Text>
              <br />
              <Text type="secondary">
                При переходе карточки в «Распилено» ставить статус «Распилен» только её деталям.
                Комментарий «весь заказ» применяет статус ко всем деталям указанного заказа.
                При включении уже находящиеся в «Распилено» карточки обрабатываются сразу.
              </Text>
            </div>
            <Switch
              checked={autoCutStatusEnabled}
              loading={autoCutStatusSaving || appSettingsLoading}
              disabled={!canManage || appSettingsLoading || (!cutProductionStatusAvailable && !autoCutStatusEnabled)}
              aria-label="Автоматически отмечать распиленными детали завершённых файлов станка"
              onChange={(checked) => void handleAutoCutStatusToggle(checked)}
            />
          </Space>
          {!cutProductionStatusAvailable && !productionStatusesLoading && (
            <Alert
              type="warning"
              showIcon
              message="Производственный статус «Распилен» не найден"
              description="Создайте или активируйте этот статус, чтобы включить автоматизацию."
            />
          )}
        </Space>
      </Card>

      <Card size="small" title="МДФ-доска">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">
            Карточка переносится в служебную колонку, если все заказы на этой карточке
            находятся в одном из выбранных обычных статусов заказа.
          </Text>
          <Table<MdfBoardHiddenCardRuleRow>
            size="small"
            pagination={false}
            rowKey="cardKind"
            dataSource={mdfBoardHiddenCardRuleRows}
            columns={[
              {
                title: 'Тип карточки',
                dataIndex: 'title',
                key: 'title',
                width: 190,
                render: (value, row) => (
                  <Space direction="vertical" size={0}>
                    <Text strong>{value}</Text>
                    <Text type="secondary">→ {row.target}</Text>
                  </Space>
                ),
              },
              {
                title: 'Переносить, когда все заказы в статусах',
                key: 'orderStatusIds',
                render: (_, row) => (
                  <Select<number[]>
                    mode="multiple"
                    value={row.orderStatusIds}
                    onChange={(value) => updateMdfBoardHiddenCardRule(
                      row.cardKind,
                      value,
                    )}
                    options={orderStatusOptions}
                    disabled={!canManage || appSettingsLoading || orderStatusesLoading}
                    loading={appSettingsLoading || orderStatusesLoading}
                    placeholder="Выберите статусы заказа"
                    style={{ width: '100%' }}
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    maxTagCount="responsive"
                    aria-label={`Статусы заказа для переноса карточек ${row.title}`}
                  />
                ),
              },
            ]}
          />
          <Text type="secondary">
            Статусы ниже скрывают карточки заказов с МДФ-доски: если заказ имеет
            любой из выбранных обычных или производственных статусов, его карточка
            убирается из активных колонок. Статусы, которых нет в этих списках,
            сами по себе карточку не скрывают.
          </Text>
          <div>
            <Text strong>Обычные статусы заказа, скрывающие карточки</Text>
            <Select<number[]>
              mode="multiple"
              value={mdfBoardHiddenOrderStatusIds}
              onChange={(value) => setMdfBoardHiddenOrderStatusIds(normalizeStatusIds(value))}
              options={orderStatusOptions}
              disabled={!canManage || appSettingsLoading || orderStatusesLoading}
              loading={appSettingsLoading || orderStatusesLoading}
              placeholder="Выберите статусы заказа, которые убирают карточки"
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              aria-label="Статусы заказа, скрывающие карточки с МДФ-доски"
            />
          </div>
          <div>
            <Text strong>Производственные статусы, скрывающие карточки</Text>
            <Select<number[]>
              mode="multiple"
              value={mdfBoardHiddenProductionStatusIds}
              onChange={(value) => setMdfBoardHiddenProductionStatusIds(
                normalizeStatusIds(value),
              )}
              options={productionStatusOptions}
              disabled={!canManage || appSettingsLoading || productionStatusesLoading}
              loading={appSettingsLoading || productionStatusesLoading}
              placeholder="Выберите производственные статусы, которые убирают карточки"
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              aria-label="Производственные статусы, скрывающие карточки с МДФ-доски"
            />
          </div>
          <Space wrap style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button
              onClick={handleMdfBoardHiddenStatusesReset}
              disabled={
                !canManage
                || appSettingsLoading
                || orderStatusesLoading
                || productionStatusesLoading
                || mdfBoardHiddenStatusesSaving
              }
            >
              По умолчанию
            </Button>
            <Button
              type="primary"
              loading={mdfBoardHiddenStatusesSaving}
              disabled={!canManage || appSettingsLoading || !mdfBoardHiddenStatusesDirty}
              onClick={() => void handleMdfBoardHiddenStatusesSave()}
            >
              Сохранить
            </Button>
          </Space>
        </Space>
      </Card>

      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Text strong>Правила автостатусов</Text>
        <Space wrap>
          <Button
            icon={<DownloadOutlined />}
            onClick={handleRulesExport}
            disabled={loading || rules.length === 0}
          >
            Выгрузить JSON
          </Button>
          {canManage && (
            <Popconfirm
              title="Обновить автостатусы"
              description="Будут проверены все заказы за последние два месяца через все включённые правила."
              okText="Обновить"
              cancelText="Отмена"
              onConfirm={() => void handleRefreshRecentOrders()}
              disabled={refreshingRecentOrders}
            >
              <Button
                icon={<ReloadOutlined />}
                loading={refreshingRecentOrders}
                disabled={refreshingRecentOrders || loading || eventTypes.length === 0}
              >
                Обновить
              </Button>
            </Popconfirm>
          )}
          {canManage && (
            <Upload
              accept=".json,application/json"
              showUploadList={false}
              disabled={rulesImportDisabled}
              beforeUpload={(file) => {
                void handleRulesImport(file);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={rulesImporting} disabled={rulesImportDisabled}>
                Загрузить JSON
              </Button>
            </Upload>
          )}
          {canManage && (
            <Button type="primary" onClick={openCreate} disabled={eventTypes.length === 0}>
              Создать правило
            </Button>
          )}
        </Space>
      </Space>

      {loading || catalogsLoading ? (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : loadError ? (
        <Alert
          type="error"
          showIcon
          message="Ошибка загрузки правил автостатусов"
          description={loadError}
          action={<Button onClick={() => void loadRules()}>Повторить</Button>}
        />
      ) : rules.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={canManage ? 'Правил пока нет' : 'Нет опубликованных правил'}
        />
      ) : (
        <Table<StatusAutomationRuleDto>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={rules}
          scroll={{ x: 1100 }}
          columns={[
            {
              title: 'Название',
              dataIndex: 'name',
              key: 'name',
              width: 200,
            },
            {
              title: 'Событие',
              key: 'eventType',
              width: 190,
              render: (_, rule) => eventTypeByName.get(rule.eventType)?.title ?? rule.eventType,
            },
            {
              title: 'Условия',
              key: 'conditions',
              width: 310,
              render: (_, rule) => describeConditions(rule.conditions, catalogs),
            },
            {
              title: 'Результат',
              key: 'action',
              width: 250,
              render: (_, rule) => `${ACTION_LABELS[rule.actionType] ?? rule.actionType} → ${describeAction(rule, catalogs)}`,
            },
            {
              title: 'Приоритет',
              dataIndex: 'priority',
              key: 'priority',
              width: 100,
            },
            {
              title: 'Вкл',
              key: 'isEnabled',
              width: 70,
              render: (_, rule) => (
                <Switch
                  size="small"
                  checked={rule.isEnabled}
                  loading={updatingRuleId === rule.id}
                  disabled={!canManage}
                  onChange={(checked) => void handleToggle(rule, checked)}
                />
              ),
            },
            {
              title: '',
              key: 'actions',
              width: 170,
              render: (_, rule) => (
                <Space size={4}>
                  {canManage && (
                    <Button size="small" onClick={() => openEdit(rule)}>
                      Изменить
                    </Button>
                  )}
                  {canManage && (
                    <Popconfirm
                      title="Удалить правило?"
                      onConfirm={() => void handleDelete(rule)}
                      okText="Удалить"
                      cancelText="Отмена"
                    >
                      <Button size="small" danger loading={deletingRuleId === rule.id}>
                        Удалить
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}

      <Modal
        title={editorTitle}
        open={editorOpen}
        onCancel={closeEditor}
        onOk={() => void handleSave()}
        okButtonProps={{ loading: saving, disabled: !canManage }}
        okText={editor.kind === 'create' ? 'Создать правило' : 'Сохранить'}
        cancelText="Отмена"
        width={840}
        bodyStyle={{
          maxHeight: 'calc(100vh - 180px)',
          overflowY: 'auto',
          paddingRight: 6,
        }}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item
            label="Название правила"
            required
            extra="Коротко опишите результат, чтобы правило было легко найти в списке."
          >
            <Input
              aria-label="Название правила"
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              maxLength={200}
              placeholder="Например: первый платёж подтверждает заказ"
            />
          </Form.Item>

          <Card size="small" title="1. Когда запускать правило?" style={{ marginBottom: 12 }}>
            <Form.Item
              label="Какое событие запускает проверку?"
              required
              style={{ marginBottom: 0 }}
              extra="Условия будут проверены сразу после этого события."
            >
              <Select<StatusAutomationEventType>
                aria-label="Событие, запускающее правило"
                value={form.eventType}
                onChange={handleEventChange}
                options={eventTypeOptions}
                style={{ width: '100%' }}
                placeholder="Выберите событие"
                showSearch
                optionFilterProp="label"
              />
              {selectedEvent?.description?.trim() ? (
                <Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                  {selectedEvent.description}
                </Text>
              ) : null}
            </Form.Item>
          </Card>

          <Card size="small" title="2. Для каких заказов?" style={{ marginBottom: 12 }}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary">
                Все добавленные условия должны совпасть. Внутри списка достаточно одного из
                выбранных статусов.
              </Text>
              {activeConditionKeys.length === 0 && (
                <Alert
                  type="info"
                  showIcon
                  message="Без дополнительных условий"
                  description="Правило будет выполняться для любого заказа после выбранного события."
                />
              )}
              {activeConditionKeys.map((key) => {
                let control;
                if (
                  key === 'currentOrderStatusIn'
                  || key === 'currentOrderStatusNotIn'
                  || key === 'previousOrderStatusIn'
                ) {
                  const value =
                    key === 'currentOrderStatusIn'
                      ? form.currentOrderStatusIn
                      : key === 'currentOrderStatusNotIn'
                        ? form.currentOrderStatusNotIn
                        : form.previousOrderStatusIn;
                  control = (
                    <Select<number[]>
                      aria-label={CONDITION_LABELS[key]}
                      mode="multiple"
                      value={value ?? []}
                      onChange={(next) => updateForm({ [key]: next })}
                      options={activeOrderStatusOptions}
                      placeholder="Выберите статусы заказа"
                      style={{ width: '100%' }}
                      showSearch
                      optionFilterProp="label"
                    />
                  );
                } else if (
                  key === 'currentPaymentStatusIn' ||
                  key === 'currentPaymentStatusNotIn'
                ) {
                  const value =
                    key === 'currentPaymentStatusIn'
                      ? form.currentPaymentStatusIn
                      : form.currentPaymentStatusNotIn;
                  control = (
                    <Select<number[]>
                      aria-label={CONDITION_LABELS[key]}
                      mode="multiple"
                      value={value ?? []}
                      onChange={(next) => updateForm({ [key]: next })}
                      options={activePaymentStatusOptions}
                      placeholder="Выберите статусы оплаты"
                      style={{ width: '100%' }}
                      showSearch
                      optionFilterProp="label"
                    />
                  );
                } else if (
                  key === 'currentProductionStatusIn' ||
                  key === 'currentProductionStatusNotIn'
                ) {
                  const value =
                    key === 'currentProductionStatusIn'
                      ? form.currentProductionStatusIn
                      : form.currentProductionStatusNotIn;
                  control = (
                    <Select<number[]>
                      aria-label={CONDITION_LABELS[key]}
                      mode="multiple"
                      value={value ?? []}
                      onChange={(next) => updateForm({ [key]: next })}
                      options={activeProductionStatusOptions}
                      placeholder="Выберите общие статусы производства"
                      style={{ width: '100%' }}
                      showSearch
                      optionFilterProp="label"
                    />
                  );
                } else if (key === 'paidShareGte') {
                  control = (
                    <InputNumber
                      aria-label={CONDITION_LABELS[key]}
                      addonAfter="%"
                      min={0}
                      max={100}
                      value={form.paidShareGte}
                      onChange={(value) => updateForm({ paidShareGte: value ?? undefined })}
                      placeholder="50"
                      style={{ width: 180 }}
                    />
                  );
                } else if (key === 'orderSourceIn') {
                  control = (
                    <Select<StatusAutomationOrderSource[]>
                      aria-label={CONDITION_LABELS[key]}
                      mode="multiple"
                      value={form.orderSourceIn ?? []}
                      onChange={(value) => updateForm({ orderSourceIn: value })}
                      options={SOURCE_OPTIONS}
                      placeholder="Выберите источники"
                      style={{ width: '100%' }}
                    />
                  );
                } else {
                  control = <Text>Да</Text>;
                }

                return (
                  <Card key={key} size="small">
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Space
                        style={{
                          width: '100%',
                          justifyContent: 'space-between',
                        }}
                        align="start"
                      >
                        <Text strong>{CONDITION_LABELS[key]}</Text>
                        <Button
                          aria-label={`Удалить условие «${CONDITION_LABELS[key]}»`}
                          type="text"
                          danger
                          size="small"
                          onClick={() => removeCondition(key)}
                        >
                          Удалить
                        </Button>
                      </Space>
                      {control}
                      {!statusAutomationConditionIsFilled(form, key) && (
                        <Text type="danger">Заполните значение или удалите это условие.</Text>
                      )}
                    </Space>
                  </Card>
                );
              })}
              {availableConditionOptions.length > 0 && (
                <Select<ConditionKey>
                  aria-label="Добавить условие"
                  key={activeConditionKeys.join('|')}
                  value={undefined}
                  onChange={addCondition}
                  options={availableConditionOptions}
                  placeholder="+ Добавить условие"
                  style={{ width: 360, maxWidth: '100%' }}
                />
              )}
            </Space>
          </Card>

          <Card size="small" title="3. Что сделать?" style={{ marginBottom: 12 }}>
            <Form.Item label="Что должно произойти?" required>
              <Select<StatusAutomationActionType>
                aria-label="Действие правила"
                value={form.actionType}
                onChange={handleActionChange}
                options={(selectedEvent?.allowedActions ?? []).map((action) => ({
                  value: action,
                  label: ACTION_LABELS[action] ?? action,
                }))}
                style={{ width: '100%' }}
                placeholder="Выберите действие"
              />
            </Form.Item>

            {mappingAction ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Text type="secondary">
                  Задайте, какой статус устанавливать для каждой группы исходных статусов.
                </Text>
                {(form.statusMappingEntries ?? []).map((entry, index) => (
                  <Card key={index} size="small">
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Text strong>
                        {form.actionType === 'map_order_status_to_details_production_status'
                          ? 'Если статус заказа один из'
                          : 'Если общий статус производства один из'}
                      </Text>
                      <Select<number[]>
                        aria-label={`Исходные статусы для соответствия ${index + 1}`}
                        mode="multiple"
                        value={entry.sourceStatusIds}
                        onChange={(value) => updateMappingEntry(index, { sourceStatusIds: value })}
                        options={mappingSourceOptions}
                        style={{ width: '100%' }}
                        placeholder="Выберите исходные статусы"
                        showSearch
                        optionFilterProp="label"
                      />
                      <Text strong>
                        {form.actionType === 'map_order_status_to_details_production_status'
                          ? 'Установить всем деталям статус'
                          : 'Установить заказу статус'}
                      </Text>
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        <Select<number>
                          aria-label={`Целевой статус для соответствия ${index + 1}`}
                          value={entry.targetStatusId > 0 ? entry.targetStatusId : undefined}
                          onChange={(value) => updateMappingEntry(index, { targetStatusId: value })}
                          options={mappingTargetOptions}
                          style={{ width: '100%' }}
                          placeholder="Выберите статус"
                          showSearch
                          optionFilterProp="label"
                        />
                        <Button
                          aria-label={`Удалить соответствие ${index + 1}`}
                          danger
                          onClick={() => removeMappingEntry(index)}
                          disabled={(form.statusMappingEntries ?? []).length <= 1}
                        >
                          Удалить соответствие
                        </Button>
                      </Space>
                    </Space>
                  </Card>
                ))}
                <Button onClick={addMappingEntry}>+ Добавить ещё соответствие</Button>
              </Space>
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Form.Item
                  label={targetStatusQuestion}
                  required
                  style={{ marginBottom: 0 }}
                  extra="Этот статус будет установлен, когда событие произойдёт и все условия совпадут."
                >
                  <Select<number>
                    aria-label={targetStatusQuestion}
                    value={
                      (form.targetStatusId ?? 0) > 0 ? form.targetStatusId ?? undefined : undefined
                    }
                    onChange={(value) => updateForm({ targetStatusId: value })}
                    options={targetStatusOptions}
                    style={{ width: '100%' }}
                    placeholder="Выберите статус"
                    showSearch
                    optionFilterProp="label"
                  />
                </Form.Item>
                {form.actionType === 'change_details_production_status' && (
                  <Form.Item
                    label="Как менять статусы деталей?"
                    style={{ marginBottom: 0 }}
                  >
                    <Select
                      aria-label="Режим изменения статусов деталей"
                      value={form.detailTransitionMode ?? 'set_exact'}
                      onChange={(value) => updateForm({ detailTransitionMode: value })}
                      options={[
                        { value: 'set_exact', label: 'Установить точно, включая откат' },
                        { value: 'advance_only', label: 'Только продвигать вперёд' },
                      ]}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                )}
              </Space>
            )}
          </Card>

          <Alert
            type={rulePreviewComplete ? 'success' : 'info'}
            showIcon
            message={rulePreviewComplete ? 'Правило готово' : 'Как будет работать правило'}
            description={
              <Space direction="vertical" size={2}>
                <Text>
                  <Text strong>КОГДА:</Text> {selectedEvent?.title ?? 'событие не выбрано'}
                </Text>
                <Text>
                  <Text strong>ЕСЛИ:</Text> {describeFormConditions(form, catalogs)}
                </Text>
                <Text>
                  <Text strong>ТО:</Text> {describeFormAction(form, catalogs)}
                </Text>
              </Space>
            }
            style={{ marginBottom: 12 }}
          />

          <Collapse style={{ marginBottom: 12 }}>
            <Collapse.Panel header="Дополнительные настройки" key="advanced">
              <Form.Item
                label="Приоритет выполнения"
                required
                style={{ marginBottom: 0 }}
                extra="Из подходящих правил одного типа выполнится только одно — с меньшим числом. Обычно оставьте 100."
              >
                <InputNumber
                  aria-label="Приоритет выполнения"
                  min={0}
                  max={100000}
                  value={form.priority}
                  onChange={(value) => updateForm({ priority: value ?? 0 })}
                />
              </Form.Item>
            </Collapse.Panel>
          </Collapse>

          <Checkbox
            checked={form.isEnabled}
            onChange={(event) => updateForm({ isEnabled: event.target.checked })}
          >
            Активировать правило сразу после сохранения
          </Checkbox>
        </Form>
      </Modal>

      <Modal
        title="Результат загрузки правил"
        open={rulesImportReport !== null}
        onCancel={() => setRulesImportReport(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setRulesImportReport(null)}>
            Закрыть
          </Button>,
        ]}
        width={760}
      >
        {rulesImportReport && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type={rulesImportReport.failedRules.length > 0 ? 'warning' : 'success'}
              showIcon
              message={`Загружено правил: ${rulesImportReport.createdCount}`}
              description={`Дубликаты пропущены: ${rulesImportReport.skippedDuplicates.length}. Не удалось загрузить: ${rulesImportReport.failedRules.length}.`}
            />
            {rulesImportReport.failedRules.length > 0 && (
              <div>
                <Text strong>Не удалось загрузить из-за отсутствия или несоответствия элементов</Text>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {rulesImportReport.failedRules.map((issue) => (
                    <li key={`failed-${issue.index}`}>
                      <Text>
                        {issue.index}. {issue.name}: {issue.reasons.join('; ')}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {rulesImportReport.skippedDuplicates.length > 0 && (
              <div>
                <Text strong>Пропущенные дубликаты</Text>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {rulesImportReport.skippedDuplicates.map((issue) => (
                    <li key={`duplicate-${issue.index}`}>
                      <Text>
                        {issue.index}. {issue.name}: {issue.reasons.join('; ')}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Space>
        )}
      </Modal>

      <Card size="small" title="Дедлайн-события">
        <Text type="secondary">исполняются механизмом дедлайнов</Text>
        <DeadlineTransitionRulesConfig />
      </Card>
    </Space>
  );
}

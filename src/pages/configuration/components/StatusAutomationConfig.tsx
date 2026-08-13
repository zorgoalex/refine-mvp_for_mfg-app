import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Typography,
  Upload,
  message,
} from 'antd';
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
  buildEventTypeSelectOptions,
  buildStatusAutomationRulesExportFile,
  buildCreatePayload,
  buildUpdatePayload,
  describeConditions,
  planStatusAutomationRulesImport,
  readStatusAutomationRulesImportSource,
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
  change_order_status: 'Статус заказа',
  change_production_status: 'Статус производства',
  change_details_production_status: 'Статус деталей производства',
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

function emptyForm(eventType: StatusAutomationEventType = 'order.created'): StatusAutomationFormValues {
  return {
    name: '',
    eventType,
    actionType: 'change_order_status',
    targetStatusId: 0,
    currentOrderStatusIn: [],
    currentOrderStatusNotIn: [],
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
    currentOrderStatusIn: [...(rule.conditions.currentOrderStatusIn ?? [])],
    currentOrderStatusNotIn: [...(rule.conditions.currentOrderStatusNotIn ?? [])],
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
  const paymentStatusOptions = useMemo(
    () =>
      (paymentStatusesData?.data ?? []).map((status) => ({
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
    const defaultNames = new Set(DEFAULT_MDF_BOARD_HIDDEN_PRODUCTION_STATUS_NAMES);
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
  const targetStatusOptions =
    form.actionType === 'change_order_status' ? orderStatusOptions : productionStatusOptions;

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
    setEditor({ kind: 'create' });
  };

  const openEdit = (rule: StatusAutomationRuleDto) => {
    setForm(formFromRule(rule));
    setEditor({ kind: 'edit', rule });
  };

  const closeEditor = () => {
    setEditor({ kind: 'closed' });
    setForm(emptyForm());
  };

  const handleEventChange = (eventType: StatusAutomationEventType) => {
    const descriptor = eventTypeByName.get(eventType);
    const allowed = new Set(descriptor?.allowedConditions ?? []);
    setForm((current) => ({
      ...current,
      eventType,
      actionType: descriptor?.allowedActions.includes(current.actionType)
        ? current.actionType
        : descriptor?.allowedActions[0] ?? current.actionType,
      currentOrderStatusIn: allowed.has('currentOrderStatusIn') ? current.currentOrderStatusIn : [],
      currentOrderStatusNotIn: allowed.has('currentOrderStatusNotIn')
        ? current.currentOrderStatusNotIn
        : [],
      currentPaymentStatusIn: allowed.has('currentPaymentStatusIn')
        ? current.currentPaymentStatusIn
        : [],
      currentPaymentStatusNotIn: allowed.has('currentPaymentStatusNotIn')
        ? current.currentPaymentStatusNotIn
        : [],
      currentProductionStatusIn: allowed.has('currentProductionStatusIn')
        ? current.currentProductionStatusIn
        : [],
      currentProductionStatusNotIn: allowed.has('currentProductionStatusNotIn')
        ? current.currentProductionStatusNotIn
        : [],
      paidShareGte: allowed.has('paidShareGte') ? current.paidShareGte : undefined,
      orderSourceIn: allowed.has('orderSourceIn') ? current.orderSourceIn : [],
      firstPaymentOnly: allowed.has('firstPaymentOnly') ? current.firstPaymentOnly : undefined,
    }));
  };

  const handleActionChange = (actionType: StatusAutomationActionType) => {
    updateForm({ actionType, targetStatusId: 0 });
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      message.warning('Укажите название правила');
      return;
    }
    if (form.targetStatusId < 1) {
      message.warning('Выберите целевой статус');
      return;
    }
    if (!selectedEvent || !selectedEvent.allowedActions.includes(form.actionType)) {
      message.warning('Выберите допустимое действие');
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
  const editorTitle = editor.kind === 'create' ? 'Новое правило автостатусов' : 'Изменить автостатус';
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
            Настройки ниже управляют видимостью карточек заказов на МДФ-доске.
          </Text>
          <div>
            <Text strong>Обычные статусы заказа</Text>
            <Select<number[]>
              mode="multiple"
              value={mdfBoardHiddenOrderStatusIds}
              onChange={(value) => setMdfBoardHiddenOrderStatusIds(normalizeStatusIds(value))}
              options={orderStatusOptions}
              disabled={!canManage || appSettingsLoading || orderStatusesLoading}
              loading={appSettingsLoading || orderStatusesLoading}
              placeholder="Выберите статусы заказа"
              style={{ width: '100%', marginTop: 4 }}
              allowClear
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              aria-label="Статусы заказа, скрывающие карточки с МДФ-доски"
            />
          </div>
          <div>
            <Text strong>Производственные статусы</Text>
            <Select<number[]>
              mode="multiple"
              value={mdfBoardHiddenProductionStatusIds}
              onChange={(value) => setMdfBoardHiddenProductionStatusIds(
                normalizeStatusIds(value),
              )}
              options={productionStatusOptions}
              disabled={!canManage || appSettingsLoading || productionStatusesLoading}
              loading={appSettingsLoading || productionStatusesLoading}
              placeholder="Выберите производственные статусы"
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
              title: 'Действие → целевой статус',
              key: 'action',
              width: 250,
              render: (_, rule) => {
                const options =
                  rule.actionType === 'change_order_status'
                    ? orderStatusOptions
                    : productionStatusOptions;
                const target = options.find((option) => option.value === rule.targetStatusId)?.label;
                return `${ACTION_LABELS[rule.actionType] ?? rule.actionType} → ${
                  target ?? `#${rule.targetStatusId}`
                }`;
              },
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
        okText={editor.kind === 'create' ? 'Создать' : 'Сохранить'}
        cancelText="Отмена"
        width={760}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="Название" required>
            <Input
              value={form.name}
              onChange={(event) => updateForm({ name: event.target.value })}
              maxLength={200}
              placeholder="Например, перевод оплаченного заказа"
            />
          </Form.Item>

          <Space size={12} style={{ width: '100%' }} align="start">
            <Form.Item label="Событие" required style={{ flex: 1 }}>
              <Select<StatusAutomationEventType>
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
            <Form.Item label="Действие" required style={{ flex: 1 }}>
              <Select<StatusAutomationActionType>
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
          </Space>

          <Form.Item label="Целевой статус" required>
            <Select<number>
              value={form.targetStatusId > 0 ? form.targetStatusId : undefined}
              onChange={(value) => updateForm({ targetStatusId: value })}
              options={targetStatusOptions}
              style={{ width: '100%' }}
              placeholder="Выберите статус"
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>

          <Form.Item label="Условия">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Form.Item label="Выполнять только при статусах заказа" style={{ marginBottom: 0 }}>
                <Select<number[]>
                  mode="multiple"
                  value={form.currentOrderStatusIn ?? []}
                  onChange={(value) => updateForm({ currentOrderStatusIn: value })}
                  options={orderStatusOptions}
                  disabled={!allowedConditionSet.has('currentOrderStatusIn')}
                  placeholder="Статусы заказа"
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item label="Не выполнять при статусах заказа" style={{ marginBottom: 0 }}>
                <Select<number[]>
                  mode="multiple"
                  value={form.currentOrderStatusNotIn ?? []}
                  onChange={(value) => updateForm({ currentOrderStatusNotIn: value })}
                  options={orderStatusOptions}
                  disabled={!allowedConditionSet.has('currentOrderStatusNotIn')}
                  placeholder="Исключить статусы заказа"
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item label="Текущие статусы оплаты" style={{ marginBottom: 0 }}>
                <Select<number[]>
                  mode="multiple"
                  value={form.currentPaymentStatusIn ?? []}
                  onChange={(value) => updateForm({ currentPaymentStatusIn: value })}
                  options={paymentStatusOptions}
                  disabled={!allowedConditionSet.has('currentPaymentStatusIn')}
                  placeholder="Статусы оплаты"
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item label="Исключающие статусы оплаты" style={{ marginBottom: 0 }}>
                <Select<number[]>
                  mode="multiple"
                  value={form.currentPaymentStatusNotIn ?? []}
                  onChange={(value) => updateForm({ currentPaymentStatusNotIn: value })}
                  options={paymentStatusOptions}
                  disabled={!allowedConditionSet.has('currentPaymentStatusNotIn')}
                  placeholder="Исключить статусы оплаты"
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item label="Текущие статусы производства" style={{ marginBottom: 0 }}>
                <Select<number[]>
                  mode="multiple"
                  value={form.currentProductionStatusIn ?? []}
                  onChange={(value) => updateForm({ currentProductionStatusIn: value })}
                  options={productionStatusOptions}
                  disabled={!allowedConditionSet.has('currentProductionStatusIn')}
                  placeholder="Статусы производства"
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item label="Исключающие статусы производства" style={{ marginBottom: 0 }}>
                <Select<number[]>
                  mode="multiple"
                  value={form.currentProductionStatusNotIn ?? []}
                  onChange={(value) => updateForm({ currentProductionStatusNotIn: value })}
                  options={productionStatusOptions}
                  disabled={!allowedConditionSet.has('currentProductionStatusNotIn')}
                  placeholder="Исключить статусы производства"
                  style={{ width: '100%' }}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Space wrap align="start">
                <Form.Item label="Доля оплаты" style={{ marginBottom: 0 }}>
                  <InputNumber
                    addonBefore="Оплачено ≥"
                    addonAfter="%"
                    min={0}
                    max={100}
                    value={form.paidShareGte}
                    onChange={(value) => updateForm({ paidShareGte: value ?? undefined })}
                    disabled={!allowedConditionSet.has('paidShareGte')}
                  />
                </Form.Item>
                <Form.Item label="Источник заказа" style={{ marginBottom: 0, minWidth: 230 }}>
                  <Select<StatusAutomationOrderSource[]>
                    mode="multiple"
                    value={form.orderSourceIn ?? []}
                    onChange={(value) => updateForm({ orderSourceIn: value })}
                    options={SOURCE_OPTIONS}
                    disabled={!allowedConditionSet.has('orderSourceIn')}
                    placeholder="Источник"
                    style={{ width: '100%' }}
                    allowClear
                  />
                </Form.Item>
              </Space>
              <Checkbox
                checked={form.firstPaymentOnly === true}
                onChange={(event) => updateForm({ firstPaymentOnly: event.target.checked })}
                disabled={form.eventType !== 'payment.created' || !allowedConditionSet.has('firstPaymentOnly')}
              >
                Только первый платёж
              </Checkbox>
            </Space>
          </Form.Item>

          <Space size={12} align="start">
            <Form.Item label="Приоритет" required>
              <InputNumber
                min={0}
                max={100000}
                value={form.priority}
                onChange={(value) => updateForm({ priority: value ?? 0 })}
              />
            </Form.Item>
            <Form.Item label="Включено">
              <Switch
                checked={form.isEnabled}
                onChange={(checked) => updateForm({ isEnabled: checked })}
              />
            </Form.Item>
          </Space>
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

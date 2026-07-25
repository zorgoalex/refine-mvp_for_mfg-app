import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, InputNumber, Modal, Select, Space, Spin, Switch, Table, Tag, Typography, message } from 'antd';
import { SaveOutlined, ArrowUpOutlined, ArrowDownOutlined, HolderOutlined, ReloadOutlined } from '@ant-design/icons';
import { useGetIdentity, useInvalidate, useList, useUpdate } from '@refinedev/core';
import { useLocation } from 'react-router-dom';
import { ApiError } from '../../../api/apiError';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type { DeadlineDefaultScheduleDto } from '../../../api/types/deadlineApi.types';
import { featureFlags } from '../../../config/featureFlags';
import { useTabDirty } from '../../../hooks/useTabDirty';
import { useWorkspaceTabKey } from '../../../components/workspace/KeepAliveContext';
import { useAppSettings, SETTING_KEYS } from '../../../hooks/useAppSettings';
import type { UserIdentity } from '../../../types/auth';
import {
  ProductionStatusRef,
  ProductionWorkflowConfig,
  buildDefaultProductionWorkflowConfig,
  normalizeProductionWorkflowConfig,
} from '../../../types/productionWorkflow';
import {
  buildDefaultSchedulePayload,
  buildDurationDraft,
  calculateScheduleDraft,
  canManageDeadlineDefaultSchedule,
  canViewDeadlineDefaultSchedule,
  isDeadlineScheduleDraftComplete,
  type DeadlineDurationDraft,
} from './deadlineDefaultScheduleView';

const { Text } = Typography;

const WORKFLOW_KEY = SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT;

const moveItem = <T,>(arr: T[], from: number, to: number) => {
  if (from === to) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const normalizeLetter = (value: string) => (value || '').trim().slice(0, 1).toUpperCase();

type ValidationItem = { level: 'error' | 'warning'; message: string };

const uniq = (arr: string[]) => Array.from(new Set(arr));

const findDuplicates = (arr: string[]) => {
  const seen = new Set<string>();
  const dups = new Set<string>();
  arr.forEach((x) => {
    if (seen.has(x)) dups.add(x);
    seen.add(x);
  });
  return Array.from(dups);
};

const validateWorkflow = (draft: ProductionWorkflowConfig, knownCodesSet: Set<string>): ValidationItem[] => {
  const items: ValidationItem[] = [];

  const orderAllowed = draft.order.allowed_codes || [];
  const detailAllowed = draft.detail.allowed_codes || [];
  const orderAllowedSet = new Set(orderAllowed);
  const detailAllowedSet = new Set(detailAllowed);

  const orderUnknown = orderAllowed.filter((c) => !knownCodesSet.has(c));
  if (orderUnknown.length > 0) {
    items.push({ level: 'warning', message: `Заказ: allowed_codes содержит неизвестные коды: ${uniq(orderUnknown).join(', ')}` });
  }

  const detailUnknown = detailAllowed.filter((c) => !knownCodesSet.has(c));
  if (detailUnknown.length > 0) {
    items.push({ level: 'warning', message: `Деталь: allowed_codes содержит неизвестные коды: ${uniq(detailUnknown).join(', ')}` });
  }

  if (!orderAllowedSet.has(draft.order.initial_code)) {
    items.push({ level: 'error', message: `Заказ: initial_code "${draft.order.initial_code}" не входит в allowed_codes` });
  }
  if (!detailAllowedSet.has(draft.detail.initial_code)) {
    items.push({ level: 'error', message: `Деталь: initial_code "${draft.detail.initial_code}" не входит в allowed_codes` });
  }

  const displayOrder = draft.status_codes_order || [];
  const displayDups = findDuplicates(displayOrder);
  if (displayDups.length > 0) {
    items.push({ level: 'error', message: `status_codes_order содержит дубликаты: ${displayDups.join(', ')}` });
  }

  const displayUnknown = displayOrder.filter((c) => !knownCodesSet.has(c));
  if (displayUnknown.length > 0) {
    items.push({ level: 'error', message: `status_codes_order содержит неизвестные коды: ${uniq(displayUnknown).join(', ')}` });
  }
  const layoutCodes = (draft.layout_rows ?? []).flat();
  const layoutDuplicates = findDuplicates(layoutCodes);
  if (layoutDuplicates.length > 0) {
    items.push({
      level: 'error',
      message: `В схеме этапы продублированы: ${layoutDuplicates.join(', ')}`,
    });
  }
  const layoutUnknown = layoutCodes.filter((code) => !knownCodesSet.has(code));
  if (layoutUnknown.length > 0) {
    items.push({
      level: 'error',
      message: `В схеме есть неизвестные этапы: ${uniq(layoutUnknown).join(', ')}`,
    });
  }
  const layoutMissing = displayOrder.filter((code) => !layoutCodes.includes(code));
  if (layoutMissing.length > 0) {
    items.push({
      level: 'error',
      message: `В схеме отсутствуют этапы: ${uniq(layoutMissing).join(', ')}`,
    });
  }

  // transitions_order validation
  const transitionsOrder = draft.transitions_order || {};
  Object.entries(transitionsOrder).forEach(([from, tos]) => {
    if (!Array.isArray(tos)) return;
    if (!knownCodesSet.has(from)) {
      items.push({ level: 'error', message: `transitions_order: неизвестный ключ "${from}"` });
      return;
    }
    if (!orderAllowedSet.has(from)) {
      items.push({ level: 'warning', message: `transitions_order: "${from}" не входит в order.allowed_codes` });
    }
    const badTargets = tos.filter((to) => !orderAllowedSet.has(to));
    if (badTargets.length > 0) {
      items.push({
        level: 'error',
        message: `transitions_order: для "${from}" есть переходы вне order.allowed_codes: ${uniq(badTargets).join(', ')}`,
      });
    }
  });

  // transitions_detail validation
  const transitionsDetail = draft.transitions_detail || {};
  Object.entries(transitionsDetail).forEach(([from, tos]) => {
    if (!Array.isArray(tos)) return;
    if (!knownCodesSet.has(from)) {
      items.push({ level: 'error', message: `transitions_detail: неизвестный ключ "${from}"` });
      return;
    }
    if (!detailAllowedSet.has(from)) {
      items.push({ level: 'warning', message: `transitions_detail: "${from}" не входит в detail.allowed_codes` });
    }
    const badTargets = tos.filter((to) => !detailAllowedSet.has(to));
    if (badTargets.length > 0) {
      items.push({
        level: 'error',
        message: `transitions_detail: для "${from}" есть переходы вне detail.allowed_codes: ${uniq(badTargets).join(', ')}`,
      });
    }
  });

  // letters_by_code validation (temporary “icons”)
  const letters = draft.letters_by_code || {};
  Object.entries(letters).forEach(([code, val]) => {
    if (!knownCodesSet.has(code)) return;
    const normalized = normalizeLetter(String(val ?? ''));
    if (!normalized || normalized.length !== 1) {
      items.push({ level: 'warning', message: `letters_by_code: для "${code}" задан пустой символ` });
    }
  });

  return items;
};

export const ProductionWorkflowTab: React.FC = () => {
  const { getSettingRecord, saveSetting, setSettingActive, isLoading: settingsLoading } = useAppSettings();
  const { data: identity } = useGetIdentity<UserIdentity>();
  const invalidate = useInvalidate();
  const { mutateAsync: updateProductionStatus } = useUpdate();
  const canViewDeadlines =
    featureFlags.useBackendDeadlines &&
    (!featureFlags.useBackendPermissions ||
      canViewDeadlineDefaultSchedule(identity));
  const canManageDeadlines =
    !featureFlags.useBackendPermissions ||
    canManageDeadlineDefaultSchedule(identity);
  const canManageWorkflow =
    !featureFlags.useBackendPermissions ||
    Boolean(identity?.permissions?.includes('settings.manage'));

  const { data: statusesData, isLoading: statusesLoading, refetch: refetchStatuses } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 200 },
    // IMPORTANT: explicit is_active filter disables the dataProvider auto-filter, so we can show ALL statuses
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
  });

  const statuses: ProductionStatusRef[] = useMemo(() => {
    return (statusesData?.data || []).map((s: any) => ({
      production_status_id: s.production_status_id,
      production_status_code: s.production_status_code,
      production_status_name: s.production_status_name,
      sort_order: s.sort_order,
      color: s.color,
      is_active: !!s.is_active,
    }));
  }, [statusesData]);

  const workflowRecord = getSettingRecord(WORKFLOW_KEY);
  const workflowIsActive = workflowRecord?.is_active ?? false;
  const savedWorkflow = useMemo(() => {
    if (!workflowRecord) return null;
    const json = workflowRecord.value_json;
    if (json && typeof json === 'object' && 'value' in json) {
      return (json as any).value as ProductionWorkflowConfig;
    }
    return json as ProductionWorkflowConfig;
  }, [workflowRecord]);

  const normalizedWorkflow = useMemo(() => {
    if (!statuses || statuses.length === 0) {
      return savedWorkflow || null;
    }
    return normalizeProductionWorkflowConfig(savedWorkflow, statuses, WORKFLOW_KEY);
  }, [savedWorkflow, statuses]);

  const [draft, setDraft] = useState<ProductionWorkflowConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isTogglingSettingActive, setIsTogglingSettingActive] = useState(false);
  const [deadlineSchedule, setDeadlineSchedule] =
    useState<DeadlineDefaultScheduleDto | null>(null);
  const [deadlineDurations, setDeadlineDurations] =
    useState<DeadlineDurationDraft>({});
  const [deadlineReserveDays, setDeadlineReserveDays] = useState<number | null>(0);
  const [deadlineReason, setDeadlineReason] = useState('');
  const [deadlineLoading, setDeadlineLoading] = useState(false);
  const [deadlineSaving, setDeadlineSaving] = useState(false);
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  const [isDeadlineDirty, setIsDeadlineDirty] = useState(false);
  const [draggedStageCode, setDraggedStageCode] = useState<string | null>(null);
  const [dragOverRow, setDragOverRow] = useState<number | null>(null);

  // Report editor dirty state to the workspace tab registry (single dirty contract).
  const location = useLocation();
  const tabKey = useWorkspaceTabKey(location.pathname);
  useTabDirty(tabKey, isDirty || isDeadlineDirty);

  const loadDeadlineSchedule = useCallback(async () => {
    if (!canViewDeadlines) return;
    setDeadlineLoading(true);
    setDeadlineError(null);
    try {
      const response = await deadlinesApi.getDefaultSchedule();
      setDeadlineSchedule(response.schedule);
      setDeadlineDurations(buildDurationDraft(response.schedule));
      setDeadlineReserveDays(response.schedule.reserveDays);
      setDeadlineReason('');
      setIsDeadlineDirty(false);
    } catch (error) {
      setDeadlineError(errorText(error, 'Не удалось загрузить сроки этапов'));
    } finally {
      setDeadlineLoading(false);
    }
  }, [canViewDeadlines]);

  useEffect(() => {
    void loadDeadlineSchedule();
  }, [loadDeadlineSchedule]);

  // Initialize draft once statuses are available (avoid resetting while editing)
  useEffect(() => {
    if (draft) return;
    if (settingsLoading || statusesLoading) return;
    if (statuses.length === 0) return;
    setDraft(
      normalizedWorkflow
        ? normalizeProductionWorkflowConfig(normalizedWorkflow, statuses, WORKFLOW_KEY)
        : buildDefaultProductionWorkflowConfig(statuses, WORKFLOW_KEY)
    );
  }, [draft, settingsLoading, statusesLoading, statuses, normalizedWorkflow]);

  const statusByCode = useMemo(() => {
    const map = new Map<string, ProductionStatusRef>();
    statuses.forEach((s) => map.set(s.production_status_code, s));
    return map;
  }, [statuses]);

  const missingCodes = useMemo(() => {
    const codes = draft?.status_codes_order || [];
    return codes.filter((code) => !statusByCode.has(code));
  }, [draft?.status_codes_order, statusByCode]);

  const knownCodes = useMemo(() => {
    return statuses.map((s) => s.production_status_code);
  }, [statuses]);
  const knownCodesSet = useMemo(() => new Set(knownCodes), [knownCodes]);

  const usedOrder = useMemo(() => new Set(draft?.order.allowed_codes || []), [draft?.order.allowed_codes]);
  const usedDetail = useMemo(() => new Set(draft?.detail.allowed_codes || []), [draft?.detail.allowed_codes]);
  const inDisplayOrder = useMemo(() => new Set(draft?.status_codes_order || []), [draft?.status_codes_order]);
  const layoutRows = useMemo(
    () =>
      draft?.layout_rows?.length
        ? draft.layout_rows
        : (draft?.status_codes_order ?? []).map((code) => [code]),
    [draft?.layout_rows, draft?.status_codes_order],
  );

  const validationItems = useMemo(() => {
    if (!draft) return [];
    return validateWorkflow(draft, knownCodesSet);
  }, [draft, knownCodesSet]);

  const validationErrors = useMemo(() => validationItems.filter((i) => i.level === 'error'), [validationItems]);
  const validationWarnings = useMemo(() => validationItems.filter((i) => i.level === 'warning'), [validationItems]);
  const deadlineStageByCode = useMemo(
    () =>
      new Map(
        (deadlineSchedule?.stages ?? []).flatMap((stage) =>
          stage.productionStatusCode
            ? [[stage.productionStatusCode, stage] as const]
            : [],
        ),
      ),
    [deadlineSchedule],
  );
  const deadlineDraftSchedule = useMemo(
    () =>
      deadlineSchedule && draft
        ? {
            ...deadlineSchedule,
            transitionsOrder: draft.transitions_order ?? {},
          }
        : null,
    [deadlineSchedule, draft],
  );
  const deadlineCalculation = useMemo(
    () =>
      deadlineDraftSchedule
        ? calculateScheduleDraft(
            deadlineDraftSchedule,
            deadlineDurations,
            deadlineDraftSchedule.transitionsOrder,
          )
        : {
            cumulativeHints: new Map<number, number | null>(),
            totalProductionDays: null,
            hasCycle: false,
          },
    [deadlineDraftSchedule, deadlineDurations],
  );
  const deadlineDraftComplete =
    deadlineDraftSchedule !== null &&
    isDeadlineScheduleDraftComplete(deadlineCalculation, deadlineReserveDays);
  const plannedOrderDays =
    deadlineCalculation.totalProductionDays === null ||
    deadlineReserveDays === null
      ? null
      : deadlineCalculation.totalProductionDays + deadlineReserveDays;
  const deadlinePayload = deadlineDraftSchedule
    ? buildDefaultSchedulePayload(
        deadlineDraftSchedule,
        deadlineReserveDays,
        deadlineDurations,
        deadlineReason,
      )
    : null;

  const setAndDirty = (next: ProductionWorkflowConfig) => {
    setDraft(next);
    setIsDirty(true);
  };

  const setLayoutRows = (rows: string[][]) => {
    if (!draft) return;
    const compactRows = rows.filter((row) => row.length > 0);
    setAndDirty({
      ...draft,
      layout_rows: compactRows,
      status_codes_order: compactRows.flat(),
    });
  };

  const moveStageToRow = (code: string, targetRowIndex: number) => {
    const nextRows = layoutRows.map((row) =>
      row.filter((stageCode) => stageCode !== code),
    );
    if (targetRowIndex >= nextRows.length) {
      nextRows.push([code]);
    } else if (!nextRows[targetRowIndex].includes(code)) {
      nextRows[targetRowIndex] = [...nextRows[targetRowIndex], code];
    }
    setLayoutRows(nextRows);
    setDraggedStageCode(null);
    setDragOverRow(null);
  };

  const moveLayoutRow = (from: number, to: number) => {
    if (to < 0 || to >= layoutRows.length) return;
    setLayoutRows(moveItem(layoutRows, from, to));
  };

  const handleReset = () => {
    if (statuses.length === 0) return;
    const next = normalizedWorkflow
      ? normalizeProductionWorkflowConfig(normalizedWorkflow, statuses, WORKFLOW_KEY)
      : buildDefaultProductionWorkflowConfig(statuses, WORKFLOW_KEY);
    setDraft(next);
    setIsDirty(false);
    message.info('Черновик сброшен к сохранённой версии');
  };

  const handleSave = async () => {
    if (!draft) return;
    if (validationErrors.length > 0) {
      message.error('Нельзя сохранить: исправьте ошибки в конфигурации');
      return;
    }
    setIsSaving(true);
    try {
      await saveSetting(
        WORKFLOW_KEY,
        draft,
        'Workflow производства (production_status_events) + буквы этапов (временное хранение в app_settings)'
      );
      setIsDirty(false);
      message.success('Схема и переходы сохранены');
    } catch (e) {
      message.error('Не удалось сохранить workflow');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleWorkflowSettingActive = async (nextActive: boolean) => {
    if (!draft) return;
    setIsTogglingSettingActive(true);
    try {
      if (nextActive) {
        if (validationErrors.length > 0) {
          message.error('Нельзя активировать: исправьте ошибки в конфигурации');
          return;
        }
        // Enabling: persist current draft to ensure value_json is valid workflow config
        await saveSetting(
          WORKFLOW_KEY,
          draft,
          'Workflow производства (production_status_events) + буквы этапов (временное хранение в app_settings)'
        );
        setIsDirty(false);
        message.success('Настройка workflow активирована');
      } else {
        await setSettingActive(WORKFLOW_KEY, false);
        message.info('Настройка workflow деактивирована');
      }
    } catch (e) {
      message.error('Не удалось изменить активность настройки');
    } finally {
      setIsTogglingSettingActive(false);
    }
  };

  const saveDeadlineSchedule = async () => {
    if (!deadlinePayload || isDirty) {
      message.warning(
        isDirty
          ? 'Сначала сохраните схему этапов и переходы'
          : 'Заполните длительности, резерв и причину изменения',
      );
      return;
    }
    setDeadlineSaving(true);
    try {
      const response = await deadlinesApi.replaceDefaultSchedule(deadlinePayload);
      setDeadlineSchedule(response.schedule);
      setDeadlineDurations(buildDurationDraft(response.schedule));
      setDeadlineReserveDays(response.schedule.reserveDays);
      setDeadlineReason('');
      setIsDeadlineDirty(false);
      message.success('Длительности этапов сохранены');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        message.error('Сроки или список этапов уже изменились. Данные обновлены.');
        await loadDeadlineSchedule();
      } else {
        message.error(errorText(error, 'Не удалось сохранить длительности'));
      }
    } finally {
      setDeadlineSaving(false);
    }
  };

  const disableDeadlineSchedule = () => {
    if (!deadlineSchedule || deadlineReason.trim().length < 3) {
      message.warning('Укажите причину изменения');
      return;
    }
    Modal.confirm({
      title: 'Отключить автоматические сроки?',
      content: 'Новые заказы не будут получать плановую дату по длительностям этапов.',
      okText: 'Отключить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        setDeadlineSaving(true);
        try {
          const response = await deadlinesApi.replaceDefaultSchedule({
            expectedVersion: deadlineSchedule.version,
            reserveDays: 0,
            reason: deadlineReason.trim(),
            stages: [],
          });
          setDeadlineSchedule(response.schedule);
          setDeadlineDurations(buildDurationDraft(response.schedule));
          setDeadlineReserveDays(response.schedule.reserveDays);
          setDeadlineReason('');
          setIsDeadlineDirty(false);
          message.success('Автоматические сроки отключены');
        } catch (error) {
          message.error(errorText(error, 'Не удалось отключить сроки'));
          await loadDeadlineSchedule();
        } finally {
          setDeadlineSaving(false);
        }
      },
    });
  };

  if (settingsLoading || statusesLoading || !draft) {
    return (
      <div style={{ padding: '16px 0' }}>
        <Spin />
      </div>
    );
  }

  const allCodesOptions = knownCodes.map((code) => {
    const s = statusByCode.get(code);
    const name = s?.production_status_name || code;
    const active = s?.is_active;
    const letter = normalizeLetter(draft.letters_by_code?.[code] || '');
    return {
      value: code,
      label: (
        <Space size={8}>
          <Tag color={active ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
            {letter || '—'}
          </Tag>
          <span>{name}</span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            ({code})
          </Text>
        </Space>
      ),
    };
  });

  const layoutRowOptions = [
    ...layoutRows.map((_, index) => ({
      value: index,
      label: `Строка ${index + 1}`,
    })),
    { value: layoutRows.length, label: 'Новая строка' },
  ];

  const renderStageCard = (code: string, rowIndex: number) => {
    const status = statusByCode.get(code);
    const stage = deadlineStageByCode.get(code);
    const letter = normalizeLetter(draft.letters_by_code?.[code] || '');
    const deadline = stage
      ? deadlineCalculation.cumulativeHints.get(stage.productionStatusId)
      : null;

    return (
      <div
        key={code}
        style={{
          width: 310,
          border: '1px solid #d9d9d9',
          borderRadius: 8,
          padding: 12,
          background: '#fff',
          boxShadow:
            draggedStageCode === code
              ? '0 8px 24px rgba(0, 0, 0, 0.12)'
              : '0 1px 2px rgba(0, 0, 0, 0.04)',
          opacity: draggedStageCode === code ? 0.72 : 1,
        }}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Space size={8} wrap>
              <Tag
                color={status?.is_active ? 'green' : 'default'}
                style={{ marginInlineEnd: 0 }}
              >
                {letter || '—'}
              </Tag>
              <Text strong>{status?.production_status_name || code}</Text>
              <Text type="secondary">({code})</Text>
            </Space>
            {canManageWorkflow && (
              <Button
                type="text"
                icon={<HolderOutlined />}
                aria-label={`Перетащить этап ${status?.production_status_name || code}`}
                title="Перетащить этап"
                draggable={canManageWorkflow}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', code);
                  setDraggedStageCode(code);
                }}
                onDragEnd={() => {
                  setDraggedStageCode(null);
                  setDragOverRow(null);
                }}
                style={{
                  minWidth: 40,
                  minHeight: 40,
                  cursor: 'grab',
                  flex: '0 0 auto',
                }}
              />
            )}
          </div>

          {canViewDeadlines && stage ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '128px 1fr',
                gap: 12,
                alignItems: 'end',
              }}
            >
              <div>
                <Text type="secondary">Длительность</Text>
                <InputNumber
                  aria-label={`Длительность этапа ${stage.productionStatusName}`}
                  min={0}
                  max={3650}
                  precision={0}
                  addonAfter="дн."
                  value={deadlineDurations[stage.productionStatusId]}
                  disabled={!canManageDeadlines || deadlineLoading}
                  onChange={(value) => {
                    setDeadlineDurations((current) => ({
                      ...current,
                      [stage.productionStatusId]: value,
                    }));
                    setIsDeadlineDirty(true);
                  }}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <Text type="secondary">Дедлайн</Text>
                <div>
                  {deadline === null || deadline === undefined ? (
                    <Text type="secondary">Не рассчитан</Text>
                  ) : (
                    <Text strong>{deadline}-й день от даты заказа</Text>
                  )}
                </div>
              </div>
            </div>
          ) : (
            canViewDeadlines && <Text type="secondary">Неактивный этап</Text>
          )}

          {canManageWorkflow && (
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <Select
                aria-label={`Строка этапа ${status?.production_status_name || code}`}
                value={rowIndex}
                options={layoutRowOptions}
                onChange={(targetRow) => moveStageToRow(code, targetRow)}
                style={{ width: 150 }}
              />
              <Button
                danger
                onClick={() =>
                  setLayoutRows(
                    layoutRows.map((row) =>
                      row.filter((stageCode) => stageCode !== code),
                    ),
                  )
                }
                style={{ minHeight: 44 }}
              >
                Убрать
              </Button>
            </Space>
          )}
        </Space>
      </div>
    );
  };

  return (
    <div style={{ padding: '16px 0' }}>
      <Alert
        type="info"
        showIcon
        message="Workflow этапов производства"
        description={
          <div>
            <div>
              Ключ настройки: <Text code>{WORKFLOW_KEY}</Text>
            </div>
            <div>
              События хранятся в <Text code>production_status_events</Text>, а правила/буквы — в{' '}
              <Text code>app_settings.value_json</Text>.
            </div>
            {missingCodes.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Text type="danger">
                  В конфиге есть коды, которых нет в справочнике: {missingCodes.join(', ')}
                </Text>
              </div>
            )}
          </div>
        }
        style={{ marginBottom: 16 }}
      />

      {(validationErrors.length > 0 || validationWarnings.length > 0) && (
        <Alert
          type={validationErrors.length > 0 ? 'error' : 'warning'}
          showIcon
          message={`Проверка конфигурации: ошибок ${validationErrors.length}, предупреждений ${validationWarnings.length}`}
          description={
            <div>
              {validationErrors.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Text strong style={{ color: '#cf1322' }}>Ошибки:</Text>
                  <ul style={{ margin: '6px 0 0 18px' }}>
                    {validationErrors.slice(0, 8).map((e, idx) => (
                      <li key={`e-${idx}`}>{e.message}</li>
                    ))}
                  </ul>
                  {validationErrors.length > 8 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Показаны первые 8 ошибок…
                    </Text>
                  )}
                </div>
              )}

              {validationWarnings.length > 0 && (
                <div>
                  <Text strong style={{ color: '#ad6800' }}>Предупреждения:</Text>
                  <ul style={{ margin: '6px 0 0 18px' }}>
                    {validationWarnings.slice(0, 8).map((w, idx) => (
                      <li key={`w-${idx}`}>{w.message}</li>
                    ))}
                  </ul>
                  {validationWarnings.length > 8 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Показаны первые 8 предупреждений…
                    </Text>
                  )}
                </div>
              )}
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Card
        size="small"
        title="Схема этапов и сроки"
        extra={
          <Space>
            <Space size={8}>
              <Text type="secondary">is_active:</Text>
              <Switch
                checked={workflowIsActive}
                loading={isTogglingSettingActive}
                onChange={handleToggleWorkflowSettingActive}
                disabled={!canManageWorkflow || validationErrors.length > 0}
              />
            </Space>
            <Button onClick={() => refetchStatuses()}>Обновить статусы</Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={handleReset}
              disabled={!canManageWorkflow || !isDirty}
            >
              Сбросить
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={handleSave}
              loading={isSaving}
              disabled={!canManageWorkflow || !isDirty}
            >
              Сохранить схему
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Порядок здесь — визуальная схема производства. Реальную последовательность
              и накопительные дедлайны определяет блок «Переходы». Длительность
              относится только к самому этапу. Несколько карточек в одной строке
              показывают параллельные или альтернативные ветки, но не создают
              переходы автоматически.
            </Text>
          </div>

          {deadlineCalculation.hasCycle && (
            <Alert
              type="error"
              showIcon
              message="В переходах найден цикл"
              description="Накопительные сроки нельзя вычислить, пока замкнутый маршрут не будет исправлен в блоке «Переходы»."
            />
          )}
          {deadlineError && (
            <Alert
              type="error"
              showIcon
              message={deadlineError}
              action={
                <Button onClick={() => void loadDeadlineSchedule()}>
                  Повторить
                </Button>
              }
            />
          )}
          {canViewDeadlines &&
            deadlineSchedule &&
            !deadlineLoading &&
            !deadlineDraftComplete &&
            !deadlineCalculation.hasCycle && (
              <Alert
                type="warning"
                showIcon
                message="Сроки этапов не настроены полностью"
                description="Заполните длительность каждого активного этапа. Нулевая длительность допустима."
              />
            )}

          <Space wrap>
            <Text strong style={{ minWidth: 190 }}>
              Добавить этап в порядок:
            </Text>
            <Select
              style={{ minWidth: 360 }}
              placeholder="Выберите статус"
              disabled={!canManageWorkflow}
              options={allCodesOptions.filter((o) => !inDisplayOrder.has(o.value as string))}
              onChange={(code) => {
                const nextRows = [...layoutRows, [code]];
                const next = {
                  ...draft,
                  layout_rows: nextRows,
                  status_codes_order: nextRows.flat(),
                };
                setAndDirty(next);
              }}
            />
          </Space>

          <Table
            size="small"
            pagination={false}
            rowKey="index"
            dataSource={layoutRows.map((codes, index) => ({
              index,
              codes,
            }))}
            columns={[
              {
                title: 'Строка',
                dataIndex: 'index',
                width: 124,
                render: (index: number) => (
                  <Space direction="vertical" size={6}>
                    <Text strong>Уровень {index + 1}</Text>
                    <Space size={4}>
                      <Button
                        aria-label={`Переместить строку ${index + 1} выше`}
                        icon={<ArrowUpOutlined />}
                        disabled={!canManageWorkflow || index === 0}
                        onClick={() => moveLayoutRow(index, index - 1)}
                        style={{ minWidth: 44, minHeight: 44 }}
                      />
                      <Button
                        aria-label={`Переместить строку ${index + 1} ниже`}
                        icon={<ArrowDownOutlined />}
                        disabled={
                          !canManageWorkflow || index === layoutRows.length - 1
                        }
                        onClick={() => moveLayoutRow(index, index + 1)}
                        style={{ minWidth: 44, minHeight: 44 }}
                      />
                    </Space>
                  </Space>
                ),
              },
              {
                title: 'Технологическая схема',
                dataIndex: 'codes',
                render: (codes: string[], row: { index: number }) => (
                  <div
                    onDragOver={(event) => {
                      if (!canManageWorkflow || !draggedStageCode) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      setDragOverRow(row.index);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                        setDragOverRow(null);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const code =
                        draggedStageCode || event.dataTransfer.getData('text/plain');
                      if (code) moveStageToRow(code, row.index);
                    }}
                    style={{
                      minHeight: 124,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 12,
                      alignItems: 'stretch',
                      padding: 10,
                      border:
                        dragOverRow === row.index
                          ? '2px solid #1677ff'
                          : '2px dashed transparent',
                      borderRadius: 8,
                      background:
                        dragOverRow === row.index ? '#e6f4ff' : 'transparent',
                      transition:
                        'border-color 160ms ease, background-color 160ms ease',
                    }}
                  >
                    {codes.map((code) => renderStageCard(code, row.index))}
                  </div>
                ),
              },
            ]}
          />

          {canManageWorkflow && (
            <div
              onDragOver={(event) => {
                if (!draggedStageCode) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverRow(layoutRows.length);
              }}
              onDragLeave={() => setDragOverRow(null)}
              onDrop={(event) => {
                event.preventDefault();
                const code =
                  draggedStageCode || event.dataTransfer.getData('text/plain');
                if (code) moveStageToRow(code, layoutRows.length);
              }}
              style={{
                minHeight: 52,
                display: 'grid',
                placeItems: 'center',
                border:
                  dragOverRow === layoutRows.length
                    ? '2px solid #1677ff'
                    : '1px dashed #bfbfbf',
                borderRadius: 8,
                background:
                  dragOverRow === layoutRows.length ? '#e6f4ff' : '#fafafa',
              }}
            >
              <Text type="secondary">
                Перетащите этап сюда, чтобы создать новую строку
              </Text>
            </div>
          )}

          {canViewDeadlines && deadlineLoading && !deadlineSchedule && (
            <div style={{ minHeight: 96, display: 'grid', placeItems: 'center' }}>
              <Spin />
            </div>
          )}

          {canViewDeadlines && deadlineSchedule && (
            <Card size="small" title="Плановая готовность заказа">
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap size={24} align="end">
                  <div>
                    <Text type="secondary">Производственный цикл</Text>
                    <div>
                      <Text
                        strong
                        style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}
                      >
                        {deadlineCalculation.totalProductionDays ?? '—'} дн.
                      </Text>
                    </div>
                  </div>
                  <div>
                    <Text type="secondary">Резерв после производства</Text>
                    <div>
                      <InputNumber
                        aria-label="Резерв после производства"
                        min={0}
                        max={3650}
                        precision={0}
                        addonAfter="дн."
                        value={deadlineReserveDays}
                        disabled={!canManageDeadlines}
                        onChange={(value) => {
                          setDeadlineReserveDays(value);
                          setIsDeadlineDirty(true);
                        }}
                        style={{ width: 150 }}
                      />
                    </div>
                  </div>
                  <div>
                    <Text type="secondary">Плановая готовность</Text>
                    <div>
                      <Text
                        strong
                        style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}
                      >
                        {plannedOrderDays ?? '—'}-й день от даты заказа
                      </Text>
                    </div>
                  </div>
                </Space>

                {!featureFlags.useBackendOrdersWrite && (
                  <Alert
                    type="warning"
                    showIcon
                    message="Автоприменение пока выключено"
                    description="Сроки начнут применяться к новым заказам после включения backend-записи заказов."
                  />
                )}

                {canManageDeadlines && (
                  <>
                    <Input.TextArea
                      aria-label="Причина изменения сроков"
                      value={deadlineReason}
                      onChange={(event) => {
                        setDeadlineReason(event.target.value);
                        setIsDeadlineDirty(true);
                      }}
                      placeholder="Причина изменения сроков (обязательно)"
                      maxLength={500}
                      autoSize={{ minRows: 2, maxRows: 4 }}
                    />
                    {isDirty && (
                      <Text type="warning">
                        Сначала сохраните схему и переходы — сроки считаются по
                        сохранённому графу.
                      </Text>
                    )}
                    {deadlineDraftComplete && deadlineReason.trim().length < 3 && (
                      <Text type="secondary">
                        Укажите причину изменения, чтобы сохранить сроки.
                      </Text>
                    )}
                    <Space wrap>
                      <Button
                        type="primary"
                        onClick={() => void saveDeadlineSchedule()}
                        loading={deadlineSaving}
                        disabled={!deadlinePayload || isDirty}
                      >
                        Сохранить сроки
                      </Button>
                      <Button
                        onClick={() => void loadDeadlineSchedule()}
                        disabled={deadlineSaving || !isDeadlineDirty}
                      >
                        Сбросить сроки
                      </Button>
                      <Button
                        danger
                        onClick={disableDeadlineSchedule}
                        disabled={
                          deadlineSaving ||
                          !deadlineSchedule.hasStoredConfiguration
                        }
                      >
                        Отключить сроки
                      </Button>
                    </Space>
                  </>
                )}
              </Space>
            </Card>
          )}
        </Space>
      </Card>

      <Card size="small" title="Переходы (transitions)" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Переходы хранятся по <Text code>production_status_code</Text>.
            Они определяют разрешённые следующие этапы и цепочку накопления
            дедлайнов. Визуальный порядок выше на расчёт не влияет.
          </Text>

          <Space wrap>
            <Button
              disabled={!canManageWorkflow}
              onClick={() => {
                const orderTransitions: Record<string, string[]> = {};
                const detailTransitions: Record<string, string[]> = {};
                draft.status_codes_order.forEach((code, idx) => {
                  const next = draft.status_codes_order[idx + 1];
                  if (!next) return;
                  if (usedOrder.has(code) && usedOrder.has(next)) orderTransitions[code] = [next];
                  if (usedDetail.has(code) && usedDetail.has(next)) detailTransitions[code] = [next];
                });
                setAndDirty({
                  ...draft,
                  transitions_order: orderTransitions,
                  transitions_detail: detailTransitions,
                });
              }}
            >
              Сгенерировать линейные переходы
            </Button>
          </Space>

          <Text strong>Заказ</Text>
          <Table
            size="small"
            pagination={false}
            rowKey="code"
            dataSource={draft.status_codes_order.filter((c) => usedOrder.has(c)).map((code) => ({
              code,
              name: statusByCode.get(code)?.production_status_name || code,
              allowed: draft.transitions_order?.[code] || [],
            }))}
            columns={[
              {
                title: 'Этап',
                dataIndex: 'code',
                render: (_: any, row: any) => (
                  <Space size={8}>
                    <Text>{row.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      ({row.code})
                    </Text>
                  </Space>
                ),
              },
              {
                title: 'Можно перейти в',
                dataIndex: 'allowed',
                render: (allowed: string[], row: any) => (
                  <Select
                    mode="multiple"
                    disabled={!canManageWorkflow}
                    style={{ width: '100%' }}
                    placeholder="—"
                    value={allowed}
                    options={allCodesOptions.filter((o) => usedOrder.has(o.value as string))}
                    onChange={(nextCodes) =>
                      setAndDirty({
                        ...draft,
                        transitions_order: { ...(draft.transitions_order || {}), [row.code]: nextCodes },
                      })
                    }
                  />
                ),
              },
            ]}
          />

          <Text strong>Деталь</Text>
          <Table
            size="small"
            pagination={false}
            rowKey="code"
            dataSource={draft.status_codes_order.filter((c) => usedDetail.has(c)).map((code) => ({
              code,
              name: statusByCode.get(code)?.production_status_name || code,
              allowed: draft.transitions_detail?.[code] || [],
            }))}
            columns={[
              {
                title: 'Этап',
                dataIndex: 'code',
                render: (_: any, row: any) => (
                  <Space size={8}>
                    <Text>{row.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      ({row.code})
                    </Text>
                  </Space>
                ),
              },
              {
                title: 'Можно перейти в',
                dataIndex: 'allowed',
                render: (allowed: string[], row: any) => (
                  <Select
                    mode="multiple"
                    disabled={!canManageWorkflow}
                    style={{ width: '100%' }}
                    placeholder="—"
                    value={allowed}
                    options={allCodesOptions.filter((o) => usedDetail.has(o.value as string))}
                    onChange={(nextCodes) =>
                      setAndDirty({
                        ...draft,
                        transitions_detail: { ...(draft.transitions_detail || {}), [row.code]: nextCodes },
                      })
                    }
                  />
                ),
              },
            ]}
          />
        </Space>
      </Card>

      <Card size="small" title="Статусы производства и использование в workflow">
        <Table
          size="small"
          pagination={false}
          rowKey="production_status_id"
          dataSource={statuses}
          columns={[
            {
              title: 'Активен',
              dataIndex: 'is_active',
              width: 78,
              render: (v: boolean, row: ProductionStatusRef) => (
                <Switch
                  checked={v}
                  disabled={!canManageWorkflow}
                  onChange={async (next) => {
                    try {
                      await updateProductionStatus({
                        resource: 'production_statuses',
                        id: row.production_status_id,
                        values: { is_active: next },
                      });
                      await invalidate({ resource: 'production_statuses', invalidates: ['list'] });
                      refetchStatuses();
                      message.success(next ? 'Статус активирован' : 'Статус деактивирован');
                    } catch (e) {
                      message.error('Не удалось обновить is_active');
                    }
                  }}
                />
              ),
            },
            { title: 'Порядок', dataIndex: 'sort_order', width: 78 },
            {
              title: 'Буква',
              dataIndex: 'production_status_code',
              width: 78,
              render: (code: string) => (
                <Input
                  value={draft.letters_by_code?.[code] || ''}
                  disabled={!canManageWorkflow}
                  maxLength={1}
                  style={{ width: 54, textAlign: 'center' }}
                  onChange={(e) => {
                    const value = normalizeLetter(e.target.value);
                    setAndDirty({
                      ...draft,
                      letters_by_code: { ...(draft.letters_by_code || {}), [code]: value },
                    });
                  }}
                />
              ),
            },
            {
              title: 'Название',
              dataIndex: 'production_status_name',
              render: (name: string, row: ProductionStatusRef) => (
                <Space size={8}>
                  <span>{name}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ({row.production_status_code})
                  </Text>
                </Space>
              ),
            },
            {
              title: 'Workflow (заказ)',
              dataIndex: 'production_status_code',
              width: 140,
              render: (code: string) => (
                <Checkbox
                  checked={usedOrder.has(code)}
                  disabled={!canManageWorkflow}
                  onChange={(e) => {
                    const nextAllowed = e.target.checked
                      ? Array.from(new Set([...draft.order.allowed_codes, code]))
                      : draft.order.allowed_codes.filter((c) => c !== code);
                    setAndDirty({
                      ...draft,
                      order: { ...draft.order, allowed_codes: nextAllowed },
                    });
                  }}
                />
              ),
            },
            {
              title: 'Workflow (деталь)',
              dataIndex: 'production_status_code',
              width: 140,
              render: (code: string) => (
                <Checkbox
                  checked={usedDetail.has(code)}
                  disabled={!canManageWorkflow}
                  onChange={(e) => {
                    const nextAllowed = e.target.checked
                      ? Array.from(new Set([...draft.detail.allowed_codes, code]))
                      : draft.detail.allowed_codes.filter((c) => c !== code);
                    setAndDirty({
                      ...draft,
                      detail: { ...draft.detail, allowed_codes: nextAllowed },
                    });
                  }}
                />
              ),
            },
            {
              title: 'В порядке',
              dataIndex: 'production_status_code',
              width: 100,
              render: (code: string) => (
                <Tag color={inDisplayOrder.has(code) ? 'blue' : 'default'}>
                  {inDisplayOrder.has(code) ? 'Да' : 'Нет'}
                </Tag>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default ProductionWorkflowTab;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

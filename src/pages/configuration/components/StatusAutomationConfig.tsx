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
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/apiError';
import { statusAutomationApi } from '../../../api/statusAutomationApi';
import type {
  StatusAutomationActionType,
  StatusAutomationEventType,
  StatusAutomationEventTypeDto,
  StatusAutomationOrderSource,
  StatusAutomationRuleDto,
} from '../../../api/types/statusAutomationApi.types';
import { featureFlags } from '../../../config/featureFlags';
import { can } from '../../../utils/permissions';
import { DeadlineTransitionRulesConfig } from './DeadlineTransitionRulesConfig';
import {
  allowedConditionKeysForEvent,
  buildCreatePayload,
  buildUpdatePayload,
  describeConditions,
  type StatusAutomationCatalogs,
  type StatusAutomationFormValues,
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
  sort_order?: number;
  is_active?: boolean;
}

type EditorMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; rule: StatusAutomationRuleDto };

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
  const [deletingRuleId, setDeletingRuleId] = useState<number | null>(null);
  const [updatingRuleId, setUpdatingRuleId] = useState<number | null>(null);

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

  const eventTypeByName = useMemo(
    () => new Map(eventTypes.map((eventType) => [eventType.eventType, eventType])),
    [eventTypes],
  );
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
    const catalogError = orderStatusesError ?? paymentStatusesError ?? productionStatusesError;
    if (catalogError) {
      message.error(errorText(catalogError, 'Не удалось загрузить справочник статусов'));
    }
  }, [orderStatusesError, paymentStatusesError, productionStatusesError]);

  const updateForm = (patch: Partial<StatusAutomationFormValues>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const openCreate = () => {
    const eventType = eventTypes[0]?.eventType ?? 'order.created';
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', padding: '16px 0' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong>Правила автостатусов</Text>
        {canManage && (
          <Button type="primary" onClick={openCreate} disabled={eventTypes.length === 0}>
            Создать правило
          </Button>
        )}
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
                options={eventTypes.map((eventType) => ({
                  value: eventType.eventType,
                  label: eventType.title,
                }))}
                style={{ width: '100%' }}
                placeholder="Выберите событие"
              />
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
              <Space wrap>
                <InputNumber
                  addonBefore="Оплачено ≥"
                  addonAfter="%"
                  min={0}
                  max={100}
                  value={form.paidShareGte}
                  onChange={(value) => updateForm({ paidShareGte: value ?? undefined })}
                  disabled={!allowedConditionSet.has('paidShareGte')}
                />
                <Select<StatusAutomationOrderSource[]>
                  mode="multiple"
                  value={form.orderSourceIn ?? []}
                  onChange={(value) => updateForm({ orderSourceIn: value })}
                  options={SOURCE_OPTIONS}
                  disabled={!allowedConditionSet.has('orderSourceIn')}
                  placeholder="Источник"
                  style={{ minWidth: 230 }}
                  allowClear
                />
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

      <Card size="small" title="Дедлайн-события">
        <Text type="secondary">исполняются механизмом дедлайнов</Text>
        <DeadlineTransitionRulesConfig />
      </Card>
    </Space>
  );
}

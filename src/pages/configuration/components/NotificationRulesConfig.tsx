import { Table } from '../../../ui/tooltipDelay';
import { useGetIdentity, useList } from '@refinedev/core';
import {
  Alert, Button, Card, Checkbox, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Switch, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/apiError';
import { notificationRulesApi } from '../../../api/notificationRulesApi';
import { groupsApi } from '../../../api/groupsApi';
import type {
  DeadlineNotificationEntityType,
  NotificationEventTypeDto,
  NotificationChannel,
  NotificationLevel,
  NotificationRuleDto,
  RecipientResolverKind,
} from '../../../api/types/notificationRulesApi.types';
import type { UserIdentity } from '../../../types/auth';
import { normalizeRoleKey } from '../../../utils/resourceVisibility';
import {
  buildCreatePayload,
  buildDraftFromRule,
  buildUpdatePayload,
  canManageNotificationRules,
  canViewNotificationRules,
  emptyDraft,
  generateNotificationRuleCode,
  type NotificationRuleDraft,
} from './notificationRulesView';

const { Text } = Typography;
const { TextArea } = Input;

const TEMPLATE_PLACEHOLDERS = ['{orderId}', '{clientId}', '{orderStatusId}', '{eventType}'];

const EVENT_TYPE_LABELS: Record<string, string> = {
  'order.status_changed': 'Изменение статуса заказа',
  'order.production_status_changed': 'Изменение статуса производства',
  'order.payment_status_changed': 'Изменение статуса оплаты',
  DEADLINE_EXPIRED: 'Истечение срока',
  GROUP_DEADLINE_OVERDUE: 'Просрочка срока группы',
};

const TEMPLATE_PLACEHOLDER_LABELS: Record<string, string> = {
  '{orderId}': 'заказ',
  '{clientId}': 'клиент',
  '{orderStatusId}': 'статус заказа',
  '{eventType}': 'тип события',
};

const RESOLVER_LABELS: Record<RecipientResolverKind, string> = {
  order_manager: 'Менеджер заказа',
  stage_assignee: 'Ответственный за этап',
  workshop_head: 'Руководитель цеха',
  direction_head: 'Руководитель направления',
  group_participants: 'Участники группы',
};

const LEVEL_LABELS: Record<NotificationLevel, string> = {
  info: 'Информационное',
  warning: 'Предупреждение',
  error: 'Ошибка',
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'В приложении',
  telegram: 'Telegram',
};

const DEADLINE_ENTITY_TYPE_LABELS: Record<DeadlineNotificationEntityType, string> = {
  order: 'Срок заказа',
  order_stage: 'Срок этапа заказа',
};

const ALL_REFERENCE_FILTER = [{ field: 'is_active', operator: 'in' as const, value: [true, false] }];

interface OrderStatusRow {
  order_status_id: number;
  order_status_name: string;
  is_active?: boolean;
}

interface RoleRow {
  role_id: number;
  role_name: string;
  is_active?: boolean;
}

interface UserRow {
  user_id: number;
  username: string;
  full_name?: string | null;
  employee?: { full_name?: string | null } | null;
  is_active?: boolean;
}

interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

type EditorMode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; rule: NotificationRuleDto };

function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? 'Событие уведомления';
}

function describeRecipients(
  rule: NotificationRuleDto,
  roleNameByCode: ReadonlyMap<string, string>,
  userNameById: ReadonlyMap<number, string>
): string {
  const parts: string[] = [];
  if (rule.recipients.resolvers?.length) {
    parts.push(
      rule.recipients.resolvers
        .map((resolver) => RESOLVER_LABELS[resolver] ?? 'Способ определения получателя')
        .join(', ')
    );
  }
  if (rule.recipients.roleCodes?.length) {
    parts.push(
      `роли: ${rule.recipients.roleCodes
        .map((code) => roleNameByCode.get(code) ?? 'Роль удалена из справочника')
        .join(', ')}`
    );
  }
  if (rule.recipients.userIds?.length) {
    parts.push(
      `пользователи: ${rule.recipients.userIds
        .map((id) => userNameById.get(id) ?? 'Пользователь удалён из справочника')
        .join(', ')}`
    );
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function describeConditions(rule: NotificationRuleDto, orderStatusNameById: ReadonlyMap<number, string>): string {
  const parts: string[] = [];
  if (rule.conditions.deadlineEntityTypes?.length) {
    parts.push(
      `сроки: ${rule.conditions.deadlineEntityTypes
        .map((type) => DEADLINE_ENTITY_TYPE_LABELS[type] ?? 'Тип срока')
        .join(', ')}`
    );
  }
  if (rule.conditions.requireCurrentDeadlineEvent !== undefined) {
    parts.push(rule.conditions.requireCurrentDeadlineEvent ? 'только текущий срок' : 'включая старые события');
  }
  if (rule.conditions.excludeCompletedOrders) {
    parts.push('без завершённых');
  }
  if (rule.conditions.allowedFromOrderStatusIds?.length) {
    parts.push(
      `из статусов: ${rule.conditions.allowedFromOrderStatusIds
        .map((id) => orderStatusNameById.get(id) ?? 'Статус удалён из справочника')
        .join(', ')}`
    );
  }
  if (rule.conditions.excludeOrderStatusIds?.length) {
    parts.push(
      `исключить статусы: ${rule.conditions.excludeOrderStatusIds
        .map((id) => orderStatusNameById.get(id) ?? 'Статус удалён из справочника')
        .join(', ')}`
    );
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function isRecipientDraftValid(draft: NotificationRuleDraft): boolean {
  if (draft.resolvers.length > 0) return true;
  if (draft.roleCodes.length > 0) return true;
  if (draft.userIds.length > 0) return true;
  return false;
}

function withMissingOptions<T extends string | number>(
  options: Array<SelectOption<T>>,
  selectedValues: T[],
  missingLabel: string
): Array<SelectOption<T>> {
  const knownValues = new Set(options.map((option) => option.value));
  return [
    ...options,
    ...selectedValues.filter((value) => !knownValues.has(value)).map((value) => ({ value, label: missingLabel })),
  ];
}

function mergeOptions<T extends string | number>(
  current: Array<SelectOption<T>>,
  incoming: Array<SelectOption<T>>
): Array<SelectOption<T>> {
  return Array.from(new Map([...current, ...incoming].map((option) => [option.value, option])).values());
}

export function NotificationRulesConfig() {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const canView = canViewNotificationRules(identity);
  const canManage = canManageNotificationRules(identity);

  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<NotificationRuleDto[]>([]);
  const [eventTypes, setEventTypes] = useState<NotificationEventTypeDto[]>([]);
  const [groupOptions, setGroupOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [groupOptionsLoading, setGroupOptionsLoading] = useState(false);
  const [error, setError] = useState<{
    kind: 'engine_disabled' | 'other';
    message: string;
  } | null>(null);

  const [editor, setEditor] = useState<EditorMode>({ kind: 'closed' });
  const [draft, setDraft] = useState<NotificationRuleDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);

  const [reasonRuleId, setReasonRuleId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  const {
    data: orderStatusesData,
    isLoading: orderStatusesLoading,
    error: orderStatusesError,
  } = useList<OrderStatusRow>({
    resource: 'order_statuses',
    pagination: { pageSize: 200 },
    filters: ALL_REFERENCE_FILTER,
    sorters: [
      { field: 'sort_order', order: 'asc' },
      { field: 'order_status_id', order: 'asc' },
    ],
    queryOptions: { enabled: canView },
  });
  const {
    data: rolesData,
    isLoading: rolesLoading,
    error: rolesError,
  } = useList<RoleRow>({
    resource: 'roles',
    pagination: { mode: 'off' },
    filters: ALL_REFERENCE_FILTER,
    sorters: [{ field: 'role_name', order: 'asc' }],
    queryOptions: { enabled: canView },
  });
  const {
    data: usersData,
    isLoading: usersLoading,
    error: usersError,
  } = useList<UserRow>({
    resource: 'users',
    pagination: { pageSize: 200 },
    filters: ALL_REFERENCE_FILTER,
    sorters: [{ field: 'username', order: 'asc' }],
    queryOptions: { enabled: canView },
  });

  const eventTypeByName = useMemo(() => {
    const map = new Map<string, NotificationEventTypeDto>();
    for (const eventType of eventTypes) {
      map.set(eventType.eventType, eventType);
    }
    return map;
  }, [eventTypes]);

  const selectedEventType = editor.kind === 'closed' ? null : eventTypeByName.get(draft.eventType) ?? null;
  const groupNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of groupOptions) {
      map.set(option.value, option.label);
    }
    return map;
  }, [groupOptions]);
  const orderStatusOptions = useMemo<Array<SelectOption<number>>>(
    () =>
      (orderStatusesData?.data ?? []).map((status) => ({
        value: status.order_status_id,
        label: `${status.order_status_name}${status.is_active === false ? ' (неактивен)' : ''}`,
      })),
    [orderStatusesData]
  );
  const roleOptions = useMemo<Array<SelectOption<string>>>(
    () =>
      (rolesData?.data ?? [])
        .map((role) => ({
          value: normalizeRoleKey(role),
          label: `${role.role_name}${role.is_active === false ? ' (неактивна)' : ''}`,
        })),
    [rolesData]
  );
  const userOptions = useMemo<Array<SelectOption<number>>>(
    () =>
      (usersData?.data ?? []).map((user) => {
        const fullName = user.full_name?.trim() || user.employee?.full_name?.trim();
        return {
          value: user.user_id,
          label: `${fullName || user.username}${fullName ? ` · ${user.username}` : ''}${
            user.is_active === false ? ' (неактивен)' : ''
          }`,
        };
      }),
    [usersData]
  );
  const orderStatusNameById = useMemo(
    () => new Map(orderStatusOptions.map((option) => [option.value, option.label])),
    [orderStatusOptions]
  );
  const roleNameByCode = useMemo(
    () => new Map(roleOptions.map((option) => [option.value, option.label])),
    [roleOptions]
  );
  const userNameById = useMemo(() => new Map(userOptions.map((option) => [option.value, option.label])), [userOptions]);
  const selectedOrderStatusOptions = useMemo(
    () =>
      withMissingOptions(
        orderStatusOptions,
        [...draft.allowedFromOrderStatusIds, ...draft.excludeOrderStatusIds],
        'Статус удалён из справочника'
      ),
    [draft.allowedFromOrderStatusIds, draft.excludeOrderStatusIds, orderStatusOptions]
  );
  const selectedRoleOptions = useMemo(
    () => withMissingOptions(roleOptions, draft.roleCodes, 'Роль удалена из справочника'),
    [draft.roleCodes, roleOptions]
  );
  const selectedUserOptions = useMemo(
    () => withMissingOptions(userOptions, draft.userIds, 'Пользователь удалён из справочника'),
    [draft.userIds, userOptions]
  );
  const referencesError = orderStatusesError ?? rolesError ?? usersError;

  const loadGroupOptions = useCallback(async (search?: string) => {
    setGroupOptionsLoading(true);
    try {
      const groups = await groupsApi.listGroupOptions({
        ...(search?.trim() ? { search: search.trim() } : {}),
      });
      setGroupOptions((current) => mergeOptions(current, groups));
    } catch {
      // Keep already loaded names so list rows never fall back to raw identifiers.
    } finally {
      setGroupOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!canView) {
        setRules([]);
        setEventTypes([]);
        setGroupOptions([]);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [ruleList, events] = await Promise.all([
          notificationRulesApi.list(),
          notificationRulesApi.listEventTypes(),
        ]);
        if (cancelled) return;
        setRules(ruleList);
        setEventTypes(events);
        setGroupOptionsLoading(true);
        try {
          const groups = await groupsApi.listGroupOptions();
          if (!cancelled) setGroupOptions(groups);
        } catch {
          if (!cancelled) setGroupOptions([]);
        } finally {
          if (!cancelled) setGroupOptionsLoading(false);
        }
      } catch (loadError) {
        if (cancelled) return;
        if (loadError instanceof ApiError && loadError.status === 503) {
          setError({ kind: 'engine_disabled', message: loadError.message });
        } else {
          setError({
            kind: 'other',
            message: loadError instanceof Error ? loadError.message : 'Не удалось загрузить правила',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [canView]);

  const openCreate = () => {
    setDraft({
      ...emptyDraft(),
      eventType: eventTypes[0]?.eventType ?? '',
      ruleCode: generateNotificationRuleCode(),
    });
    setEditor({ kind: 'create' });
  };

  const openEdit = (rule: NotificationRuleDto) => {
    setDraft(buildDraftFromRule(rule));
    setEditor({ kind: 'edit', rule });
  };

  const closeEditor = () => {
    setEditor({ kind: 'closed' });
    setDraft(emptyDraft());
  };

  const updateDraft = (patch: Partial<NotificationRuleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const saveDraft = async () => {
    if (!isRecipientDraftValid(draft)) {
      message.warning('Укажите хотя бы один источник получателей');
      return;
    }
    if (draft.eventType.trim() === '') {
      message.warning('Выберите тип события');
      return;
    }
    if (draft.channels.length === 0) {
      message.warning('Выберите хотя бы один канал уведомлений');
      return;
    }

    if (editor.kind === 'create') {
      setSaving(true);
      try {
        const created = await notificationRulesApi.create(buildCreatePayload(draft));
        setRules((current) => [...current, created]);
        message.success('Правило создано');
        closeEditor();
      } catch (saveError) {
        message.error(saveError instanceof Error ? saveError.message : 'Не удалось создать правило');
      } finally {
        setSaving(false);
      }
      return;
    }

    if (editor.kind === 'edit') {
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        message.warning('Укажите причину изменения');
        return;
      }
      setSaving(true);
      try {
        const updated = await notificationRulesApi.update(
          editor.rule.notificationRuleId,
          buildUpdatePayload(draft, trimmedReason, editor.rule.updatedAt)
        );
        setRules((current) =>
          current.map((rule) => (rule.notificationRuleId === updated.notificationRuleId ? updated : rule))
        );
        message.success('Правило сохранено');
        setReasonRuleId(null);
        setReason('');
        closeEditor();
      } catch (saveError) {
        const messageText = saveError instanceof Error ? saveError.message : 'Не удалось сохранить правило';
        if (saveError instanceof ApiError && saveError.status === 409) {
          message.error('Версия правила изменилась. Перезагрузите список и повторите попытку.');
        } else {
          message.error(messageText);
        }
      } finally {
        setSaving(false);
      }
    }
  };

  const handleEditorOk = () => {
    if (editor.kind === 'edit') {
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        message.warning('Укажите причину изменения');
        return;
      }
    }
    void saveDraft();
  };

  const handleDelete = async (rule: NotificationRuleDto) => {
    setDeletingRuleId(rule.notificationRuleId);
    try {
      await notificationRulesApi.remove(rule.notificationRuleId);
      setRules((current) => current.filter((r) => r.notificationRuleId !== rule.notificationRuleId));
      message.success('Правило удалено');
    } catch (deleteError) {
      message.error(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить правило');
    } finally {
      setDeletingRuleId(null);
    }
  };

  if (!canView) {
    return (
      <Alert
        type="info"
        showIcon
        message="Нет доступа к настройкам уведомлений"
        description="Обратитесь к администратору, чтобы получить право просмотра правил уведомлений."
      />
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error?.kind === 'engine_disabled') {
    return (
      <Alert
        type="info"
        showIcon
        message="Движок уведомлений выключен на сервере"
        description="Включите серверную настройку движка уведомлений, чтобы управлять правилами."
      />
    );
  }

  if (error) {
    return <Alert type="error" showIcon message="Ошибка загрузки правил" description={error.message} />;
  }

  const editorTitle = editor.kind === 'create' ? 'Новое правило' : 'Изменить правило';
  const editorOpen = editor.kind !== 'closed';

  return (
    <Space direction="vertical" size={12} style={{ width: '100%', padding: '16px 0' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong>Правила уведомлений</Text>
        {canManage && (
          <Button type="primary" onClick={openCreate} disabled={eventTypes.length === 0}>
            Создать правило
          </Button>
        )}
      </Space>

      {referencesError && (
        <Alert
          type="warning"
          showIcon
          message="Не удалось загрузить часть справочников"
          description="Проверьте доступ к справочникам статусов, ролей и пользователей."
        />
      )}

      {rules.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={canManage ? 'Правил пока нет' : 'Нет опубликованных правил'}
        />
      ) : (
        <Table<NotificationRuleDto>
          size="small"
          rowKey="notificationRuleId"
          pagination={false}
          dataSource={rules}
          columns={[
            {
              title: 'Событие',
              dataIndex: 'eventType',
              key: 'eventType',
              width: 220,
              render: (value: string) => eventTypeLabel(value),
            },
            {
              title: 'Группа',
              dataIndex: 'groupId',
              key: 'groupId',
              width: 180,
              render: (groupId: string | null) =>
                groupId ? groupNameById.get(groupId) ?? 'Группа недоступна' : 'Все группы',
            },
            {
              title: 'Важность',
              dataIndex: 'level',
              key: 'level',
              width: 110,
              render: (value: NotificationLevel) => (
                <Tag color={value === 'error' ? 'red' : value === 'warning' ? 'orange' : 'blue'}>
                  {LEVEL_LABELS[value] ?? 'Неизвестная'}
                </Tag>
              ),
            },
            {
              title: 'Приоритет',
              dataIndex: 'priority',
              key: 'priority',
              width: 100,
            },
            {
              title: 'Каналы',
              key: 'channels',
              width: 170,
              render: (_, rule) => (
                <Space size={[4, 4]} wrap>
                  {(rule.channels ?? ['in_app']).map((channel) => (
                    <Tag key={channel} color={channel === 'telegram' ? 'cyan' : 'blue'}>
                      {CHANNEL_LABELS[channel]}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: 'Включено',
              key: 'isEnabled',
              width: 90,
              render: (_, rule) => <Switch size="small" checked={rule.isEnabled} disabled />,
            },
            {
              title: 'Получатели',
              key: 'recipients',
              render: (_, rule) => (
                <Text type="secondary">{describeRecipients(rule, roleNameByCode, userNameById)}</Text>
              ),
            },
            {
              title: 'Условия',
              key: 'conditions',
              render: (_, rule) => <Text type="secondary">{describeConditions(rule, orderStatusNameById)}</Text>,
            },
            {
              title: '',
              key: 'actions',
              width: 160,
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
                      onConfirm={() => handleDelete(rule)}
                      okText="Удалить"
                      cancelText="Отмена"
                    >
                      <Button size="small" danger loading={deletingRuleId === rule.notificationRuleId}>
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
        onOk={handleEditorOk}
        okButtonProps={{ loading: saving }}
        okText={editor.kind === 'create' ? 'Создать' : 'Сохранить'}
        cancelText="Отмена"
        width={680}
        destroyOnClose
      >
        <Form layout="vertical">
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space direction="vertical" size={2}>
              <Text type="secondary">Код правила</Text>
              <Text code copyable>
                {draft.ruleCode}
              </Text>
              <Text type="secondary">Создаётся автоматически и после сохранения не меняется.</Text>
            </Space>
          </Card>

          <Form.Item label="Тип события" required>
            <Select
              value={draft.eventType || undefined}
              onChange={(value) => updateDraft({ eventType: value })}
              disabled={editor.kind === 'edit'}
              options={eventTypes.map((eventType) => ({
                value: eventType.eventType,
                label: eventTypeLabel(eventType.eventType),
              }))}
              placeholder="Выберите событие"
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>

          <Form.Item label="Группа">
            <Select
              allowClear
              showSearch
              placeholder="Все группы"
              value={draft.groupId ?? undefined}
              options={groupOptions}
              onChange={(value) => updateDraft({ groupId: value ?? null })}
              onSearch={(value) => void loadGroupOptions(value)}
              filterOption={false}
              loading={groupOptionsLoading}
              notFoundContent={groupOptionsLoading ? <Spin size="small" /> : null}
            />
          </Form.Item>

          <Space size={12} style={{ width: '100%' }}>
            <Form.Item label="Важность" style={{ width: 180 }}>
              <Select<NotificationLevel>
                value={draft.level}
                onChange={(value) => updateDraft({ level: value })}
                options={[
                  { value: 'info', label: LEVEL_LABELS.info },
                  { value: 'warning', label: LEVEL_LABELS.warning },
                  { value: 'error', label: LEVEL_LABELS.error },
                ]}
              />
            </Form.Item>
            <Form.Item label="Приоритет" style={{ width: 160 }}>
              <InputNumber
                min={0}
                max={100000}
                value={draft.priority}
                onChange={(value) => updateDraft({ priority: Number(value ?? 0) })}
                style={{ width: 120 }}
              />
            </Form.Item>
            <Form.Item label="Включено" style={{ width: 100 }}>
              <Switch checked={draft.isEnabled} onChange={(checked) => updateDraft({ isEnabled: checked })} />
            </Form.Item>
          </Space>

          <Form.Item
            label="Канал уведомлений"
            required
            extra="Для Telegram получатель один раз подключает свой аккаунт в личном кабинете. Если Telegram не подключён, доставка этому получателю будет пропущена."
          >
            <Checkbox.Group
              value={draft.channels}
              onChange={(values) =>
                updateDraft({ channels: values as NotificationChannel[] })
              }
              style={{ width: '100%' }}
            >
              <Space direction="vertical" size={8}>
                <Checkbox value="in_app">В приложении</Checkbox>
                <Checkbox value="telegram">Telegram</Checkbox>
              </Space>
            </Checkbox.Group>
          </Form.Item>

          <Form.Item label="Условия">
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Checkbox
                checked={draft.excludeCompletedOrders}
                disabled={selectedEventType ? !selectedEventType.supportsOrderConditions : false}
                onChange={(event) => updateDraft({ excludeCompletedOrders: event.target.checked })}
              >
                Исключить завершённые заказы
              </Checkbox>
              <Select<DeadlineNotificationEntityType[]>
                mode="multiple"
                value={draft.deadlineEntityTypes}
                disabled={selectedEventType ? !selectedEventType.supportsDeadlineConditions : true}
                onChange={(values) => updateDraft({ deadlineEntityTypes: values })}
                options={Object.entries(DEADLINE_ENTITY_TYPE_LABELS).map(([value, label]) => ({
                  value: value as DeadlineNotificationEntityType,
                  label,
                }))}
                placeholder="Тип срока"
                allowClear
              />
              <Checkbox
                checked={draft.requireCurrentDeadlineEvent}
                disabled={selectedEventType ? !selectedEventType.supportsDeadlineConditions : true}
                onChange={(event) =>
                  updateDraft({
                    requireCurrentDeadlineEvent: event.target.checked,
                  })
                }
              >
                Только текущее событие срока
              </Checkbox>
              <Select<number[]>
                mode="multiple"
                value={draft.allowedFromOrderStatusIds}
                disabled={selectedEventType ? !selectedEventType.supportsOrderConditions : false}
                onChange={(values) => updateDraft({ allowedFromOrderStatusIds: values })}
                options={selectedOrderStatusOptions}
                placeholder="Разрешённые исходные статусы заказа"
                loading={orderStatusesLoading}
                optionFilterProp="label"
                showSearch
                allowClear
              />
              <Select<number[]>
                mode="multiple"
                value={draft.excludeOrderStatusIds}
                disabled={selectedEventType ? !selectedEventType.supportsOrderConditions : false}
                onChange={(values) => updateDraft({ excludeOrderStatusIds: values })}
                options={selectedOrderStatusOptions}
                placeholder="Исключённые статусы заказа"
                loading={orderStatusesLoading}
                optionFilterProp="label"
                showSearch
                allowClear
              />
            </Space>
          </Form.Item>

          <Form.Item label="Получатели" required>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Select<RecipientResolverKind[]>
                mode="multiple"
                value={draft.resolvers}
                onChange={(values) => updateDraft({ resolvers: values })}
                options={(selectedEventType?.supportedResolvers ?? []).map((resolver) => ({
                  value: resolver,
                  label: RESOLVER_LABELS[resolver] ?? 'Способ определения получателя',
                }))}
                placeholder={selectedEventType ? 'Способы определения получателей' : 'Сначала выберите тип события'}
                disabled={!selectedEventType}
                allowClear
              />
              <Select<string[]>
                mode="multiple"
                value={draft.roleCodes}
                onChange={(values) => updateDraft({ roleCodes: values })}
                options={selectedRoleOptions}
                placeholder="Роли получателей"
                loading={rolesLoading}
                optionFilterProp="label"
                showSearch
                allowClear
              />
              <Select<number[]>
                mode="multiple"
                value={draft.userIds}
                onChange={(values) => updateDraft({ userIds: values })}
                options={selectedUserOptions}
                placeholder="Пользователи-получатели"
                loading={usersLoading}
                optionFilterProp="label"
                showSearch
                allowClear
              />
            </Space>
          </Form.Item>

          <Form.Item label="Заголовок уведомления">
            <Input
              value={draft.titleTemplate}
              onChange={(event) => updateDraft({ titleTemplate: event.target.value })}
              placeholder="Оставьте пустым для значения по умолчанию"
            />
          </Form.Item>

          <Form.Item
            label="Текст уведомления"
            extra={
              <Text type="secondary">
                Допустимые переменные:{' '}
                {TEMPLATE_PLACEHOLDERS.map(
                  (placeholder) => `${TEMPLATE_PLACEHOLDER_LABELS[placeholder]} — ${placeholder}`
                ).join('; ')}
                . Прочие переменные будут удалены движком.
              </Text>
            }
          >
            <TextArea
              value={draft.messageTemplate}
              onChange={(event) => updateDraft({ messageTemplate: event.target.value })}
              rows={3}
              placeholder="У заказа {orderId} истёк срок"
            />
          </Form.Item>

          {editor.kind === 'edit' && (
            <Form.Item label="Причина изменения" required>
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Причина обязательна для аудита"
                maxLength={1000}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Space>
  );
}

import { useGetIdentity } from '@refinedev/core';
import {
  Alert,
  Button,
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
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/apiError';
import { notificationRulesApi } from '../../../api/notificationRulesApi';
import type {
  NotificationEventTypeDto,
  NotificationLevel,
  NotificationRuleDto,
  RecipientResolverKind,
} from '../../../api/types/notificationRulesApi.types';
import type { UserIdentity } from '../../../types/auth';
import {
  buildCreatePayload,
  buildDraftFromRule,
  buildUpdatePayload,
  canManageNotificationRules,
  canViewNotificationRules,
  emptyDraft,
  type NotificationRuleDraft,
} from './notificationRulesView';

const { Text } = Typography;
const { TextArea } = Input;

const TEMPLATE_PLACEHOLDERS = ['{orderId}', '{clientId}', '{orderStatusId}', '{eventType}'];

const RESOLVER_LABELS: Record<RecipientResolverKind, string> = {
  order_manager: 'Менеджер заказа',
  stage_assignee: 'Ответственный за этап',
  project_participants: 'Участники проекта',
};

const LEVEL_LABELS: Record<NotificationLevel, string> = {
  info: 'Инфо',
  warning: 'Предупреждение',
  error: 'Ошибка',
};

type EditorMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; rule: NotificationRuleDto };

function describeRecipients(rule: NotificationRuleDto): string {
  const parts: string[] = [];
  if (rule.recipients.resolvers?.length) {
    parts.push(rule.recipients.resolvers.map((r) => RESOLVER_LABELS[r] ?? r).join(', '));
  }
  if (rule.recipients.roleCodes?.length) {
    parts.push(`roles: ${rule.recipients.roleCodes.join(', ')}`);
  }
  if (rule.recipients.userIds?.length) {
    parts.push(`users: ${rule.recipients.userIds.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function isRecipientDraftValid(draft: NotificationRuleDraft): boolean {
  if (draft.resolvers.length > 0) return true;
  if (draft.roleCodesText.trim() !== '') return true;
  if (draft.userIdsText.trim() !== '') return true;
  return false;
}

export function NotificationRulesConfig() {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const canView = canViewNotificationRules(identity);
  const canManage = canManageNotificationRules(identity);

  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<NotificationRuleDto[]>([]);
  const [eventTypes, setEventTypes] = useState<NotificationEventTypeDto[]>([]);
  const [error, setError] = useState<{ kind: 'engine_disabled' | 'other'; message: string } | null>(null);

  const [editor, setEditor] = useState<EditorMode>({ kind: 'closed' });
  const [draft, setDraft] = useState<NotificationRuleDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);

  const [reasonRuleId, setReasonRuleId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  const eventTypeByName = useMemo(() => {
    const map = new Map<string, NotificationEventTypeDto>();
    for (const eventType of eventTypes) {
      map.set(eventType.eventType, eventType);
    }
    return map;
  }, [eventTypes]);

  const selectedEventType = editor.kind === 'closed' ? null : eventTypeByName.get(draft.eventType) ?? null;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!canView) {
        setRules([]);
        setEventTypes([]);
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
    setDraft({ ...emptyDraft(), eventType: eventTypes[0]?.eventType ?? '' });
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
    if (draft.ruleCode.trim() === '') {
      message.warning('Укажите ruleCode');
      return;
    }
    if (draft.eventType.trim() === '') {
      message.warning('Выберите тип события');
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
          buildUpdatePayload(draft, trimmedReason, editor.rule.updatedAt),
        );
        setRules((current) =>
          current.map((rule) =>
            rule.notificationRuleId === updated.notificationRuleId ? updated : rule,
          ),
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
      setRules((current) =>
        current.filter((r) => r.notificationRuleId !== rule.notificationRuleId),
      );
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
        description="Для просмотра нужен notifications.view_rules."
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
        description="Включите BACKEND_ENABLE_NOTIFICATION_ENGINE, чтобы управлять правилами."
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
              title: 'ruleCode',
              dataIndex: 'ruleCode',
              key: 'ruleCode',
              width: 220,
            },
            {
              title: 'Event',
              dataIndex: 'eventType',
              key: 'eventType',
              width: 220,
            },
            {
              title: 'Level',
              dataIndex: 'level',
              key: 'level',
              width: 110,
              render: (value: NotificationLevel) => (
                <Tag color={value === 'error' ? 'red' : value === 'warning' ? 'orange' : 'blue'}>
                  {LEVEL_LABELS[value] ?? value}
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
              title: 'Вкл',
              key: 'isEnabled',
              width: 70,
              render: (_, rule) => <Switch size="small" checked={rule.isEnabled} disabled />,
            },
            {
              title: 'Получатели',
              key: 'recipients',
              render: (_, rule) => <Text type="secondary">{describeRecipients(rule)}</Text>,
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
          <Form.Item label="ruleCode" required>
            <Input
              value={draft.ruleCode}
              onChange={(event) => updateDraft({ ruleCode: event.target.value })}
              disabled={editor.kind === 'edit'}
              maxLength={200}
            />
          </Form.Item>

          <Form.Item label="Тип события" required>
            <Select
              value={draft.eventType || undefined}
              onChange={(value) => updateDraft({ eventType: value })}
              disabled={editor.kind === 'edit'}
              options={eventTypes.map((eventType) => ({
                value: eventType.eventType,
                label: `${eventType.eventType} (${eventType.aggregateType})`,
              }))}
              placeholder="Выберите событие"
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>

          <Space size={12} style={{ width: '100%' }}>
            <Form.Item label="Level" style={{ width: 180 }}>
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
              <Switch
                checked={draft.isEnabled}
                onChange={(checked) => updateDraft({ isEnabled: checked })}
              />
            </Form.Item>
          </Space>

          <Form.Item label="Условия">
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Checkbox
                checked={draft.excludeCompletedOrders}
                disabled={selectedEventType ? !selectedEventType.supportsOrderConditions : false}
                onChange={(event) => updateDraft({ excludeCompletedOrders: event.target.checked })}
              >
                Исключить завершённые заказы
              </Checkbox>
              <Input
                addonBefore="Из статусов"
                value={draft.allowedFromOrderStatusIdsText}
                disabled={selectedEventType ? !selectedEventType.supportsOrderConditions : false}
                onChange={(event) => updateDraft({ allowedFromOrderStatusIdsText: event.target.value })}
                placeholder="1, 2, 3"
              />
              <Input
                addonBefore="Исключить статусы"
                value={draft.excludeOrderStatusIdsText}
                disabled={selectedEventType ? !selectedEventType.supportsOrderConditions : false}
                onChange={(event) => updateDraft({ excludeOrderStatusIdsText: event.target.value })}
                placeholder="7, 8"
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
                  label: RESOLVER_LABELS[resolver] ?? resolver,
                }))}
                placeholder={
                  selectedEventType
                    ? 'Резолверы для выбранного события'
                    : 'Сначала выберите тип события'
                }
                disabled={!selectedEventType}
                allowClear
              />
              <Input
                addonBefore="Role codes"
                value={draft.roleCodesText}
                onChange={(event) => updateDraft({ roleCodesText: event.target.value })}
                placeholder="admin, top_manager"
              />
              <Input
                addonBefore="User IDs"
                value={draft.userIdsText}
                onChange={(event) => updateDraft({ userIdsText: event.target.value })}
                placeholder="100, 200"
              />
            </Space>
          </Form.Item>

          <Form.Item label="Заголовок (titleTemplate)">
            <Input
              value={draft.titleTemplate}
              onChange={(event) => updateDraft({ titleTemplate: event.target.value })}
              placeholder="Оставьте пустым для значения по умолчанию"
            />
          </Form.Item>

          <Form.Item
            label="Текст (messageTemplate)"
            extra={
              <Text type="secondary">
                Допустимые плейсхолдеры: {TEMPLATE_PLACEHOLDERS.join(', ')}. Прочие плейсхолдеры будут
                очищены движком.
              </Text>
            }
          >
            <TextArea
              value={draft.messageTemplate}
              onChange={(event) => updateDraft({ messageTemplate: event.target.value })}
              rows={3}
              placeholder="Order {orderId} deadline expired at {eventType}"
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

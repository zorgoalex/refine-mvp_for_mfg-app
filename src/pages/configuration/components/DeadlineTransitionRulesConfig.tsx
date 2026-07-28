import { useGetIdentity, useList } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../api/apiError';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type {
  DeadlineActionRuleDto,
  DeadlineDefaultScheduleDto,
  DeadlinePolicyDto,
  DeadlineTransitionRulesReadinessDto,
} from '../../../api/types/deadlineApi.types';
import type { UserIdentity } from '../../../types/auth';
import {
  buildTransitionRuleCreatePayload,
  buildTransitionRuleDraft,
  buildTransitionRuleUpdatePayload,
  applyDeadlineTargetOption,
  buildDeadlineTargetOptions,
  canManageDeadlineTransitionRules,
  describeRuleDelay,
  describeRuleScope,
  describeTransition,
  emptyTransitionRuleDraft,
  formatStatusNames,
  getDeadlineRuleTimingKey,
  getDeadlineTargetOptionValue,
  type DeadlineTransitionRuleDraft,
} from './deadlineTransitionRulesView';

const { Text, Title } = Typography;
const { TextArea } = Input;
const ALL_STATUS_FILTER = [{ field: 'is_active', operator: 'in' as const, value: [true, false] }];

interface OrderStatusRow {
  order_status_id: number;
  order_status_name: string;
  sort_order?: number;
  is_active?: boolean;
}

type EditorMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; rule: DeadlineActionRuleDto };

type PendingAction =
  | { kind: 'toggle'; rule: DeadlineActionRuleDto; nextEnabled: boolean }
  | { kind: 'delete'; rule: DeadlineActionRuleDto };

export function DeadlineTransitionRulesConfig() {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const canManageRules = canManageDeadlineTransitionRules(identity);
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<DeadlineActionRuleDto[]>([]);
  const [policies, setPolicies] = useState<DeadlinePolicyDto[]>([]);
  const [deadlineSchedule, setDeadlineSchedule] =
    useState<DeadlineDefaultScheduleDto | null>(null);
  const [readiness, setReadiness] = useState<DeadlineTransitionRulesReadinessDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorMode>({ kind: 'closed' });
  const [draft, setDraft] = useState<DeadlineTransitionRuleDraft>(emptyTransitionRuleDraft());
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const {
    data: statusData,
    isLoading: statusesLoading,
    error: statusesError,
  } = useList<OrderStatusRow>({
    resource: 'order_statuses',
    pagination: { pageSize: 200 },
    filters: ALL_STATUS_FILTER,
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'order_status_id', order: 'asc' }],
    queryOptions: { enabled: canManageRules },
  });

  const statusOptions = useMemo(
    () =>
      (statusData?.data ?? []).map((status) => ({
        value: status.order_status_id,
        label: `${status.order_status_name}${status.is_active === false ? ' (неактивен)' : ''}`,
        disabled: status.is_active === false,
      })),
    [statusData],
  );
  const statusNames = useMemo(
    () =>
      new Map(
        (statusData?.data ?? []).map((status) => [
          status.order_status_id,
          status.order_status_name,
        ]),
      ),
    [statusData],
  );

  const load = useCallback(async () => {
    if (!canManageRules) return;
    setLoading(true);
    setError(null);
    try {
      const [rulesResponse, policiesResponse, scheduleResponse] = await Promise.all([
        deadlinesApi.listDeadlineTransitionRules(),
        deadlinesApi.listPolicies(),
        deadlinesApi.getDefaultSchedule(),
      ]);
      setRules(
        rulesResponse.data.filter(
          (rule) =>
            rule.eventType === 'DEADLINE_EXPIRED' && rule.actionType === 'change_order_status',
        ),
      );
      setPolicies(policiesResponse.data);
      setDeadlineSchedule(scheduleResponse.schedule);
      setReadiness(rulesResponse.readiness);
    } catch (loadError) {
      setError(errorText(loadError, 'Не удалось загрузить правила'));
    } finally {
      setLoading(false);
    }
  }, [canManageRules]);

  useEffect(() => {
    void load();
  }, [load]);

  const productionStatusNames = useMemo(
    () =>
      new Map(
        (deadlineSchedule?.stages ?? []).map((stage) => [
          stage.productionStatusId,
          stage.productionStatusName,
        ]),
      ),
    [deadlineSchedule],
  );
  const deadlineTargetOptions = useMemo(
    () => buildDeadlineTargetOptions(deadlineSchedule, policies),
    [deadlineSchedule, policies],
  );
  const draftTimingKey = getDeadlineRuleTimingKey(draft);
  const priorityConflict =
    editor.kind !== 'closed'
    && rules.some(
      (rule) =>
        (editor.kind !== 'edit' || rule.actionRuleId !== editor.rule.actionRuleId)
        && rule.priority === draft.priority
        && getDeadlineRuleTimingKey(buildTransitionRuleDraft(rule)) === draftTimingKey,
    );

  const openCreate = () => {
    setEditor({ kind: 'create' });
    setDraft(emptyTransitionRuleDraft());
    resetAuditFields();
  };

  const openEdit = (rule: DeadlineActionRuleDto) => {
    setEditor({ kind: 'edit', rule });
    setDraft(buildTransitionRuleDraft(rule));
    resetAuditFields();
  };

  const closeEditor = () => {
    if (saving) return;
    setEditor({ kind: 'closed' });
    resetAuditFields();
  };

  const saveRule = async () => {
    setSaving(true);
    try {
      const response =
        editor.kind === 'edit'
          ? await deadlinesApi.updateDeadlineTransitionRule(
              editor.rule.actionRuleId,
              buildTransitionRuleUpdatePayload(editor.rule, draft, reason, comment),
            )
          : await deadlinesApi.createDeadlineTransitionRule(
              buildTransitionRuleCreatePayload(draft, reason, comment),
            );
      setRules((current) =>
        editor.kind === 'edit'
          ? current.map((rule) =>
              rule.actionRuleId === response.rule.actionRuleId ? response.rule : rule,
            )
          : [...current, response.rule].sort(compareRules),
      );
      setEditor({ kind: 'closed' });
      resetAuditFields();
      message.success(editor.kind === 'edit' ? 'Правило сохранено' : 'Правило создано');
    } catch (saveError) {
      message.error(
        isConflict(saveError)
          ? 'Правило уже изменено другим пользователем. Обновите список.'
          : errorText(saveError, 'Не удалось сохранить правило'),
      );
    } finally {
      setSaving(false);
    }
  };

  const applyPendingAction = async () => {
    if (!pendingAction || !reason.trim()) {
      message.warning('Укажите причину изменения');
      return;
    }
    setSaving(true);
    try {
      if (pendingAction.kind === 'toggle') {
        const response = await deadlinesApi.updateDeadlineTransitionRule(
          pendingAction.rule.actionRuleId,
          {
            expectedUpdatedAt: pendingAction.rule.updatedAt,
            isEnabled: pendingAction.nextEnabled,
            reason: reason.trim(),
            comment: comment.trim() || null,
          },
        );
        setRules((current) =>
          current.map((rule) =>
            rule.actionRuleId === response.rule.actionRuleId ? response.rule : rule,
          ),
        );
        message.success(pendingAction.nextEnabled ? 'Правило включено' : 'Правило выключено');
      } else {
        await deadlinesApi.deleteDeadlineTransitionRule(pendingAction.rule.actionRuleId, {
          expectedUpdatedAt: pendingAction.rule.updatedAt,
          reason: reason.trim(),
          comment: comment.trim() || null,
        });
        setRules((current) =>
          current.filter((rule) => rule.actionRuleId !== pendingAction.rule.actionRuleId),
        );
        message.success('Правило удалено');
      }
      setPendingAction(null);
      resetAuditFields();
    } catch (actionError) {
      message.error(
        isConflict(actionError)
          ? 'Правило уже изменено или имеет историю выполнения. Обновите список.'
          : errorText(actionError, 'Не удалось изменить правило'),
      );
    } finally {
      setSaving(false);
    }
  };

  const openPendingAction = (action: PendingAction) => {
    setPendingAction(action);
    resetAuditFields();
  };

  if (!canManageRules) {
    return (
      <Alert
        type="info"
        showIcon
        message="Нет доступа к правилам переходов"
        description="Нужно разрешение deadlines.actions.manage."
      />
    );
  }

  if (loading || statusesLoading) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  const catalogError = statusesError
    ? errorText(statusesError, 'Не удалось загрузить статусы заказов')
    : null;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', padding: '16px 0' }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <div>
          <Title level={5} style={{ margin: 0 }}>
            Переходы статусов по дедлайну
          </Title>
          <Text type="secondary">
            При просрочке выполняется первое подходящее правило с меньшим приоритетом.
          </Text>
        </div>
        <Space>
          <Button style={actionStyle} onClick={() => void load()}>
            Обновить
          </Button>
          <Button type="primary" style={actionStyle} onClick={openCreate}>
            Создать правило
          </Button>
        </Space>
      </Space>

      {readiness && <ReadinessAlert readiness={readiness} />}
      {error && (
        <Alert
          type="error"
          showIcon
          message="Ошибка загрузки правил"
          description={error}
          action={<Button onClick={() => void load()}>Повторить</Button>}
        />
      )}
      {catalogError && (
        <Alert type="error" showIcon message="Ошибка справочника статусов" description={catalogError} />
      )}

      {!error && rules.length === 0 ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Правил пока нет. Создайте первое правило — оно будет выключено по умолчанию."
          >
            <Button type="primary" style={actionStyle} onClick={openCreate}>
              Создать правило
            </Button>
          </Empty>
        </Card>
      ) : (
        <Table<DeadlineActionRuleDto>
          rowKey="actionRuleId"
          pagination={false}
          dataSource={rules}
          scroll={{ x: 1080 }}
          columns={[
            {
              title: 'Правило',
              key: 'name',
              width: 220,
              render: (_, rule) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{rule.config?.ruleName || `Правило ${rule.actionRuleId.slice(0, 8)}`}</Text>
                  {rule.config?.ruleCode && <Text type="secondary">{rule.config.ruleCode}</Text>}
                </Space>
              ),
            },
            {
              title: 'Дедлайн',
              key: 'scope',
              width: 210,
              render: (_, rule) =>
                describeRuleScope(rule, policies, productionStatusNames),
            },
            {
              title: 'Переход',
              key: 'transition',
              render: (_, rule) => describeTransition(rule, { statusNames, policyNames: new Map() }),
            },
            {
              title: 'Срок после дедлайна',
              key: 'delay',
              width: 145,
              render: (_, rule) => (
                <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {describeRuleDelay(rule)}
                </Text>
              ),
            },
            {
              title: 'Исключения',
              key: 'guards',
              width: 190,
              render: (_, rule) => (
                <Space direction="vertical" size={0}>
                  <Text>
                    {rule.config?.conditions?.excludeCompletedOrders ?? true
                      ? 'Завершённые исключены'
                      : 'Включая завершённые'}
                  </Text>
                  {!!rule.config?.conditions?.excludeOrderStatusIds?.length && (
                    <Text type="secondary">
                      Кроме:{' '}
                      {formatStatusNames(
                        rule.config.conditions.excludeOrderStatusIds,
                        statusNames,
                      )}
                    </Text>
                  )}
                </Space>
              ),
            },
            {
              title: 'Приоритет',
              dataIndex: 'priority',
              width: 100,
              render: (value: number) => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
              ),
            },
            {
              title: 'Состояние',
              key: 'state',
              width: 125,
              render: (_, rule) => (
                <Space>
                  <Switch
                    checked={rule.isEnabled}
                    aria-label={`${rule.isEnabled ? 'Выключить' : 'Включить'} правило`}
                    onChange={(checked) =>
                      openPendingAction({ kind: 'toggle', rule, nextEnabled: checked })
                    }
                  />
                  <Tag color={rule.isEnabled ? 'green' : 'default'}>
                    {rule.isEnabled ? 'Включено' : 'Выключено'}
                  </Tag>
                </Space>
              ),
            },
            {
              title: 'Действия',
              key: 'actions',
              width: 190,
              render: (_, rule) => (
                <Space>
                  <Button style={actionStyle} onClick={() => openEdit(rule)}>
                    Изменить
                  </Button>
                  <Button
                    danger
                    style={actionStyle}
                    onClick={() => openPendingAction({ kind: 'delete', rule })}
                  >
                    Удалить
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      )}

      <Modal
        title={editor.kind === 'edit' ? 'Изменить правило' : 'Новое правило'}
        open={editor.kind !== 'closed'}
        onCancel={closeEditor}
        onOk={() => void saveRule()}
        okText="Сохранить"
        cancelText="Отмена"
        confirmLoading={saving}
        width={720}
        destroyOnClose
      >
        <RuleEditor
          draft={draft}
          onChange={setDraft}
          deadlineTargetOptions={deadlineTargetOptions}
          statusOptions={statusOptions}
          reason={reason}
          comment={comment}
          onReasonChange={setReason}
          onCommentChange={setComment}
          priorityConflict={priorityConflict}
        />
      </Modal>

      <Modal
        title={pendingAction?.kind === 'delete' ? 'Удалить правило' : 'Изменить состояние правила'}
        open={pendingAction !== null}
        onCancel={() => !saving && setPendingAction(null)}
        onOk={() => void applyPendingAction()}
        okText={pendingAction?.kind === 'delete' ? 'Удалить' : 'Подтвердить'}
        okButtonProps={{ danger: pendingAction?.kind === 'delete', disabled: !reason.trim() }}
        confirmLoading={saving}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {pendingAction?.kind === 'delete' && (
            <Alert
              type="warning"
              showIcon
              message="Правило с историей выполнения удалить нельзя"
              description="Такое правило нужно выключить, чтобы сохранить аудит."
            />
          )}
          {pendingAction?.kind === 'toggle'
            && pendingAction.nextEnabled
            && !pendingAction.rule.policyId
            && (!pendingAction.rule.config?.deadlineTarget
              || pendingAction.rule.config.deadlineTarget.type === 'all_order_deadlines') && (
              <Alert
                type="warning"
                showIcon
                message="Будет включено правило для всех дедлайнов заказа"
                description="Проверьте приоритет и backlog просроченных дедлайнов перед подтверждением."
              />
            )}
          <AuditFields
            reason={reason}
            comment={comment}
            onReasonChange={setReason}
            onCommentChange={setComment}
          />
        </Space>
      </Modal>
    </Space>
  );

  function resetAuditFields() {
    setReason('');
    setComment('');
  }
}

function RuleEditor(props: {
  draft: DeadlineTransitionRuleDraft;
  onChange: (draft: DeadlineTransitionRuleDraft) => void;
  deadlineTargetOptions: Array<{ value: string; label: string }>;
  statusOptions: Array<{ value: number; label: string; disabled: boolean }>;
  reason: string;
  comment: string;
  onReasonChange: (value: string) => void;
  onCommentChange: (value: string) => void;
  priorityConflict: boolean;
}) {
  const patch = (value: Partial<DeadlineTransitionRuleDraft>) =>
    props.onChange({ ...props.draft, ...value });

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <label>
        <Text strong>Название</Text>
        <Input
          value={props.draft.ruleName}
          maxLength={160}
          onChange={(event) => patch({ ruleName: event.target.value })}
          placeholder="Например: Просрочена выдача"
        />
      </label>
      <label>
        <Text strong>Код (необязательно)</Text>
        <Input
          value={props.draft.ruleCode}
          maxLength={100}
          onChange={(event) => patch({ ruleCode: event.target.value })}
          placeholder="overdue-issue"
        />
      </label>
      <label>
        <Text strong>Для какого дедлайна</Text>
        <Select
          value={getDeadlineTargetOptionValue(props.draft)}
          options={props.deadlineTargetOptions}
          onChange={(value) =>
            props.onChange(applyDeadlineTargetOption(props.draft, value))
          }
          showSearch
          optionFilterProp="label"
          style={{ width: '100%', minHeight: 44 }}
        />
      </label>
      {props.draft.policyId === null
        && props.draft.deadlineTarget.type === 'all_order_deadlines' && (
        <Alert
          type="warning"
          showIcon
          message="Правило применяется ко всем дедлайнам, связанным с заказом"
        />
      )}
      <Card size="small">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
            <div>
              <Text strong>Добавить срок после дедлайна</Text>
              <div>
                <Text type="secondary">
                  Отсчёт начинается от выбранного дедлайна.
                </Text>
              </div>
            </div>
            <Switch
              checked={props.draft.delayAfterDeadlineEnabled}
              aria-label="Добавить срок после дедлайна"
              onChange={(checked) => patch({
                delayAfterDeadlineEnabled: checked,
                ...(!checked
                  ? { delayDays: 0, delayHours: 0, delayMinutes: 0 }
                  : {}),
              })}
            />
          </Space>
          {props.draft.delayAfterDeadlineEnabled && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 12,
                }}
              >
                <label>
                  <Text strong>Дни</Text>
                  <InputNumber
                    min={0}
                    max={3650}
                    precision={0}
                    value={props.draft.delayDays}
                    onChange={(value) => patch({ delayDays: Number(value ?? 0) })}
                    style={{ width: '100%', minHeight: 44 }}
                  />
                </label>
                <label>
                  <Text strong>Часы</Text>
                  <InputNumber
                    min={0}
                    max={23}
                    precision={0}
                    value={props.draft.delayHours}
                    onChange={(value) => patch({ delayHours: Number(value ?? 0) })}
                    style={{ width: '100%', minHeight: 44 }}
                  />
                </label>
                <label>
                  <Text strong>Минуты</Text>
                  <InputNumber
                    min={0}
                    max={59}
                    precision={0}
                    value={props.draft.delayMinutes}
                    onChange={(value) => patch({ delayMinutes: Number(value ?? 0) })}
                    style={{ width: '100%', minHeight: 44 }}
                  />
                </label>
              </div>
              <Text type="secondary">
                Хотя бы одно значение должно быть больше нуля. Если срок уже прошёл,
                правило сработает при ближайшем запуске планировщика.
              </Text>
            </>
          )}
        </Space>
      </Card>
      {props.priorityConflict && (
        <Alert
          type="warning"
          showIcon
          message="Есть другое правило с тем же приоритетом и областью"
          description="Порядок тогда определяется датой создания. Лучше задать разные приоритеты."
        />
      )}
      <label>
        <Text strong>Из статусов</Text>
        <Select
          mode="multiple"
          value={props.draft.allowedFromOrderStatusIds}
          options={props.statusOptions}
          onChange={(value) => patch({ allowedFromOrderStatusIds: value })}
          showSearch
          optionFilterProp="label"
          style={{ width: '100%', minHeight: 44 }}
          placeholder="Выберите исходные статусы"
        />
      </label>
      <label>
        <Text strong>Перевести в статус</Text>
        <Select
          value={props.draft.targetOrderStatusId}
          options={props.statusOptions}
          onChange={(value) => patch({ targetOrderStatusId: value })}
          showSearch
          optionFilterProp="label"
          style={{ width: '100%', minHeight: 44 }}
          placeholder="Выберите целевой статус"
        />
      </label>
      <label>
        <Text strong>Не применять в статусах</Text>
        <Select
          mode="multiple"
          allowClear
          value={props.draft.excludeOrderStatusIds}
          options={props.statusOptions}
          onChange={(value) => patch({ excludeOrderStatusIds: value })}
          showSearch
          optionFilterProp="label"
          style={{ width: '100%', minHeight: 44 }}
          placeholder="Необязательно"
        />
      </label>
      <Space wrap size={20}>
        <Checkbox
          checked
          disabled
        >
          Не менять завершённые заказы (обязательная защита)
        </Checkbox>
        <Checkbox
          checked
          disabled
        >
          Только актуальная просрочка (обязательная защита)
        </Checkbox>
      </Space>
      <Space wrap size={24}>
        <label>
          <Text strong>Приоритет</Text>
          <InputNumber
            min={0}
            max={100000}
            precision={0}
            value={props.draft.priority}
            onChange={(value) => patch({ priority: Number(value ?? 100) })}
            style={{ display: 'block', minHeight: 44 }}
          />
        </label>
        <label>
          <Text strong>Состояние</Text>
          <Space style={{ display: 'flex', minHeight: 44 }}>
            <Switch
              checked={props.draft.isEnabled}
              onChange={(checked) => patch({ isEnabled: checked })}
            />
            <Text>{props.draft.isEnabled ? 'Включено' : 'Выключено'}</Text>
          </Space>
        </label>
      </Space>
      <AuditFields
        reason={props.reason}
        comment={props.comment}
        onReasonChange={props.onReasonChange}
        onCommentChange={props.onCommentChange}
      />
    </Space>
  );
}

function AuditFields(props: {
  reason: string;
  comment: string;
  onReasonChange: (value: string) => void;
  onCommentChange: (value: string) => void;
}) {
  return (
    <>
      <label>
        <Text strong>Причина изменения</Text>
        <Input
          value={props.reason}
          maxLength={1000}
          onChange={(event) => props.onReasonChange(event.target.value)}
          placeholder="Обязательно для аудита"
        />
      </label>
      <label>
        <Text strong>Комментарий (необязательно)</Text>
        <TextArea
          value={props.comment}
          rows={3}
          maxLength={2000}
          showCount
          onChange={(event) => props.onCommentChange(event.target.value)}
        />
      </label>
    </>
  );
}

export function ReadinessAlert({ readiness }: { readiness: DeadlineTransitionRulesReadinessDto }) {
  if (readiness.inProcessAutomaticReady) {
    return (
      <Alert
        type="success"
        showIcon
        message="Автоматическое выполнение настроено"
        description={`Планировщик: ${readiness.schedulerOwner}. Действия включены.`}
      />
    );
  }

  if (readiness.externalSchedulerOwnerSelected && readiness.manualMutationReady) {
    return (
      <Alert
        type="info"
        showIcon
        message="Выбран внешний планировщик"
        description="Backend готов выполнять действия, но наличие и здоровье внешнего cron проверяется отдельно."
      />
    );
  }

  const blockers = [
    !readiness.deadlinesEnabled && 'Deadline Engine выключен',
    readiness.deadlinesReadOnly && 'включён режим только чтения',
    !readiness.workerEnabled && 'worker выключен',
    !readiness.actionsEnabled && 'изменение статусов глобально выключено',
    readiness.schedulerOwner === 'none' && 'планировщик не назначен',
  ].filter(Boolean);

  return (
    <Alert
      type="warning"
      showIcon
      message="Правила сохраняются, но автоматически не выполняются"
      description={blockers.join('; ')}
    />
  );
}

function compareRules(left: DeadlineActionRuleDto, right: DeadlineActionRuleDto): number {
  return left.priority - right.priority || left.createdAt.localeCompare(right.createdAt);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

const actionStyle = { minHeight: 44 };

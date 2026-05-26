import { useGetIdentity } from '@refinedev/core';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type { DeadlineActionRuleDto } from '../../../api/types/deadlineApi.types';
import type { UserIdentity } from '../../../types/auth';
import {
  buildTransitionRuleDraft,
  buildTransitionRuleUpdatePayload,
  canManageDeadlineTransitionRules,
  type DeadlineTransitionRuleDraft,
} from './deadlineTransitionRulesView';

const { Text } = Typography;
const { TextArea } = Input;

export function DeadlineTransitionRulesConfig() {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const canManageRules = canManageDeadlineTransitionRules(identity);
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<DeadlineActionRuleDto[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DeadlineTransitionRuleDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingRuleId, setSavingRuleId] = useState<string | null>(null);
  const [reasonRuleId, setReasonRuleId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadRules() {
      if (!canManageRules) {
        setRules([]);
        setDrafts({});
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const response = await deadlinesApi.listDeadlineTransitionRules();
        if (cancelled) return;
        const transitionRules = response.data.filter(
          (rule) =>
            rule.eventType === 'DEADLINE_EXPIRED' && rule.actionType === 'change_order_status',
        );
        setRules(transitionRules);
        setDrafts(
          Object.fromEntries(
            transitionRules.map((rule) => [rule.actionRuleId, buildTransitionRuleDraft(rule)]),
          ),
        );
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить правила');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadRules();

    return () => {
      cancelled = true;
    };
  }, [canManageRules]);

  const selectedRule = useMemo(
    () => rules.find((rule) => rule.actionRuleId === reasonRuleId) ?? null,
    [reasonRuleId, rules],
  );

  const updateDraft = (
    actionRuleId: string,
    patch: Partial<DeadlineTransitionRuleDraft>,
  ) => {
    setDrafts((current) => ({
      ...current,
      [actionRuleId]: {
        ...current[actionRuleId],
        ...patch,
      },
    }));
  };

  const openReasonModal = (actionRuleId: string) => {
    setReasonRuleId(actionRuleId);
    setReason('');
    setComment('');
  };

  const saveSelectedRule = async () => {
    const trimmedReason = reason.trim();
    if (!selectedRule || !trimmedReason) {
      message.warning('Укажите причину изменения');
      return;
    }

    const draft = drafts[selectedRule.actionRuleId];
    if (!draft) return;

    setSavingRuleId(selectedRule.actionRuleId);
    try {
      const response = await deadlinesApi.updateDeadlineTransitionRule(
        selectedRule.actionRuleId,
        buildTransitionRuleUpdatePayload(draft, trimmedReason, comment),
      );
      const updatedRule = response.rule;
      setRules((current) =>
        current.map((rule) =>
          rule.actionRuleId === updatedRule.actionRuleId ? updatedRule : rule,
        ),
      );
      setDrafts((current) => ({
        ...current,
        [updatedRule.actionRuleId]: buildTransitionRuleDraft(updatedRule),
      }));
      setReasonRuleId(null);
      setReason('');
      setComment('');
      message.success('Правило сохранено');
    } catch (saveError) {
      message.error(saveError instanceof Error ? saveError.message : 'Не удалось сохранить правило');
    } finally {
      setSavingRuleId(null);
    }
  };

  if (!canManageRules) {
    return (
      <Alert
        type="info"
        showIcon
        message="Нет доступа к настройкам Deadline rules"
        description="Для просмотра глобальных правил нужен deadlines.actions.manage."
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

  if (error) {
    return <Alert type="error" showIcon message="Ошибка загрузки правил" description={error} />;
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%', padding: '16px 0' }}>
      <Text strong>DEADLINE_EXPIRED {'->'} change_order_status</Text>
      {rules.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Правила перехода не найдены" />
      ) : (
        <Table<DeadlineActionRuleDto>
          size="small"
          rowKey="actionRuleId"
          pagination={false}
          dataSource={rules}
          columns={[
            {
              title: 'Rule ID',
              dataIndex: 'actionRuleId',
              key: 'actionRuleId',
              width: 240,
            },
            {
              title: 'Вкл',
              key: 'isEnabled',
              width: 70,
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <Switch
                    size="small"
                    checked={draft?.isEnabled ?? rule.isEnabled}
                    onChange={(checked) => updateDraft(rule.actionRuleId, { isEnabled: checked })}
                  />
                );
              },
            },
            {
              title: 'Приоритет',
              key: 'priority',
              width: 115,
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <InputNumber
                    min={0}
                    max={100000}
                    value={draft?.priority ?? rule.priority}
                    onChange={(value) =>
                      updateDraft(rule.actionRuleId, { priority: Number(value ?? 0) })
                    }
                    style={{ width: 90 }}
                  />
                );
              },
            },
            {
              title: 'Целевой статус',
              key: 'targetOrderStatusId',
              width: 130,
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <InputNumber
                    min={1}
                    value={draft?.targetOrderStatusId}
                    onChange={(value) =>
                      updateDraft(rule.actionRuleId, { targetOrderStatusId: value ?? null })
                    }
                    style={{ width: 105 }}
                  />
                );
              },
            },
            {
              title: 'Из статусов',
              key: 'allowedFromOrderStatusIds',
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <Input
                    value={draft?.allowedFromOrderStatusIdsText ?? ''}
                    onChange={(event) =>
                      updateDraft(rule.actionRuleId, {
                        allowedFromOrderStatusIdsText: event.target.value,
                      })
                    }
                    placeholder="1, 2, 3"
                  />
                );
              },
            },
            {
              title: 'Исключить',
              key: 'excludeOrderStatusIds',
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <Input
                    value={draft?.excludeOrderStatusIdsText ?? ''}
                    onChange={(event) =>
                      updateDraft(rule.actionRuleId, {
                        excludeOrderStatusIdsText: event.target.value,
                      })
                    }
                    placeholder="7, 8"
                  />
                );
              },
            },
            {
              title: 'Completed',
              key: 'excludeCompletedOrders',
              width: 120,
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <Checkbox
                    checked={draft?.excludeCompletedOrders ?? true}
                    onChange={(event) =>
                      updateDraft(rule.actionRuleId, {
                        excludeCompletedOrders: event.target.checked,
                      })
                    }
                  />
                );
              },
            },
            {
              title: 'Current event',
              key: 'requireCurrentDeadlineEvent',
              width: 125,
              render: (_, rule) => {
                const draft = drafts[rule.actionRuleId];
                return (
                  <Checkbox
                    checked={draft?.requireCurrentDeadlineEvent ?? true}
                    onChange={(event) =>
                      updateDraft(rule.actionRuleId, {
                        requireCurrentDeadlineEvent: event.target.checked,
                      })
                    }
                  />
                );
              },
            },
            {
              title: 'Состояние',
              key: 'state',
              width: 110,
              render: (_, rule) => (
                <Tag color={rule.isEnabled ? 'green' : 'default'}>
                  {rule.isEnabled ? 'Включено' : 'Выключено'}
                </Tag>
              ),
            },
            {
              title: '',
              key: 'save',
              width: 110,
              render: (_, rule) => (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => openReasonModal(rule.actionRuleId)}
                  loading={savingRuleId === rule.actionRuleId}
                >
                  Сохранить
                </Button>
              ),
            },
          ]}
        />
      )}
      <Modal
        title="Причина изменения правила"
        open={!!reasonRuleId}
        onCancel={() => setReasonRuleId(null)}
        onOk={saveSelectedRule}
        okButtonProps={{ disabled: !reason.trim(), loading: !!savingRuleId }}
        confirmLoading={!!savingRuleId}
        okText="Сохранить"
        cancelText="Отмена"
        destroyOnClose
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text>Причина обязательна для аудита.</Text>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            placeholder="Причина изменения"
          />
          <TextArea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={2000}
            showCount
            placeholder="Комментарий"
          />
        </Space>
      </Modal>
    </Space>
  );
}

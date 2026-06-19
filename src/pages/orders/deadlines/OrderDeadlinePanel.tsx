import { useGetIdentity } from '@refinedev/core';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type {
  DeadlineDto,
  DeadlineEventDto,
  DeadlineOrderOverrideTargetType,
  OrderDeadlineSummary,
  OrderEffectiveDeadlineRulesResponse,
  PreviewOrderDeadlineActionRulesResponse,
} from '../../../api/types/deadlineApi.types';
import { featureFlags } from '../../../config/featureFlags';
import type { UserIdentity } from '../../../types/auth';
import {
  buildDeadlineEventRows,
  buildDeadlineRows,
  formatDeadlineDate,
  formatDeadlineDuration,
  getDeadlineSeverityColor,
  summarizeDeadlineCounts,
} from './orderDeadlineView';
import {
  buildDisableOrderOverrideRequest,
  buildEffectiveActionRuleRows,
  buildEffectivePolicyRows,
  buildOrderOverrideRows,
  buildPreviewActionRuleRows,
  canEditOrderDeadlineOverrides,
  canViewOrderDeadlineRules,
  loadOrderDeadlinePanelData,
} from './orderDeadlineRulesView';

const { Panel } = Collapse;
const { Text } = Typography;
const { TextArea } = Input;

interface OrderDeadlinePanelProps {
  orderId: number | null | undefined;
  embedded?: boolean;
}

interface DeadlinePanelState {
  loading: boolean;
  summary: OrderDeadlineSummary | null;
  deadlines: DeadlineDto[];
  events: DeadlineEventDto[];
  effectiveRules: OrderEffectiveDeadlineRulesResponse | null;
  preview: PreviewOrderDeadlineActionRulesResponse | null;
  rulesError: string | null;
  previewUnavailableReason: string | null;
  error: string | null;
}

const initialState: DeadlinePanelState = {
  loading: false,
  summary: null,
  deadlines: [],
  events: [],
  effectiveRules: null,
  preview: null,
  rulesError: null,
  previewUnavailableReason: null,
  error: null,
};

interface OverrideModalState {
  mode: 'disable' | 'restore';
  targetType: DeadlineOrderOverrideTargetType;
  targetId: string;
  overrideId?: string | null;
  title: string;
}

export function OrderDeadlinePanel({ orderId, embedded = false }: OrderDeadlinePanelProps) {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const [state, setState] = useState<DeadlinePanelState>(initialState);
  const [reloadKey, setReloadKey] = useState(0);
  const [overrideModal, setOverrideModal] = useState<OverrideModalState | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const enabled = featureFlags.useBackendDeadlines && !!orderId;
  const canViewRules = canViewOrderDeadlineRules(identity);
  const canEditOverrides = canEditOrderDeadlineOverrides(identity);

  useEffect(() => {
    let cancelled = false;

    async function loadDeadlines() {
      if (!enabled || !orderId) {
        setState(initialState);
        return;
      }

      setState({
        loading: true,
        summary: null,
        deadlines: [],
        events: [],
        effectiveRules: null,
        preview: null,
        rulesError: null,
        previewUnavailableReason: null,
        error: null,
      });

      try {
        const result = await loadOrderDeadlinePanelData({
          orderId,
          canViewRules,
          api: deadlinesApi,
        });

        if (cancelled) return;

        setState({
          loading: false,
          summary: result.summary,
          deadlines: result.deadlines,
          events: result.events,
          effectiveRules: result.effectiveRules,
          preview: result.preview,
          rulesError: result.rulesError,
          previewUnavailableReason: result.previewUnavailableReason,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          loading: false,
          summary: null,
          deadlines: [],
          events: [],
          effectiveRules: null,
          preview: null,
          rulesError: null,
          previewUnavailableReason: null,
          error: error instanceof Error ? error.message : 'Не удалось загрузить дедлайны',
        });
      }
    }

    void loadDeadlines();

    return () => {
      cancelled = true;
    };
  }, [canViewRules, enabled, orderId, reloadKey]);

  const deadlineRows = useMemo(() => buildDeadlineRows(state.deadlines), [state.deadlines]);
  const eventRows = useMemo(() => buildDeadlineEventRows(state.events), [state.events]);
  const policyRows = useMemo(
    () => buildEffectivePolicyRows(state.effectiveRules),
    [state.effectiveRules],
  );
  const actionRuleRows = useMemo(
    () => buildEffectiveActionRuleRows(state.effectiveRules),
    [state.effectiveRules],
  );
  const previewRows = useMemo(() => buildPreviewActionRuleRows(state.preview), [state.preview]);
  const overrideRows = useMemo(
    () => buildOrderOverrideRows(state.effectiveRules?.overrides ?? []),
    [state.effectiveRules],
  );
  const finalDeadlineColor = state.summary?.finalDeadline
    ? getDeadlineSeverityColor(state.summary.finalDeadline.severity)
    : undefined;
  const currentStageDeadlineColor = state.summary?.currentStageDeadline
    ? getDeadlineSeverityColor(state.summary.currentStageDeadline.severity)
    : undefined;

  if (!featureFlags.useBackendDeadlines) {
    return null;
  }

  const openDisableModal = (
    targetType: DeadlineOrderOverrideTargetType,
    targetId: string,
    title: string,
  ) => {
    setOverrideReason('');
    setOverrideModal({ mode: 'disable', targetType, targetId, title });
  };

  const openRestoreModal = (
    targetType: DeadlineOrderOverrideTargetType,
    targetId: string,
    overrideId: string | null,
    title: string,
  ) => {
    if (!overrideId) return;
    setOverrideReason('');
    setOverrideModal({ mode: 'restore', targetType, targetId, overrideId, title });
  };

  const submitOverrideChange = async () => {
    const reason = overrideReason.trim();
    if (!orderId || !overrideModal || !reason) {
      message.warning('Укажите причину изменения');
      return;
    }

    setSavingOverride(true);
    try {
      if (overrideModal.mode === 'disable') {
        await deadlinesApi.upsertOrderOverride(
          orderId,
          buildDisableOrderOverrideRequest(overrideModal.targetType, overrideModal.targetId, reason),
        );
      } else if (overrideModal.overrideId) {
        await deadlinesApi.retireOrderOverride(orderId, overrideModal.overrideId, { reason });
      }
      message.success('Настройка сохранена');
      setOverrideModal(null);
      setOverrideReason('');
      setReloadKey((value) => value + 1);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить настройку');
    } finally {
      setSavingOverride(false);
    }
  };

  const content = (
    <>
      {state.loading ? (
            <Spin />
          ) : state.error ? (
            <Alert type="error" message="Ошибка загрузки дедлайнов" description={state.error} showIcon />
          ) : (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text>{summarizeDeadlineCounts(state.summary)}</Text>
              <Space wrap size={8}>
                <Tag color={finalDeadlineColor}>
                  Финальный: {formatDeadlineDate(state.summary?.finalDeadline?.deadlineAt)}
                </Tag>
                <Tag color={currentStageDeadlineColor}>
                  Текущий этап: {formatDeadlineDate(state.summary?.currentStageDeadline?.deadlineAt)}
                </Tag>
                <Tag>
                  До текущего этапа: {formatDeadlineDuration(state.summary?.currentStageDeadline?.remainingMinutes ?? null)}
                </Tag>
              </Space>
              {deadlineRows.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Дедлайны не найдены" />
              ) : (
                <Table
                  size="small"
                  rowKey="key"
                  pagination={false}
                  dataSource={deadlineRows}
                  columns={[
                    { title: 'Тип', dataIndex: 'entity', key: 'entity', width: 140 },
                    { title: 'Срок', dataIndex: 'deadlineAt', key: 'deadlineAt', width: 170 },
                    {
                      title: 'Статус',
                      dataIndex: 'status',
                      key: 'status',
                      width: 150,
                      render: (value, row) => <Tag color={row.severityColor}>{value}</Tag>,
                    },
                    { title: 'Источник', dataIndex: 'source', key: 'source', width: 120 },
                    { title: 'Обновлен', dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
                  ]}
                />
              )}
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                dataSource={eventRows}
                locale={{ emptyText: 'События дедлайнов не найдены' }}
                columns={[
                  { title: 'Событие', dataIndex: 'eventType', key: 'eventType' },
                  {
                    title: 'Важность',
                    dataIndex: 'severity',
                    key: 'severity',
                    width: 110,
                    render: (value, row) => <Tag color={row.severityColor}>{value}</Tag>,
                  },
                  { title: 'Дата', dataIndex: 'eventAt', key: 'eventAt', width: 170 },
                  { title: 'Задержка', dataIndex: 'delay', key: 'delay', width: 120 },
                ]}
              />
              {canViewRules && (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text strong>Правила таймеров и действий</Text>
                  {state.rulesError && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Правила дедлайнов недоступны"
                      description={state.rulesError}
                    />
                  )}
                  <Table
                    size="small"
                    rowKey="key"
                    pagination={false}
                    dataSource={policyRows}
                    locale={{ emptyText: 'Глобальные таймеры не найдены' }}
                    columns={[
                      { title: 'Таймер', dataIndex: 'name', key: 'name' },
                      { title: 'Код', dataIndex: 'code', key: 'code', width: 180 },
                      {
                        title: 'Состояние',
                        key: 'state',
                        width: 140,
                        render: (_, row) => (
                          <Space size={4} wrap>
                            <Tag color={row.enabled ? 'green' : 'default'}>
                              {row.enabled ? 'Включен' : 'Выключен'}
                            </Tag>
                            {row.overrideDisabled && <Tag color="red">Отключен для заказа</Tag>}
                          </Space>
                        ),
                      },
                      ...(canEditOverrides
                        ? [
                            {
                              title: 'Действие',
                              key: 'action',
                              width: 120,
                              render: (_: unknown, row: (typeof policyRows)[number]) =>
                                row.overrideDisabled ? (
                                  <Button
                                    size="small"
                                    onClick={() =>
                                      openRestoreModal(
                                        'policy',
                                        row.policyId,
                                        row.overrideId,
                                        `Восстановить таймер ${row.name}`,
                                      )
                                    }
                                  >
                                    Вернуть
                                  </Button>
                                ) : (
                                  <Button
                                    size="small"
                                    danger
                                    onClick={() =>
                                      openDisableModal(
                                        'policy',
                                        row.policyId,
                                        `Отключить таймер ${row.name}`,
                                      )
                                    }
                                  >
                                    Отключить
                                  </Button>
                                ),
                            },
                          ]
                        : []),
                    ]}
                  />
                  <Table
                    size="small"
                    rowKey="key"
                    pagination={false}
                    dataSource={actionRuleRows}
                    locale={{ emptyText: 'Глобальные action rules не найдены' }}
                    columns={[
                      { title: 'Действие', dataIndex: 'actionType', key: 'actionType', width: 170 },
                      { title: 'Приоритет', dataIndex: 'priority', key: 'priority', width: 90 },
                      { title: 'Целевой статус', dataIndex: 'targetStatusId', key: 'targetStatusId', width: 120 },
                      { title: 'Из статусов', dataIndex: 'allowedFrom', key: 'allowedFrom' },
                      { title: 'Исключая', dataIndex: 'excluded', key: 'excluded' },
                      {
                        title: 'Состояние',
                        key: 'state',
                        width: 150,
                        render: (_, row) => (
                          <Space size={4} wrap>
                            <Tag color={row.enabled ? 'green' : 'default'}>
                              {row.enabled ? 'Включено' : 'Выключено'}
                            </Tag>
                            {row.overrideDisabled && <Tag color="red">Отключено для заказа</Tag>}
                          </Space>
                        ),
                      },
                      ...(canEditOverrides
                        ? [
                            {
                              title: 'Действие',
                              key: 'action',
                              width: 120,
                              render: (_: unknown, row: (typeof actionRuleRows)[number]) =>
                                row.overrideDisabled ? (
                                  <Button
                                    size="small"
                                    onClick={() =>
                                      openRestoreModal(
                                        'action_rule',
                                        row.actionRuleId,
                                        row.overrideId,
                                        `Восстановить действие ${row.actionType}`,
                                      )
                                    }
                                  >
                                    Вернуть
                                  </Button>
                                ) : (
                                  <Button
                                    size="small"
                                    danger
                                    onClick={() =>
                                      openDisableModal(
                                        'action_rule',
                                        row.actionRuleId,
                                        `Отключить действие ${row.actionType}`,
                                      )
                                    }
                                  >
                                    Отключить
                                  </Button>
                                ),
                            },
                          ]
                        : []),
                    ]}
                  />
                  <Text type="secondary">
                    Dry-run: {state.preview?.selectionReason ?? state.previewUnavailableReason ?? 'нет данных'}
                  </Text>
                  <Table
                    size="small"
                    rowKey="key"
                    pagination={false}
                    dataSource={previewRows}
                    locale={{ emptyText: 'Dry-run кандидаты не найдены' }}
                    columns={[
                      { title: 'Rule ID', dataIndex: 'actionRuleId', key: 'actionRuleId' },
                      { title: 'Приоритет', dataIndex: 'priority', key: 'priority', width: 90 },
                      { title: 'Целевой статус', dataIndex: 'targetStatusId', key: 'targetStatusId', width: 120 },
                      {
                        title: 'Результат',
                        key: 'result',
                        width: 190,
                        render: (_, row) => (
                          <Space size={4} wrap>
                            <Tag color={row.wouldRun ? 'green' : 'orange'}>
                              {row.wouldRun ? 'wouldRun' : 'skipped'}
                            </Tag>
                            {row.selected && <Tag color="blue">selected</Tag>}
                            {row.wouldSkipReason && <Tag>{row.wouldSkipReason}</Tag>}
                          </Space>
                        ),
                      },
                    ]}
                  />
                  <Table
                    size="small"
                    rowKey="key"
                    pagination={false}
                    dataSource={overrideRows}
                    locale={{ emptyText: 'Переопределения заказа не найдены' }}
                    columns={[
                      { title: 'Тип', dataIndex: 'targetType', key: 'targetType', width: 120 },
                      {
                        title: 'Rule/Policy ID',
                        dataIndex: 'targetId',
                        key: 'targetId',
                        render: (value) => value || '—',
                      },
                      {
                        title: 'Состояние',
                        dataIndex: 'isDisabled',
                        key: 'isDisabled',
                        width: 120,
                        render: (value) => (
                          <Tag color={value ? 'red' : 'blue'}>{value ? 'Отключено' : 'Изменено'}</Tag>
                        ),
                      },
                      { title: 'Причина', dataIndex: 'reason', key: 'reason' },
                      {
                        title: 'Изменил',
                        dataIndex: 'updatedByUserId',
                        key: 'updatedByUserId',
                        width: 90,
                      },
                      { title: 'Обновлено', dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
                    ]}
                  />
                </Space>
              )}
            </Space>
          )}
    </>
  );

  return (
    <>
      {embedded ? (
        content
      ) : (
        <Collapse defaultActiveKey={[]} style={{ marginBottom: 4 }} className="compact-collapse">
          <Panel
            key="deadlines"
            header={<span style={{ fontSize: 12, fontWeight: 600, color: '#1677ff' }}>Дедлайны</span>}
          >
            {content}
          </Panel>
        </Collapse>
      )}
      <Modal
        title={overrideModal?.title}
        open={!!overrideModal}
        onOk={submitOverrideChange}
        onCancel={() => setOverrideModal(null)}
        okButtonProps={{ disabled: !overrideReason.trim(), loading: savingOverride }}
        confirmLoading={savingOverride}
        okText="Сохранить"
        cancelText="Отмена"
        destroyOnClose
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text>Причина изменения обязательна для аудита.</Text>
          <TextArea
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            rows={3}
            maxLength={1000}
            showCount
            placeholder="Причина или номер заявки"
          />
        </Space>
      </Modal>
    </>
  );
}

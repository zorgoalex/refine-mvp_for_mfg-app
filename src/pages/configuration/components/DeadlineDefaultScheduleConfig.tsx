import { useGetIdentity } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Table,
  Typography,
  message,
} from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { ApiError } from '../../../api/apiError';
import { deadlinesApi } from '../../../api/deadlinesApi';
import type { DeadlineDefaultScheduleDto } from '../../../api/types/deadlineApi.types';
import type { UserIdentity } from '../../../types/auth';
import { featureFlags } from '../../../config/featureFlags';
import {
  buildDefaultSchedulePayload,
  buildDurationDraft,
  buildParallelDraft,
  calculateScheduleDraft,
  canManageDeadlineDefaultSchedule,
  canViewDeadlineDefaultSchedule,
  isDeadlineScheduleDraftComplete,
  type DeadlineDurationDraft,
  type DeadlineParallelDraft,
} from './deadlineDefaultScheduleView';

const { Paragraph, Text, Title } = Typography;

export function DeadlineDefaultScheduleConfig() {
  const { data: identity } = useGetIdentity<UserIdentity>();
  const canView = canViewDeadlineDefaultSchedule(identity);
  const canManage = canManageDeadlineDefaultSchedule(identity);
  const [schedule, setSchedule] = useState<DeadlineDefaultScheduleDto | null>(null);
  const [durations, setDurations] = useState<DeadlineDurationDraft>({});
  const [parallel, setParallel] = useState<DeadlineParallelDraft>({});
  const [stageOrder, setStageOrder] = useState<number[]>([]);
  const [reserveDays, setReserveDays] = useState<number | null>(0);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    setError(null);
    try {
      const response = await deadlinesApi.getDefaultSchedule();
      setSchedule(response.schedule);
      setDurations(buildDurationDraft(response.schedule));
      setParallel(buildParallelDraft(response.schedule));
      setStageOrder(response.schedule.stages.map((stage) => stage.productionStatusId));
      setReserveDays(response.schedule.reserveDays);
      setReason('');
    } catch (loadError) {
      setError(errorText(loadError, 'Не удалось загрузить сроки по умолчанию'));
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    void load();
  }, [load]);

  const orderedStages = useMemo(() => {
    if (!schedule) return [];
    const byId = new Map(
      schedule.stages.map((stage) => [stage.productionStatusId, stage]),
    );
    return stageOrder
      .map((productionStatusId) => byId.get(productionStatusId))
      .filter((stage): stage is DeadlineDefaultScheduleDto['stages'][number] => Boolean(stage));
  }, [schedule, stageOrder]);
  const draftSchedule = schedule ? { ...schedule, stages: orderedStages } : null;
  const draftCalculation = useMemo(
    () =>
      draftSchedule
        ? calculateScheduleDraft(draftSchedule, durations, parallel)
        : { cumulativeHints: new Map<number, number | null>(), totalProductionDays: null },
    [draftSchedule, durations, parallel],
  );
  const cumulative = draftCalculation.cumulativeHints;
  const totalProductionDays = draftCalculation.totalProductionDays;
  const plannedOrderDays =
    totalProductionDays === null || reserveDays === null
      ? null
      : totalProductionDays + reserveDays;
  const payload = draftSchedule
    ? buildDefaultSchedulePayload(
        draftSchedule,
        reserveDays,
        durations,
        parallel,
        reason,
      )
    : null;
  const draftComplete = isDeadlineScheduleDraftComplete(
    draftCalculation,
    reserveDays,
  );

  const save = async () => {
    if (!payload) {
      message.warning('Заполните срок каждого этапа и резерв');
      return;
    }
    setSaving(true);
    try {
      const response = await deadlinesApi.replaceDefaultSchedule(payload);
      setSchedule(response.schedule);
      setDurations(buildDurationDraft(response.schedule));
      setParallel(buildParallelDraft(response.schedule));
      setStageOrder(response.schedule.stages.map((stage) => stage.productionStatusId));
      setReserveDays(response.schedule.reserveDays);
      setReason('');
      message.success('Сроки по умолчанию сохранены');
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        message.error('Настройки или список этапов уже изменились. Данные обновлены.');
        await load();
      } else {
        message.error(errorText(saveError, 'Не удалось сохранить сроки'));
      }
    } finally {
      setSaving(false);
    }
  };

  const clear = () => {
    if (!schedule || reason.trim().length < 3) {
      message.warning('Укажите причину изменения');
      return;
    }
    Modal.confirm({
      title: 'Отключить сроки по умолчанию?',
      content: 'Новые заказы не будут получать автоматическую плановую дату.',
      okText: 'Отключить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        setSaving(true);
        try {
          const response = await deadlinesApi.replaceDefaultSchedule({
            expectedVersion: schedule.version,
            reserveDays: 0,
            reason: reason.trim(),
            stages: [],
          });
          setSchedule(response.schedule);
          setDurations(buildDurationDraft(response.schedule));
          setParallel(buildParallelDraft(response.schedule));
          setStageOrder(response.schedule.stages.map((stage) => stage.productionStatusId));
          setReserveDays(response.schedule.reserveDays);
          setReason('');
          message.success('Сроки по умолчанию отключены');
        } catch (clearError) {
          message.error(errorText(clearError, 'Не удалось отключить сроки'));
          await load();
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const moveStage = (productionStatusId: number, direction: -1 | 1) => {
    const index = stageOrder.indexOf(productionStatusId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= stageOrder.length) return;
    const next = [...stageOrder];
    [next[index], next[target]] = [next[target], next[index]];
    setStageOrder(next);
    setParallel((current) => ({ ...current, [next[0]]: false }));
  };

  if (!canView) {
    return <Alert type="warning" showIcon message="Нет прав для просмотра настроек сроков" />;
  }
  if (loading && !schedule) {
    return <div style={{ minHeight: 180, display: 'grid', placeItems: 'center' }}><Spin /></div>;
  }
  if (error && !schedule) {
    return <Alert type="error" showIcon message={error} action={<Button onClick={() => void load()}>Повторить</Button>} />;
  }
  if (!schedule) {
    return <Empty description="Настройки сроков недоступны" />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ marginBottom: 4 }}>Сроки по умолчанию</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Укажите длительность каждого этапа. Итоговый день считается автоматически
          по этапам конкретного заказа. Параллельные этапы стартуют вместе,
          ручная дата всегда имеет приоритет.
        </Paragraph>
      </div>

      {!draftComplete && (
        <Alert
          type="warning"
          showIcon
          message="Настройка не завершена"
          description={
            schedule.stages.length === 0
              ? 'Нет активных этапов производства. Сохранённую настройку можно отключить ниже.'
              : 'Заполните длительность каждого этапа. Ноль дней — допустимое значение.'
          }
        />
      )}
      {!featureFlags.useBackendOrdersWrite && (
        <Alert
          type="warning"
          showIcon
          message="Автоприменение пока выключено"
          description="Сроки начнут применяться к новым заказам после включения backend-записи заказов."
        />
      )}

      <Table
        rowKey="productionStatusId"
        pagination={false}
        dataSource={orderedStages}
        locale={{ emptyText: 'Нет активных этапов производства' }}
        columns={[
          {
            title: 'Порядок',
            width: 116,
            render: (_, stage, index) => (
              <Space size={4}>
                <Button
                  aria-label={`Переместить этап ${stage.productionStatusName} выше`}
                  icon={<ArrowUpOutlined />}
                  disabled={!canManage || index === 0}
                  onClick={() => moveStage(stage.productionStatusId, -1)}
                  style={{ minWidth: 44, minHeight: 44 }}
                />
                <Button
                  aria-label={`Переместить этап ${stage.productionStatusName} ниже`}
                  icon={<ArrowDownOutlined />}
                  disabled={!canManage || index === orderedStages.length - 1}
                  onClick={() => moveStage(stage.productionStatusId, 1)}
                  style={{ minWidth: 44, minHeight: 44 }}
                />
              </Space>
            ),
          },
          {
            title: 'Этап производства',
            dataIndex: 'productionStatusName',
            render: (name: string, stage) => (
              <Space direction="vertical" size={0}>
                <Text strong>{name}</Text>
                {stage.productionStatusCode && <Text type="secondary">{stage.productionStatusCode}</Text>}
              </Space>
            ),
          },
          {
            title: 'Длительность',
            width: 190,
            render: (_, stage) => (
              <InputNumber
                aria-label={`Длительность этапа ${stage.productionStatusName}`}
                min={0}
                max={3650}
                precision={0}
                addonAfter="дн."
                value={durations[stage.productionStatusId]}
                disabled={!canManage}
                onChange={(value) =>
                  setDurations((current) => ({
                    ...current,
                    [stage.productionStatusId]: value,
                  }))
                }
                style={{ width: '100%' }}
              />
            ),
          },
          {
            title: 'Выполнение',
            width: 220,
            render: (_, stage, index) => (
              <div style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>
                <Checkbox
                  checked={index > 0 && parallel[stage.productionStatusId] === true}
                  disabled={!canManage || index === 0}
                  onChange={(event) =>
                    setParallel((current) => ({
                      ...current,
                      [stage.productionStatusId]: event.target.checked,
                    }))
                  }
                >
                  Параллельно с предыдущим
                </Checkbox>
              </div>
            ),
          },
          {
            title: 'Подсказка от даты заказа',
            width: 320,
            render: (_, stage, index) => {
              const deadlineDay = cumulative.get(stage.productionStatusId);
              const duration = durations[stage.productionStatusId];
              const previousDays =
                deadlineDay !== null &&
                deadlineDay !== undefined &&
                duration !== null &&
                duration !== undefined
                  ? deadlineDay - duration
                  : null;
              return deadlineDay === null || deadlineDay === undefined ? (
                <Text type="secondary">Заполните этот и предыдущие этапы</Text>
              ) : (
                <Text>
                  {index > 0 && parallel[stage.productionStatusId]
                    ? 'Параллельный старт: '
                    : 'Предыдущие группы: '}
                  <Text strong>{previousDays ?? 0}</Text> дн. ·
                  дедлайн: <Text strong>{deadlineDay}-й день</Text>
                </Text>
              );
            },
          },
        ]}
      />

      <Card size="small">
        <Space wrap size={24} align="end">
          <div>
            <Text type="secondary">Производственный цикл</Text>
            <div><Text strong style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{totalProductionDays ?? '—'} дн.</Text></div>
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
                value={reserveDays}
                disabled={!canManage}
                onChange={setReserveDays}
                style={{ width: 150 }}
              />
            </div>
          </div>
          <div>
            <Text type="secondary">Плановая готовность заказа</Text>
            <div><Text strong style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{plannedOrderDays ?? '—'}-й день</Text></div>
          </div>
        </Space>
      </Card>

      {canManage && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input.TextArea
            aria-label="Причина изменения сроков"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Причина изменения (обязательно)"
            maxLength={500}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          {draftComplete && reason.trim().length < 3 && (
            <Text type="secondary">
              Укажите причину изменения, чтобы сохранить настройку.
            </Text>
          )}
          <Space wrap>
            <Button type="primary" onClick={() => void save()} loading={saving} disabled={!payload}>
              Сохранить сроки
            </Button>
            <Button onClick={() => void load()} disabled={saving}>Сбросить изменения</Button>
            <Button
              danger
              onClick={clear}
              disabled={saving || !schedule.hasStoredConfiguration}
            >
              Отключить сроки
            </Button>
          </Space>
        </Space>
      )}
    </Space>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Drawer, Popconfirm, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type { OnecAgentView, OnecEtlBatch, OnecEtlEntityState, OnecEtlRun, OnecEtlRunDetail } from './onecApi.types';
import {
  onecEtlBatchStatusColor,
  onecEtlBatchStatusLabel,
  onecEtlCompletenessLabel,
  onecEtlEntityLabel,
  onecEtlEntityStatusColor,
  onecEtlEntityStatusLabel,
  onecEtlReadScopeLabel,
  onecEtlRunModeLabel,
  onecEtlRunStatusColor,
  onecEtlRunStatusLabel,
} from './onecFormat';

const { Text } = Typography;

/** Auto-refresh cadence for the ETL entities/runs journal while this tab is on screen. */
export const ONEC_ETL_POLL_MS = 15_000;

export interface EtlTabProps {
  agents: OnecAgentView[];
  canSendCommands: boolean;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

export function EtlTab({ agents, canSendCommands }: EtlTabProps) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.agentId ?? '');
  const [entities, setEntities] = useState<OnecEtlEntityState[]>([]);
  const [runs, setRuns] = useState<OnecEtlRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // Rows are actionable only for the agent they were loaded for.
  const [loadedAgentId, setLoadedAgentId] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  // One Idempotency-Key per command intent, kept until the backend confirms it:
  // a retry after a lost response returns the same command instead of a second one.
  const intentKeys = useRef(new Map<string, string>());

  useEffect(() => {
    setEntities([]);
    setRuns([]);
    setLoadedAgentId(null);
  }, [agentId]);

  // Only the latest request may update the journal: a slow answer for a
  // previously selected agent must never overwrite the current one.
  const requestSeq = useRef(0);
  // The agent currently selected; a response for any other agent is dropped.
  const selectedAgent = useRef(agentId);
  selectedAgent.current = agentId;
  const load = useCallback(async () => {
    if (!agentId) {
      setEntities([]);
      setRuns([]);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const [entitiesData, runsData] = await Promise.all([
        onecApi.listEtlEntities({ agentId }),
        onecApi.listEtlRuns({ agentId }),
      ]);
      if (seq !== requestSeq.current || selectedAgent.current !== agentId) return;
      setEntities(entitiesData);
      setRuns(runsData);
      setLoadedAgentId(agentId);
      setLoadError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить данные ETL');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, ONEC_ETL_POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const send = useCallback(
    async (intent: string, command: { commandType: 'start_full_sync' | 'reload_entity'; payload: Record<string, unknown> }) => {
      if (!agentId || sending) return;
      const intentId = `${agentId}|${intent}`;
      let key = intentKeys.current.get(intentId);
      if (!key) {
        key = crypto.randomUUID();
        intentKeys.current.set(intentId, key);
      }
      setSending(intentId);
      try {
        const result = await onecApi.sendCommand(agentId, key, command);
        intentKeys.current.delete(intentId);
        message.success(result.created ? 'Команда отправлена агенту' : 'Команда уже была отправлена');
        // The operator may have switched agents while the command was in flight.
        if (selectedAgent.current === agentId) void load();
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : 'Не удалось отправить команду');
      } finally {
        setSending(null);
      }
    },
    [agentId, sending, load],
  );

  const runFullSync = useCallback(() => send('full', { commandType: 'start_full_sync', payload: { entities: [] } }), [send]);
  const reloadEntity = useCallback(
    (entityCode: string) => send(`reload:${entityCode}`, { commandType: 'reload_entity', payload: { entity: entityCode } }),
    [send],
  );
  const actionsReady = canSendCommands && !!agentId && loadedAgentId === agentId && sending === null;

  const entityColumns = useMemo(
    () => [
      {
        title: 'Сущность',
        key: 'entity',
        render: (_: unknown, row: OnecEtlEntityState) => onecEtlEntityLabel(row.entity),
      },
      {
        title: 'Последняя выгрузка',
        key: 'lastRun',
        render: (_: unknown, row: OnecEtlEntityState) => (
          <Space size={4}>
            <Tag color={onecEtlEntityStatusColor(row.lastStatus)}>{onecEtlEntityStatusLabel(row.lastStatus)}</Tag>
            <Text type="secondary">{formatDate(row.lastRunAt)}</Text>
          </Space>
        ),
      },
      {
        title: 'Чтение',
        key: 'readScope',
        render: (_: unknown, row: OnecEtlEntityState) => onecEtlReadScopeLabel(row.lastReadScope),
      },
      {
        title: 'Проверка полноты',
        key: 'completeness',
        render: (_: unknown, row: OnecEtlEntityState) =>
          row.lastCompletenessReason ? (
            <Tooltip title={row.lastCompletenessReason}>
              <span>{onecEtlCompletenessLabel(row.lastCompleteness)}</span>
            </Tooltip>
          ) : (
            onecEtlCompletenessLabel(row.lastCompleteness)
          ),
      },
      { title: 'Строк', dataIndex: 'rowCount', key: 'rowCount' },
      { title: 'Удалено в 1С', dataIndex: 'deletedCount', key: 'deletedCount' },
      {
        title: (
          <Tooltip title="Строки, которых не оказалось в последней полной выгрузке. Ничего не удаляется в ERP — они только помечаются как пропавшие в 1С.">
            <span>Пропало в 1С</span>
          </Tooltip>
        ),
        dataIndex: 'missingCount',
        key: 'missingCount',
      },
      {
        title: 'Последняя полная выгрузка',
        key: 'lastFullAt',
        render: (_: unknown, row: OnecEtlEntityState) => formatDate(row.lastFullAt),
      },
      {
        title: 'Ошибка',
        key: 'error',
        render: (_: unknown, row: OnecEtlEntityState) =>
          row.lastErrorCode ? (
            <Tooltip title={row.lastErrorMessage ?? undefined}>
              <span>{row.lastErrorCode}</span>
            </Tooltip>
          ) : (
            '—'
          ),
      },
      {
        title: '',
        key: 'actions',
        render: (_: unknown, row: OnecEtlEntityState) =>
          actionsReady ? (
            <Popconfirm
              title={`Перезагрузить сущность «${onecEtlEntityLabel(row.entity)}»?`}
              onConfirm={(e) => {
                e?.stopPropagation();
                void reloadEntity(row.entity);
              }}
              onCancel={(e) => e?.stopPropagation()}
              okText="Перезагрузить"
              cancelText="Отмена"
            >
              <Button size="small" onClick={(e) => e.stopPropagation()}>
                Перезагрузить
              </Button>
            </Popconfirm>
          ) : null,
      },
    ],
    [actionsReady, reloadEntity],
  );

  const runColumns = useMemo(
    () => [
      { title: 'Начата', key: 'createdAt', render: (_: unknown, row: OnecEtlRun) => formatDate(row.createdAt) },
      { title: 'Режим', key: 'mode', render: (_: unknown, row: OnecEtlRun) => onecEtlRunModeLabel(row.mode) },
      {
        title: 'Статус',
        key: 'status',
        render: (_: unknown, row: OnecEtlRun) => (
          <Tag color={onecEtlRunStatusColor(row.status)}>{onecEtlRunStatusLabel(row.status)}</Tag>
        ),
      },
      { title: 'Пакетов', dataIndex: 'batchCount', key: 'batchCount' },
      { title: 'Строк', dataIndex: 'rowTotal', key: 'rowTotal' },
      {
        title: 'Ошибок сущностей',
        key: 'entitiesFailed',
        render: (_: unknown, row: OnecEtlRun) => row.entitiesFailed ?? '—',
      },
      { title: 'Завершена', key: 'completedAt', render: (_: unknown, row: OnecEtlRun) => formatDate(row.completedAt) },
    ],
    [],
  );

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ minWidth: 260 }}
          value={agentId || undefined}
          onChange={setAgentId}
          options={agents.map((agent) => ({ value: agent.agentId, label: agent.displayName }))}
          placeholder="Выберите агента"
        />
      </Space>

      {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card
          title="Сущности"
          size="small"
          extra={
            canSendCommands && agentId ? (
              <Popconfirm
                disabled={!actionsReady}
                title="Запустить полную выгрузку всех включённых сущностей?"
                onConfirm={() => void runFullSync()}
                okText="Запустить"
                cancelText="Отмена"
              >
                <Button type="primary" size="small" disabled={!actionsReady} loading={sending?.endsWith('|full')}>
                  Полная выгрузка
                </Button>
              </Popconfirm>
            ) : null
          }
        >
          <Table<OnecEtlEntityState> rowKey="entity" loading={loading} dataSource={entities} pagination={false} columns={entityColumns} />
        </Card>

        <Card title="Выгрузки" size="small">
          <Table<OnecEtlRun>
            rowKey="runId"
            loading={loading}
            dataSource={runs}
            pagination={{ pageSize: 20 }}
            columns={runColumns}
            onRow={(row) => ({ onClick: () => setOpenRunId(row.runId) })}
          />
        </Card>
      </Space>

      {openRunId && <EtlRunDetailsDrawer runId={openRunId} agents={agents} onClose={() => setOpenRunId(null)} />}
    </div>
  );
}

function EtlRunDetailsDrawer({ runId, agents, onClose }: { runId: string; agents: OnecAgentView[]; onClose: () => void }) {
  const [run, setRun] = useState<OnecEtlRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onecApi
      .getEtlRun(runId)
      .then((data) => {
        if (!cancelled) setRun(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить выгрузку');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const agentName = run ? agents.find((agent) => agent.agentId === run.agentId)?.displayName ?? run.agentId : '';

  const batchColumns = [
    { title: 'Сущность', key: 'entity', render: (_: unknown, row: OnecEtlBatch) => onecEtlEntityLabel(row.entity) },
    {
      title: 'Статус',
      key: 'status',
      render: (_: unknown, row: OnecEtlBatch) => <Tag color={onecEtlBatchStatusColor(row.status)}>{onecEtlBatchStatusLabel(row.status)}</Tag>,
    },
    { title: 'Строк', dataIndex: 'rowCount', key: 'rowCount' },
    { title: 'Разобрано', dataIndex: 'parsedRows', key: 'parsedRows', render: (v: number | null) => v ?? '—' },
    { title: 'Попытка разбора', dataIndex: 'parseAttempt', key: 'parseAttempt' },
    { title: 'Причина ошибки', dataIndex: 'invalidReason', key: 'invalidReason', render: (v: string | null) => v ?? '—' },
    { title: 'Получен', key: 'receivedAt', render: (_: unknown, row: OnecEtlBatch) => formatDate(row.receivedAt) },
    { title: 'Подтверждён', key: 'acknowledged', render: (_: unknown, row: OnecEtlBatch) => (row.acknowledged ? 'Да' : 'Нет') },
  ];

  return (
    <Drawer title="Выгрузка 1С" open onClose={onClose} width={720}>
      {loading && <Spin />}
      {error && <Alert type="error" showIcon message={error} />}
      {run && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="ID">
              <Text code copyable>
                {run.runId}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Агент">{agentName}</Descriptions.Item>
            <Descriptions.Item label="Режим">{onecEtlRunModeLabel(run.mode)}</Descriptions.Item>
            <Descriptions.Item label="Статус">
              <Tag color={onecEtlRunStatusColor(run.status)}>{onecEtlRunStatusLabel(run.status)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Пакетов">{run.batchCount}</Descriptions.Item>
            <Descriptions.Item label="Строк">{run.rowTotal}</Descriptions.Item>
            <Descriptions.Item label="Ошибок сущностей">{run.entitiesFailed ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Команда">{run.commandId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Начата">{formatDate(run.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="Первый пакет">{formatDate(run.firstBatchAt)}</Descriptions.Item>
            <Descriptions.Item label="Завершена">{formatDate(run.completedAt)}</Descriptions.Item>
          </Descriptions>

          {run.entities && run.entities.length > 0 && (
            <div>
              <Text strong>Сущности в выгрузке</Text>
              <Table
                rowKey="entity"
                size="small"
                pagination={false}
                dataSource={run.entities}
                columns={[
                  { title: 'Сущность', key: 'entity', render: (_: unknown, row) => onecEtlEntityLabel(row.entity) },
                  {
                    title: 'Статус',
                    key: 'status',
                    render: (_: unknown, row) => onecEtlEntityStatusLabelForRun(row.status),
                  },
                  { title: 'Чтение', key: 'readScope', render: (_: unknown, row) => onecEtlReadScopeLabel(row.readScope) },
                  { title: 'Проверка полноты', key: 'completeness', render: (_: unknown, row) => onecEtlCompletenessLabel(row.completeness) },
                  { title: 'Строк', key: 'rows', render: (_: unknown, row) => row.rows ?? row.rowsRead ?? '—' },
                  { title: 'Код ошибки', dataIndex: 'errorCode', key: 'errorCode', render: (v: string | null) => v ?? '—' },
                ]}
              />
            </div>
          )}

          <div>
            <Text strong>Пакеты</Text>
            <Table<OnecEtlBatch> rowKey="batchId" size="small" pagination={false} dataSource={run.batches} columns={batchColumns} />
          </div>
        </Space>
      )}
    </Drawer>
  );
}

function onecEtlEntityStatusLabelForRun(status: 'done' | 'failed'): string {
  return status === 'done' ? 'Успешно' : 'Ошибка';
}

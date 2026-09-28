import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Drawer, Modal, Popconfirm, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type { OnecAgentView, OnecEtlBatch, OnecEtlEntityState, OnecEtlRun, OnecEtlRunDetail, OnecSourceIdentity } from './onecApi.types';
import {
  onecEtlBatchStatusColor,
  onecEtlBatchStatusLabel,
  onecEtlCompletenessLabel,
  onecEtlEntityLabel,
  onecEtlEntityRevocable,
  onecEtlEntityStatusColor,
  onecEtlEntityStatusLabel,
  onecEtlIsSnapshotEntity,
  onecEtlReadScopeLabel,
  onecEtlRunModeLabel,
  onecEtlRunStatusColor,
  onecEtlRunStatusLabel,
  onecSnapshotRejectedReasonLabel,
} from './onecFormat';

const { Text } = Typography;

/** Auto-refresh cadence for the ETL entities/runs journal while this tab is on screen. */
export const ONEC_ETL_POLL_MS = 15_000;

export interface EtlTabProps {
  agents: OnecAgentView[];
  canSendCommands: boolean;
  canManage: boolean;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

export function EtlTab({ agents, canSendCommands, canManage }: EtlTabProps) {
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
  // Revoke/restore/rebaseline are gated on onec.manage (not canSendCommands): the same
  // "loaded, still-selected agent, nothing in flight" rule as the admin commands above.
  const manageReady = canManage && !!agentId && loadedAgentId === agentId && sending === null;

  const revokeEntity = useCallback(
    async (entityCode: string) => {
      if (!agentId || sending) return;
      const intentId = `revoke:${entityCode}`;
      setSending(intentId);
      try {
        await onecApi.revokeEtlEntity(agentId, entityCode);
        message.success(`Данные сущности «${onecEtlEntityLabel(entityCode)}» отозваны`);
        if (selectedAgent.current === agentId) void load();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ONEC_ENTITY_ALREADY_REVOKED') {
          message.error('Данные этой сущности уже отозваны');
        } else if (err instanceof ApiError && err.code === 'ONEC_CONFIG_PUBLISH_BLOCKED') {
          message.error('Публикация заблокирована до первого heartbeat агента после восстановления');
        } else if (err instanceof ApiError && err.code === 'ONEC_ENTITY_NOT_REVOCABLE') {
          message.error('Отзыв данных доступен только для персональных данных');
        } else {
          message.error(err instanceof ApiError ? err.message : 'Не удалось отозвать данные');
        }
        if (selectedAgent.current === agentId) void load();
      } finally {
        setSending(null);
      }
    },
    [agentId, sending, load],
  );

  const restoreEntity = useCallback(
    async (entityCode: string) => {
      if (!agentId || sending) return;
      const intentId = `restore:${entityCode}`;
      setSending(intentId);
      try {
        await onecApi.restoreEtlEntity(agentId, entityCode);
        message.success(`Сущность «${onecEtlEntityLabel(entityCode)}» снова разрешена`);
        if (selectedAgent.current === agentId) void load();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ONEC_ENTITY_NOT_PURGED') {
          message.error('Данные сущности ещё не удалены полностью или она не отозвана');
        } else {
          message.error(err instanceof ApiError ? err.message : 'Не удалось разрешить сущность снова');
        }
      } finally {
        setSending(null);
      }
    },
    [agentId, sending, load],
  );

  const selectedAgentView = useMemo(() => agents.find((agent) => agent.agentId === agentId) ?? null, [agents, agentId]);
  const identityChanged = selectedAgentView?.source.identityStatus === 'identity_changed';
  const observedIdentity = selectedAgentView?.source.observedIdentity ?? null;
  // What the operator confirms is frozen when the dialog opens: polling must not change the
  // generation or identity sent (a retry after a lost response repeats the SAME request, which the
  // backend then refuses as ONEC_GENERATION_CHANGED instead of clearing the new baseline).
  type RebaselineSnapshot = {
    sourceId: number;
    generation: number;
    identityChanged: boolean;
    identity: OnecSourceIdentity | null;
    observedIdentity: OnecSourceIdentity | null;
  };
  const [rebaseline, setRebaseline] = useState<RebaselineSnapshot | null>(null);
  const [rebaselineAcceptIdentity, setRebaselineAcceptIdentity] = useState(false);
  const rebaselining = sending === 'rebaseline';
  const liveObservedKey = JSON.stringify(observedIdentity);
  const identityMovedSinceOpen = rebaseline !== null && rebaseline.identityChanged && JSON.stringify(rebaseline.observedIdentity) !== liveObservedKey;

  useEffect(() => {
    // The agent reported yet another identity while the dialog was open: the tick is no longer valid.
    if (identityMovedSinceOpen) setRebaselineAcceptIdentity(false);
  }, [identityMovedSinceOpen]);

  const openRebaseline = () => {
    if (!selectedAgentView) return;
    setRebaselineAcceptIdentity(false);
    setRebaseline({
      sourceId: selectedAgentView.source.sourceId,
      generation: selectedAgentView.source.generation,
      identityChanged,
      identity: selectedAgentView.source.identity ?? null,
      observedIdentity,
    });
  };

  const confirmRebaseline = async () => {
    if (!rebaseline || sending || identityMovedSinceOpen) return;
    setSending('rebaseline');
    try {
      const result = await onecApi.rebaselineSource(rebaseline.sourceId, {
        expectedGeneration: rebaseline.generation,
        // Exactly the identity object shown in this dialog, never a boolean flag or a fresher value.
        ...(rebaseline.identityChanged && rebaselineAcceptIdentity && rebaseline.observedIdentity ? { acceptIdentity: rebaseline.observedIdentity } : {}),
      });
      setRebaseline(null);
      message.success(
        `Новое поколение источника: ${result.generation}; отменено выгрузок: ${result.abandonedRuns}.` +
          (result.publishPending ? ' Конфигурацию нужно будет опубликовать заново после ближайшего heartbeat агента.' : ''),
      );
      if (selectedAgent.current === agentId) void load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ONEC_GENERATION_CHANGED') {
        // Either our earlier attempt already succeeded or someone else rebaselined: never resend with the new generation.
        setRebaseline(null);
        message.error('Поколение уже изменилось (возможно, команда уже выполнена). Проверьте состояние и при необходимости откройте диалог заново');
        if (selectedAgent.current === agentId) void load();
      } else if (err instanceof ApiError && err.code === 'ONEC_IDENTITY_CONFIRMATION_REQUIRED') {
        setRebaseline(null);
        message.error('Идентичность базы 1С изменилась: откройте диалог заново и подтвердите показанную');
        if (selectedAgent.current === agentId) void load();
      } else {
        // Unknown outcome (e.g. lost response): the dialog stays with the same frozen request.
        message.error(err instanceof ApiError ? err.message : 'Не удалось выполнить новое поколение источника');
      }
    } finally {
      setSending(null);
    }
  };

  function formatIdentity(identity: { databaseId: string; exportEpoch: string; environment: string } | null): string {
    if (!identity) return '—';
    return `база: ${identity.databaseId}, эпоха: ${identity.exportEpoch}, среда: ${identity.environment}`;
  }

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
        title: 'Снимок',
        key: 'snapshot',
        render: (_: unknown, row: OnecEtlEntityState) => {
          if (!onecEtlIsSnapshotEntity(row.entity)) return '—';
          const reasonLabel = onecSnapshotRejectedReasonLabel(row.snapshotRejectedReason);
          return (
            <Space size={4}>
              <Text>{formatDate(row.snapshotVersion)}</Text>
              {reasonLabel && (
                <Tooltip title={`Снимок отклонён: ${reasonLabel}`}>
                  <Tag color="orange">{reasonLabel}</Tag>
                </Tooltip>
              )}
            </Space>
          );
        },
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
        title: 'Отзыв',
        key: 'revoked',
        render: (_: unknown, row: OnecEtlEntityState) =>
          row.revokedAt ? <Tag color={row.purgedAt ? 'red' : 'orange'}>{row.purgedAt ? 'Данные отозваны (удалены)' : 'Данные отозваны'}</Tag> : null,
      },
      {
        title: '',
        key: 'actions',
        render: (_: unknown, row: OnecEtlEntityState) => (
          <Space size={4} onClick={(e) => e.stopPropagation()}>
            {actionsReady && (
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
                <Button size="small">Перезагрузить</Button>
              </Popconfirm>
            )}
            {manageReady && onecEtlEntityRevocable(row.entity) && !row.revokedAt && (
              <Popconfirm
                title={`Отозвать данные сущности «${onecEtlEntityLabel(row.entity)}»? Все данные этой сущности будут удалены из ERP, она будет исключена из конфигурации, и агент перестанет их выгружать.`}
                onConfirm={(e) => {
                  e?.stopPropagation();
                  void revokeEntity(row.entity);
                }}
                onCancel={(e) => e?.stopPropagation()}
                okText="Отозвать"
                okButtonProps={{ danger: true }}
                cancelText="Отмена"
              >
                <Button size="small" danger>
                  Отозвать данные
                </Button>
              </Popconfirm>
            )}
            {manageReady && row.revokedAt && row.purgedAt && (
              <Popconfirm
                title={`Разрешить сущность «${onecEtlEntityLabel(row.entity)}» снова?`}
                onConfirm={(e) => {
                  e?.stopPropagation();
                  void restoreEntity(row.entity);
                }}
                onCancel={(e) => e?.stopPropagation()}
                okText="Разрешить"
                cancelText="Отмена"
              >
                <Button size="small">Разрешить снова</Button>
              </Popconfirm>
            )}
          </Space>
        ),
      },
    ],
    [actionsReady, manageReady, reloadEntity, revokeEntity, restoreEntity],
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
            <Space>
              {canSendCommands && agentId && (
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
              )}
              {canManage && agentId && (
                <Button size="small" disabled={!manageReady} onClick={openRebaseline}>
                  Новое поколение (rebaseline)
                </Button>
              )}
            </Space>
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

      {rebaseline && (
        <Modal
          title="Новое поколение источника (rebaseline)?"
          open
          onCancel={() => setRebaseline(null)}
          onOk={() => void confirmRebaseline()}
          confirmLoading={rebaselining}
          okButtonProps={{
            danger: true,
            disabled: identityMovedSinceOpen || (rebaseline.identityChanged && (!rebaselineAcceptIdentity || !rebaseline.observedIdentity)),
          }}
          okText="Выполнить"
          cancelText="Отмена"
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Text>
              Копия данных 1С этого источника будет очищена, незавершённые выгрузки — отменены. После этого потребуется
              полная выгрузка. Текущее поколение: {rebaseline.generation}.
            </Text>
            {identityMovedSinceOpen && (
              <Alert type="error" showIcon message="Агент сообщил другую идентичность базы. Закройте диалог и откройте заново." />
            )}
            {rebaseline.identityChanged && (
              <>
                <Alert type="warning" showIcon message="База 1С сменилась — требуется подтверждение оператора" />
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="Было">{formatIdentity(rebaseline.identity)}</Descriptions.Item>
                  <Descriptions.Item label="Стало (по данным агента)">{formatIdentity(rebaseline.observedIdentity)}</Descriptions.Item>
                </Descriptions>
                <Checkbox
                  checked={rebaselineAcceptIdentity}
                  disabled={!rebaseline.observedIdentity || identityMovedSinceOpen}
                  onChange={(e) => setRebaselineAcceptIdentity(e.target.checked)}
                >
                  Подтверждаю: это та же база 1С (восстановлена или перенесена)
                </Checkbox>
              </>
            )}
          </Space>
        </Modal>
      )}
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

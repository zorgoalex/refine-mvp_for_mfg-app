import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { Table } from '../../ui/tooltipDelay';
import { Segmented } from '../../ui/Segmented';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type {
  OnecAgentConfigState,
  OnecAgentConfiguration,
  OnecAgentView,
  OnecConfigIssue,
  OnecConfigVersion,
  OnecEtlEntity,
} from './onecApi.types';
import { ONEC_AGENT_MODES, ONEC_COMMAND_TYPES } from './onecApi.types';
import {
  onecCommandTypeLabel,
  onecDiffConfigurations,
  onecModeLabel,
  onecStableStringify,
  onecConfigWritable,
  onecIsCurrentResponse,
} from './onecFormat';
import { ConfigEntityModal } from './ConfigEntityModal';

const { Text } = Typography;
const VALIDATE_DEBOUNCE_MS = 500;

export interface ConfigurationTabProps {
  agents: OnecAgentView[];
  canManage: boolean;
}

function emptyConfiguration(defaults: OnecAgentConfiguration | null): OnecAgentConfiguration {
  return (
    defaults ?? {
      mode: 'Normal',
      commandTypes: [],
      etlIntervalMinutes: 60,
      etlEntities: [],
    }
  );
}

export function ConfigurationTab({ agents, canManage }: ConfigurationTabProps) {
  const [agentId, setAgentId] = useState<string | null>(agents[0]?.agentId ?? null);
  const [configState, setConfigState] = useState<OnecAgentConfigState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleDraft, setStaleDraft] = useState(false);
  const [formConfig, setFormConfig] = useState<OnecAgentConfiguration | null>(null);
  const [validationIssues, setValidationIssues] = useState<OnecConfigIssue[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [entityModal, setEntityModal] = useState<{ open: boolean; entity: OnecEtlEntity | null }>({
    open: false,
    entity: null,
  });
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  /** Exactly what the operator confirmed: agent + draft revision + hash. */
  const [publishTarget, setPublishTarget] = useState<{ agentId: string; revision: number; configHash: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [viewMode, setViewMode] = useState<'form' | 'json'>('form');
  const [versions, setVersions] = useState<OnecConfigVersion[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every piece of form state belongs to `configState.agentId`; responses for
  // another agent or an older request are dropped (see onecIsCurrentResponse).
  const selectedAgentRef = useRef<string | null>(agentId);
  const loadSeq = useRef(0);
  selectedAgentRef.current = agentId;

  const load = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    setStaleDraft(false);
    try {
      const data = await onecApi.getConfig(id);
      if (!onecIsCurrentResponse({ requestSeq: seq, latestSeq: loadSeq.current, requestAgentId: id, selectedAgentId: selectedAgentRef.current })) return;
      setConfigState(data);
      setFormConfig(data.draft?.configuration ?? data.published?.configuration ?? emptyConfiguration(data.defaults));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить конфигурацию');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Switching agents discards the previous agent's form before anything else can use it.
    setConfigState(null);
    setFormConfig(null);
    setValidationIssues(null);
    setPublishTarget(null);
    setVersions(null);
    if (agentId) void load(agentId);
  }, [agentId, load]);

  const writable = onecConfigWritable({
    selectedAgentId: agentId,
    loadedAgentId: configState?.agentId ?? null,
    loading,
  });

  // Live validation is tied to the form generation and agent: a late answer for an
  // older form (or another agent) must not block saving the current one.
  const validateSeq = useRef(0);
  useEffect(() => {
    const seq = ++validateSeq.current;
    if (!formConfig) return undefined;
    const forAgent = selectedAgentRef.current;
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => {
      const isCurrent = () =>
        onecIsCurrentResponse({ requestSeq: seq, latestSeq: validateSeq.current, requestAgentId: forAgent ?? '', selectedAgentId: selectedAgentRef.current });
      onecApi
        .validateConfig(formConfig)
        .then((result) => {
          if (isCurrent()) setValidationIssues(result.ok ? [] : result.issues);
        })
        .catch(() => {
          if (isCurrent()) setValidationIssues(null);
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      if (validateTimer.current) clearTimeout(validateTimer.current);
    };
  }, [formConfig]);

  const dirty = useMemo(() => {
    if (!configState || !formConfig) return false;
    const baseline = configState.draft?.configuration ?? configState.published?.configuration ?? null;
    return onecStableStringify(baseline) !== onecStableStringify(formConfig);
  }, [configState, formConfig]);

  const diff = useMemo(
    () => onecDiffConfigurations(formConfig, configState?.published?.configuration ?? null),
    [formConfig, configState],
  );

  const saveDraft = async () => {
    if (!writable || !configState || !formConfig) return;
    const target = configState.agentId;
    setSaving(true);
    try {
      const saved = await onecApi.saveDraft(target, configState.draft?.revision ?? null, formConfig);
      if (selectedAgentRef.current !== target) return;
      message.success('Черновик сохранён');
      setConfigState((prev) =>
        prev && prev.agentId === target
          ? {
              ...prev,
              draft: { revision: saved.revision, configHash: saved.configHash, configuration: saved.configuration, updatedAt: new Date().toISOString() },
            }
          : prev,
      );
      setStaleDraft(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STALE_DRAFT') {
        setStaleDraft(true);
      } else if (err instanceof ApiError && err.code === 'ONEC_CONFIG_INVALID') {
        const issues = (err.details as { issues?: OnecConfigIssue[] } | undefined)?.issues ?? [];
        setValidationIssues(issues);
        message.error('Конфигурация не прошла проверку');
      } else {
        message.error(err instanceof ApiError ? err.message : 'Не удалось сохранить черновик');
      }
    } finally {
      setSaving(false);
    }
  };

  const openPublishConfirm = () => {
    if (!writable || !configState?.draft) return;
    setPublishTarget({ agentId: configState.agentId, revision: configState.draft.revision, configHash: configState.draft.configHash });
    setPublishConfirmOpen(true);
  };

  const confirmPublish = async () => {
    const target = publishTarget;
    if (!target || target.agentId !== selectedAgentRef.current) {
      setPublishConfirmOpen(false);
      return;
    }
    setPublishing(true);
    try {
      await onecApi.publish(target.agentId, target.revision, target.configHash);
      message.success('Конфигурация опубликована');
      setPublishConfirmOpen(false);
      setPublishTarget(null);
      if (selectedAgentRef.current === target.agentId) void load(target.agentId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'STALE_DRAFT') {
        message.error('Черновик изменился после подтверждения; проверьте его ещё раз');
        if (selectedAgentRef.current === target.agentId) void load(target.agentId);
      } else if (err instanceof ApiError && err.code === 'ONEC_CONFIG_UNCHANGED') {
        message.error('Черновик совпадает с опубликованной конфигурацией');
      } else if (err instanceof ApiError && err.code === 'ONEC_CONFIG_PUBLISH_BLOCKED') {
        message.error('Публикация заблокирована до первого heartbeat агента после восстановления');
      } else {
        message.error(err instanceof ApiError ? err.message : 'Не удалось опубликовать конфигурацию');
      }
    } finally {
      setPublishing(false);
    }
  };

  const openVersions = async () => {
    if (!agentId) return;
    setVersionsOpen(true);
    try {
      setVersions(await onecApi.listConfigVersions(agentId));
    } catch {
      message.error('Не удалось загрузить историю версий');
    }
  };

  const updateEntities = (next: OnecEtlEntity[]) => {
    setFormConfig((prev) => (prev ? { ...prev, etlEntities: next } : prev));
  };

  const submitEntity = (entity: OnecEtlEntity) => {
    if (!formConfig) return;
    const editingCode = entityModal.entity?.entityCode;
    const next = editingCode
      ? formConfig.etlEntities.map((item) => (item.entityCode === editingCode ? entity : item))
      : [...formConfig.etlEntities, entity];
    updateEntities(next);
    setEntityModal({ open: false, entity: null });
  };

  const removeEntity = (entityCode: string) => {
    if (!formConfig) return;
    updateEntities(formConfig.etlEntities.filter((item) => item.entityCode !== entityCode));
  };

  const entityColumns = [
    { title: 'Код', dataIndex: 'entityCode', key: 'entityCode' },
    { title: 'OData-путь', dataIndex: 'oDataPath', key: 'oDataPath' },
    { title: 'Режим', dataIndex: 'syncMode', key: 'syncMode' },
    { title: 'Размер страницы', dataIndex: 'pageSize', key: 'pageSize' },
    {
      title: 'Включена',
      key: 'enabled',
      render: (_: unknown, entity: OnecEtlEntity) =>
        (entity.enabled ?? true) ? <Tag color="green">Да</Tag> : <Tag>Нет</Tag>,
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, entity: OnecEtlEntity) =>
        canManage ? (
          <Space>
            <Button size="small" onClick={() => setEntityModal({ open: true, entity })}>
              Изменить
            </Button>
            <Popconfirm title="Удалить сущность?" onConfirm={() => removeEntity(entity.entityCode)} okText="Удалить" cancelText="Отмена">
              <Button size="small" danger>
                Удалить
              </Button>
            </Popconfirm>
          </Space>
        ) : null,
    },
  ];

  if (agents.length === 0) {
    return <Empty description="Нет зарегистрированных агентов" />;
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ minWidth: 260 }}
          value={agentId ?? undefined}
          onChange={setAgentId}
          options={agents.map((agent) => ({ value: agent.agentId, label: agent.displayName }))}
          placeholder="Выберите агента"
        />
        <Segmented
          value={viewMode}
          onChange={(value) => setViewMode(value as 'form' | 'json')}
          options={[
            { label: 'Форма', value: 'form' },
            { label: 'JSON', value: 'json' },
          ]}
        />
        <Button onClick={() => void openVersions()}>История версий</Button>
      </Space>

      {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}
      {loading && !configState && <Spin />}

      {configState && formConfig && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {configState.publishBlocked && (
            <Alert
              type="warning"
              showIcon
              message="Публикация заблокирована до первого heartbeat агента после восстановления"
            />
          )}
          {staleDraft && (
            <Alert
              type="error"
              showIcon
              message="Черновик изменён другим пользователем, обновите"
              action={
                <Button size="small" onClick={() => agentId && void load(agentId)}>
                  Обновить
                </Button>
              }
            />
          )}
          {configState.agentReported.rejectedConfigVersion !== null && (
            <Alert
              type="error"
              showIcon
              message={`Агент отклонил конфигурацию v${configState.agentReported.rejectedConfigVersion}`}
              description={configState.agentReported.rejectedReason ?? undefined}
            />
          )}

          <Descriptions column={3} size="small" bordered>
            <Descriptions.Item label="Опубликована">
              {configState.published?.configVersion ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Активна у агента">
              {configState.agentReported.activeConfigVersion ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Черновик">
              {configState.draft ? `ревизия ${configState.draft.revision}` : 'нет'}
            </Descriptions.Item>
          </Descriptions>

          {viewMode === 'json' ? (
            <pre style={{ background: '#f5f5f5', padding: 12, maxHeight: 400, overflow: 'auto' }}>
              {JSON.stringify(formConfig, null, 2)}
            </pre>
          ) : (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Form layout="vertical">
                <Form.Item label="Режим">
                  <Select
                    disabled={!canManage}
                    value={formConfig.mode}
                    style={{ maxWidth: 320 }}
                    options={ONEC_AGENT_MODES.map((mode) => ({ value: mode, label: onecModeLabel(mode) }))}
                    onChange={(mode) => setFormConfig((prev) => (prev ? { ...prev, mode } : prev))}
                  />
                </Form.Item>
                <Form.Item label="Интервал выгрузки (мин)">
                  <InputNumber
                    disabled={!canManage}
                    min={1}
                    max={10080}
                    value={formConfig.etlIntervalMinutes}
                    onChange={(value) =>
                      setFormConfig((prev) => (prev ? { ...prev, etlIntervalMinutes: Number(value ?? 1) } : prev))
                    }
                  />
                </Form.Item>
                <Form.Item label="Разрешённые типы команд">
                  <Checkbox.Group
                    disabled={!canManage}
                    value={formConfig.commandTypes}
                    options={ONEC_COMMAND_TYPES.map((type) => ({ value: type, label: onecCommandTypeLabel(type) }))}
                    onChange={(commandTypes) =>
                      setFormConfig((prev) => (prev ? { ...prev, commandTypes: commandTypes as string[] } : prev))
                    }
                  />
                </Form.Item>
              </Form>

              <div>
                <Space style={{ marginBottom: 8 }}>
                  <Text strong>Сущности выгрузки</Text>
                  {canManage && (
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => setEntityModal({ open: true, entity: null })}
                    >
                      Добавить сущность
                    </Button>
                  )}
                </Space>
                <Table<OnecEtlEntity>
                  rowKey="entityCode"
                  size="small"
                  dataSource={formConfig.etlEntities}
                  columns={entityColumns}
                  pagination={false}
                />
              </div>
            </Space>
          )}

          {validationIssues && validationIssues.length > 0 && (
            <Alert
              type="error"
              showIcon
              message="Конфигурация не прошла проверку"
              description={
                <ul>
                  {validationIssues.map((issue) => (
                    <li key={`${issue.path}-${issue.message}`}>
                      {issue.path ? `${issue.path}: ` : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {diff.length > 0 && (
            <Alert
              type="info"
              showIcon
              message="Изменения относительно опубликованной конфигурации"
              description={
                <ul>
                  {diff.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              }
            />
          )}

          {canManage && (
            <Space>
              <Button
                type="default"
                onClick={() => void saveDraft()}
                loading={saving}
                disabled={!writable || !dirty || Boolean(validationIssues && validationIssues.length > 0)}
              >
                Сохранить черновик
              </Button>
              <Button
                type="primary"
                onClick={openPublishConfirm}
                disabled={!writable || !configState.draft || configState.publishBlocked || dirty}
              >
                Опубликовать
              </Button>
            </Space>
          )}
        </Space>
      )}

      {entityModal.open && formConfig && (
        <ConfigEntityModal
          initial={entityModal.entity}
          existingEntities={formConfig.etlEntities}
          onCancel={() => setEntityModal({ open: false, entity: null })}
          onSubmit={submitEntity}
        />
      )}

      {publishConfirmOpen && publishTarget && configState?.draft && (
        <Modal
          title="Опубликовать конфигурацию?"
          open
          onCancel={() => setPublishConfirmOpen(false)}
          onOk={() => void confirmPublish()}
          confirmLoading={publishing}
          okText="Опубликовать"
          cancelText="Отмена"
        >
          <p>
            Режим: <strong>{onecModeLabel(configState.draft.configuration.mode)}</strong>
          </p>
          <p>
            Агент: <strong>{agents.find((agent) => agent.agentId === publishTarget.agentId)?.displayName ?? publishTarget.agentId}</strong>,
            ревизия черновика {publishTarget.revision}
          </p>
          <p>Хэш конфигурации: {publishTarget.configHash}</p>
          {diff.length > 0 ? (
            <ul>
              {diff.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p>Изменений относительно опубликованной версии нет полей для сравнения.</p>
          )}
        </Modal>
      )}

      <Modal
        title="История версий конфигурации"
        open={versionsOpen}
        onCancel={() => setVersionsOpen(false)}
        footer={null}
        width={800}
      >
        {versions === null ? (
          <Spin />
        ) : versions.length === 0 ? (
          <Empty description="Публикаций ещё не было" />
        ) : (
          <Table<OnecConfigVersion>
            rowKey="configVersion"
            size="small"
            dataSource={versions}
            pagination={false}
            columns={[
              { title: 'Версия', dataIndex: 'configVersion', key: 'configVersion' },
              {
                title: 'Статус',
                dataIndex: 'status',
                key: 'status',
                render: (status: string) => (status === 'published' ? <Tag color="green">Опубликована</Tag> : <Tag>Заменена</Tag>),
              },
              { title: 'Опубликована', dataIndex: 'publishedAt', key: 'publishedAt', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
              { title: 'Кем', dataIndex: 'publishedBy', key: 'publishedBy', render: (v: string | null) => v ?? '—' },
              {
                title: '',
                key: 'json',
                render: (_: unknown, version: OnecConfigVersion) => (
                  <Button
                    size="small"
                    onClick={() =>
                      Modal.info({
                        title: `Конфигурация v${version.configVersion}`,
                        width: 640,
                        content: (
                          <pre style={{ maxHeight: 400, overflow: 'auto' }}>
                            {JSON.stringify(version.configuration, null, 2)}
                          </pre>
                        ),
                      })
                    }
                  >
                    JSON
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </div>
  );
}

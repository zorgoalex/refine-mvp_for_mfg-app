import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Form,
  Input,
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
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type {
  OnecAgentView,
  OnecCommandDetail,
  OnecCommandView,
  OnecEtlEntity,
} from './onecApi.types';
import { ONEC_COMMAND_STATUSES, ONEC_OPERATOR_COMMAND_TYPES } from './onecApi.types';
import {
  onecCommandCancellable,
  onecCommandPayloadFromForm,
  onecCommandSourceLabel,
  onecCommandStatusColor,
  onecCommandStatusLabel,
  onecCommandTypeDescription,
  onecCommandTypeLabel,
  onecDefaultProbeMarker,
} from './onecFormat';

const { Text } = Typography;

/** Auto-refresh cadence for the command journal while this tab is on screen. */
export const ONEC_COMMANDS_POLL_MS = 15_000;

export interface CommandsTabProps {
  agents: OnecAgentView[];
  canSend: boolean;
  onNavigateToConfig?: () => void;
}

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'Все статусы' },
  ...ONEC_COMMAND_STATUSES.map((status) => ({ value: status, label: onecCommandStatusLabel(status) })),
];

const TYPE_FILTER_OPTIONS = [
  { value: '', label: 'Все типы' },
  ...ONEC_OPERATOR_COMMAND_TYPES.map((type) => ({ value: type, label: onecCommandTypeLabel(type) })),
];

function agentOptions(agents: OnecAgentView[]) {
  return [{ value: '', label: 'Все агенты' }, ...agents.map((agent) => ({ value: agent.agentId, label: agent.displayName }))];
}

function agentDisplayName(agents: OnecAgentView[], agentId: string): string {
  return agents.find((agent) => agent.agentId === agentId)?.displayName ?? agentId;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function CommandsTab({ agents, canSend, onNavigateToConfig }: CommandsTabProps) {
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [commands, setCommands] = useState<OnecCommandView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);

  // Only the latest request may update the journal: a slow answer for old filters is dropped.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const data = await onecApi.listCommands({
        agentId: agentFilter || undefined,
        status: statusFilter || undefined,
        commandType: typeFilter || undefined,
      });
      if (seq !== requestSeq.current) return;
      setCommands(data);
      setLoadError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить журнал команд');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [agentFilter, statusFilter, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, ONEC_COMMANDS_POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // A cancel that finishes after the filters changed must refresh the current filters, not its own.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const cancelCommand = useCallback(async (commandId: string) => {
    try {
      await onecApi.cancelCommand(commandId);
      message.success('Команда отменена');
      void loadRef.current();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ONEC_COMMAND_NOT_CANCELLABLE') {
        message.error('Команду уже получил агент или она завершена');
      } else {
        message.error(err instanceof ApiError ? err.message : 'Не удалось отменить команду');
      }
      void loadRef.current();
    }
  }, []);

  const columns = useMemo(
    () => [
      {
        title: 'Создана',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (v: string) => new Date(v).toLocaleString('ru-RU'),
      },
      {
        title: 'Агент',
        dataIndex: 'agentId',
        key: 'agentId',
        render: (v: string) => agentDisplayName(agents, v),
      },
      {
        title: 'Тип',
        key: 'commandType',
        render: (_: unknown, row: OnecCommandView) => onecCommandTypeLabel(row.commandType),
      },
      {
        title: 'Статус',
        key: 'status',
        render: (_: unknown, row: OnecCommandView) => (
          <Tag color={onecCommandStatusColor(row.status)}>{onecCommandStatusLabel(row.status)}</Tag>
        ),
      },
      { title: 'Приоритет', dataIndex: 'priority', key: 'priority' },
      {
        title: 'Источник',
        key: 'source',
        render: (_: unknown, row: OnecCommandView) => onecCommandSourceLabel(row),
      },
      { title: 'Попыток', dataIndex: 'leaseCount', key: 'leaseCount' },
      {
        title: 'Код ошибки',
        dataIndex: 'resultErrorCode',
        key: 'resultErrorCode',
        render: (v: string | null) => v ?? '—',
      },
      {
        title: '',
        key: 'actions',
        render: (_: unknown, row: OnecCommandView) =>
          canSend && onecCommandCancellable(row.status) ? (
            <Popconfirm
              title="Отменить команду?"
              onConfirm={(e) => {
                e?.stopPropagation();
                void cancelCommand(row.commandId);
              }}
              onCancel={(e) => e?.stopPropagation()}
              okText="Отменить"
              cancelText="Не отменять"
            >
              <Button size="small" danger onClick={(e) => e.stopPropagation()}>
                Отменить
              </Button>
            </Popconfirm>
          ) : null,
      },
    ],
    [agents, canSend, cancelCommand],
  );

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Служебные команды агент принимает по своему локальному списку (его включает оператор агента); бизнес-команды, включая «Проверку интеграции», — только типы из опубликованной конфигурации ERP."
        description={
          onNavigateToConfig ? (
            <Button type="link" size="small" style={{ padding: 0 }} onClick={onNavigateToConfig}>
              Бизнес-типы — на вкладке «Конфигурация»
            </Button>
          ) : undefined
        }
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Select style={{ minWidth: 200 }} value={agentFilter} onChange={setAgentFilter} options={agentOptions(agents)} />
        <Select style={{ minWidth: 180 }} value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} />
        <Select style={{ minWidth: 220 }} value={typeFilter} onChange={setTypeFilter} options={TYPE_FILTER_OPTIONS} />
        {canSend && (
          <Button type="primary" onClick={() => setSendOpen(true)}>
            Отправить команду
          </Button>
        )}
      </Space>

      {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}

      <Table<OnecCommandView>
        rowKey="commandId"
        loading={loading}
        dataSource={commands}
        pagination={{ pageSize: 20 }}
        columns={columns}
        onRow={(row) => ({ onClick: () => setDetailsId(row.commandId) })}
      />

      {detailsId && <CommandDetailsDrawer commandId={detailsId} agents={agents} canSend={canSend} onClose={() => setDetailsId(null)} onChanged={() => void load()} />}

      {sendOpen && (
        <SendCommandModal
          agents={agents}
          defaultAgentId={agentFilter || agents[0]?.agentId || ''}
          onClose={() => setSendOpen(false)}
          onSent={() => {
            setSendOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CommandDetailsDrawer({
  commandId,
  agents,
  canSend,
  onClose,
  onChanged,
}: {
  commandId: string;
  agents: OnecAgentView[];
  canSend: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<OnecCommandDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onecApi
      .getCommand(commandId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить команду');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commandId]);

  const cancel = async () => {
    if (!detail) return;
    try {
      await onecApi.cancelCommand(detail.commandId);
      message.success('Команда отменена');
      onChanged();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ONEC_COMMAND_NOT_CANCELLABLE') {
        message.error('Команду уже получил агент или она завершена');
      } else {
        message.error(err instanceof ApiError ? err.message : 'Не удалось отменить команду');
      }
    }
  };

  return (
    <Drawer title="Команда 1С" open onClose={onClose} width={560}>
      {loading && <Spin />}
      {error && <Alert type="error" showIcon message={error} />}
      {detail && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="ID">
              <Text code copyable>
                {detail.commandId}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Агент">{agentDisplayName(agents, detail.agentId)}</Descriptions.Item>
            <Descriptions.Item label="Тип">{onecCommandTypeLabel(detail.commandType)}</Descriptions.Item>
            <Descriptions.Item label="Вид">{detail.commandKind === 'admin' ? 'Административная' : 'Бизнес'}</Descriptions.Item>
            <Descriptions.Item label="Статус">
              <Tag color={onecCommandStatusColor(detail.status)}>{onecCommandStatusLabel(detail.status)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Приоритет">{detail.priority}</Descriptions.Item>
            <Descriptions.Item label="Источник">{onecCommandSourceLabel(detail)}</Descriptions.Item>
            <Descriptions.Item label="Ключ упорядочивания">{detail.orderingKey ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Модуль-источник">{detail.sourceModule}</Descriptions.Item>
            <Descriptions.Item label="Сущность-источник">
              {detail.sourceEntityType ? `${detail.sourceEntityType} #${detail.sourceEntityId ?? '—'}` : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Хэш payload">
              <Text code>{detail.payloadHash}</Text> ({detail.payloadBytes} байт)
            </Descriptions.Item>
            <Descriptions.Item label="Создана">{new Date(detail.createdAt).toLocaleString('ru-RU')}</Descriptions.Item>
            <Descriptions.Item label="Не раньше">
              {detail.notBeforeUtc ? new Date(detail.notBeforeUtc).toLocaleString('ru-RU') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Истекает">
              {detail.expiresAtUtc ? new Date(detail.expiresAtUtc).toLocaleString('ru-RU') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Попыток выдачи">{detail.leaseCount}</Descriptions.Item>
            <Descriptions.Item label="Выдана агенту">
              {detail.leasedAt ? new Date(detail.leasedAt).toLocaleString('ru-RU') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Получена агентом">
              {detail.receivedAt ? new Date(detail.receivedAt).toLocaleString('ru-RU') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Результат получен">
              {detail.resultReceivedAt ? new Date(detail.resultReceivedAt).toLocaleString('ru-RU') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Код ошибки">{detail.resultErrorCode ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Отменена">
              {detail.cancelledAt ? new Date(detail.cancelledAt).toLocaleString('ru-RU') : '—'}
            </Descriptions.Item>
          </Descriptions>

          {'payload' in detail && (
            <div>
              <Text strong>Payload</Text>
              <pre style={{ background: '#f5f5f5', padding: 12, maxHeight: 300, overflow: 'auto' }}>{prettyJson(detail.payload)}</pre>
            </div>
          )}
          {'result' in detail && (
            <div>
              <Text strong>Результат</Text>
              <pre style={{ background: '#f5f5f5', padding: 12, maxHeight: 300, overflow: 'auto' }}>{prettyJson(detail.result)}</pre>
            </div>
          )}

          {canSend && onecCommandCancellable(detail.status) && (
            <Popconfirm title="Отменить команду?" onConfirm={() => void cancel()} okText="Отменить" cancelText="Не отменять">
              <Button danger>Отменить</Button>
            </Popconfirm>
          )}
        </Space>
      )}
    </Drawer>
  );
}

interface SendCommandFormValues {
  agentId: string;
  commandType: string;
  entities: string[];
  allEntities: boolean;
  entity?: string;
  marker: string;
  priority: number;
}

function SendCommandModal({
  agents,
  defaultAgentId,
  onClose,
  onSent,
}: {
  agents: OnecAgentView[];
  defaultAgentId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [form] = Form.useForm<SendCommandFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [entities, setEntities] = useState<OnecEtlEntity[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [commandType, setCommandType] = useState<string>(ONEC_OPERATOR_COMMAND_TYPES[0]);
  const [allEntities, setAllEntities] = useState(true);

  // A retry/double-click of the same values reuses the key, so the backend
  // returns the same command instead of creating a second one.
  // Any change of the form is a new intent and gets a new key (the backend compares the whole request).
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  useEffect(() => {
    if (!agentId) {
      setEntities([]);
      return;
    }
    let cancelled = false;
    // Entities belong to the selected agent: never carry another agent's codes over.
    setEntities([]);
    form.setFieldsValue({ entities: [], entity: undefined });
    setEntitiesLoading(true);
    onecApi
      .getConfig(agentId)
      .then((state) => {
        if (cancelled) return;
        const configuration = state.published?.configuration ?? state.draft?.configuration ?? null;
        setEntities((configuration?.etlEntities ?? []).filter((entity) => entity.enabled ?? true));
      })
      .catch(() => {
        if (!cancelled) setEntities([]);
      })
      .finally(() => {
        if (!cancelled) setEntitiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, form]);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (entitiesLoading || values.agentId !== agentId) return;
      const known = new Set(entities.map((entity) => entity.entityCode));
      const chosen = [...(values.allEntities ? [] : values.entities ?? []), ...(values.entity ? [values.entity] : [])];
      if (chosen.some((code) => !known.has(code))) {
        message.error('Выбранные сущности не относятся к этому агенту; выберите заново');
        return;
      }
      setSubmitting(true);
      const payload = onecCommandPayloadFromForm(values.commandType, {
        entities: values.allEntities ? [] : values.entities,
        entity: values.entity,
        marker: values.marker,
      });
      const result = await onecApi.sendCommand(values.agentId, idempotencyKey, {
        commandType: values.commandType,
        payload,
        priority: values.priority,
      });
      message.success(result.created ? 'Команда отправлена' : 'Команда уже была отправлена ранее');
      onSent();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'ONEC_COMMAND_IDEMPOTENCY_CONFLICT') {
          message.error('Ключ уже использован для другой команды; повторите отправку');
          setIdempotencyKey(crypto.randomUUID());
        } else if (error.code === 'VALIDATION_FAILED' || error.code === 'INVALID_PAYLOAD') {
          const issues = (error.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues ?? [];
          message.error(issues.length ? issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join('; ') : error.message);
        } else {
          message.error(error.message || 'Не удалось отправить команду');
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const description = onecCommandTypeDescription(commandType);
  const needsEntities = commandType === 'start_full_sync';
  const needsEntity = commandType === 'reload_entity';
  const needsMarker = commandType === 'integration_probe';

  return (
    <Modal
      title="Отправить команду агенту 1С"
      open
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={submitting}
      okButtonProps={{ disabled: entitiesLoading }}
      okText="Отправить"
      cancelText="Отмена"
      width={560}
    >
      <Form<SendCommandFormValues>
        form={form}
        layout="vertical"
        initialValues={{
          agentId: defaultAgentId,
          commandType: ONEC_OPERATOR_COMMAND_TYPES[0],
          entities: [],
          allEntities: true,
          marker: onecDefaultProbeMarker(),
          priority: 0,
        }}
        onValuesChange={(changed) => {
          setIdempotencyKey(crypto.randomUUID());
          if (changed.agentId !== undefined) setAgentId(changed.agentId);
          if (changed.commandType !== undefined) setCommandType(changed.commandType);
          if (changed.allEntities !== undefined) setAllEntities(changed.allEntities);
        }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Административные команды выполняет сам агент. «Проверка интеграции» проверяет весь путь ERP → агент → расширение 1С без создания документов."
        />
        <Form.Item name="agentId" label="Агент" rules={[{ required: true, message: 'Выберите агента' }]}>
          <Select options={agents.map((agent) => ({ value: agent.agentId, label: agent.displayName }))} placeholder="Выберите агента" />
        </Form.Item>
        <Form.Item name="commandType" label="Тип команды" rules={[{ required: true, message: 'Выберите тип команды' }]}>
          <Select
            options={ONEC_OPERATOR_COMMAND_TYPES.map((type) => ({ value: type, label: onecCommandTypeLabel(type) }))}
          />
        </Form.Item>
        {description && <Alert type="info" message={description} style={{ marginBottom: 16 }} />}

        {needsEntities && (
          <>
            <Form.Item name="allEntities" valuePropName="checked">
              <Checkbox>Все включённые сущности</Checkbox>
            </Form.Item>
            {!allEntities && (
              <Form.Item
                name="entities"
                label="Сущности выгрузки"
                rules={[{ required: true, message: 'Выберите хотя бы одну сущность', type: 'array', min: 1 }]}
              >
                <Select
                  mode="multiple"
                  loading={entitiesLoading}
                  options={entities.map((entity) => ({ value: entity.entityCode, label: entity.entityCode }))}
                  placeholder="Выберите сущности"
                />
              </Form.Item>
            )}
          </>
        )}

        {needsEntity && (
          <Form.Item name="entity" label="Сущность" rules={[{ required: true, message: 'Выберите сущность' }]}>
            <Select
              loading={entitiesLoading}
              options={entities.map((entity) => ({ value: entity.entityCode, label: entity.entityCode }))}
              placeholder="Выберите сущность"
            />
          </Form.Item>
        )}

        {needsMarker && (
          <Form.Item
            name="marker"
            label="Маркер проверки"
            rules={[{ required: true, max: 256, message: 'От 1 до 256 символов' }]}
          >
            <Input />
          </Form.Item>
        )}

        <Button type="link" style={{ paddingLeft: 0 }} onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? 'Скрыть дополнительные параметры' : 'Дополнительные параметры'}
        </Button>
        {advancedOpen && (
          <Form.Item name="priority" label="Приоритет" tooltip="От -1000 (низкий) до 1000 (высокий), по умолчанию 0">
            <InputNumber min={-1000} max={1000} style={{ width: '100%' }} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

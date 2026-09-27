import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
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
  OnecAgentDetail,
  OnecCertificate,
  OnecAgentHistoryItem,
  OnecStatusHistorySummary,
} from './onecApi.types';
import {
  onecCertExpiryColor,
  onecCertExpirySeverity,
  onecConnectionBadge,
  onecIdentityWarning,
  onecRelativeTime,
  onecStateBadge,
  onecFormatHistorySummary,
} from './onecFormat';

const { Text } = Typography;

export interface AgentDetailsDrawerProps {
  agentId: string;
  canManage: boolean;
  onClose: () => void;
  /** Called after any mutation so the caller can refresh the overview list. */
  onChanged: () => void;
}

export function AgentDetailsDrawer({ agentId, canManage, onClose, onChanged }: AgentDetailsDrawerProps) {
  const [agent, setAgent] = useState<OnecAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await onecApi.getAgent(agentId);
      setAgent(data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить агента');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = useCallback(() => {
    onChanged();
    void load();
  }, [onChanged, load]);

  const toggleBlocked = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      if (agent.status === 'blocked') {
        await onecApi.unblockAgent(agent.agentId, agent.version);
        message.success('Агент разблокирован');
      } else {
        await onecApi.blockAgent(agent.agentId, agent.version);
        message.success('Агент заблокирован');
      }
      afterMutation();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось изменить статус агента');
    } finally {
      setBusy(false);
    }
  };

  const revokeCertificate = async (certId: number) => {
    if (!agent) return;
    setBusy(true);
    try {
      await onecApi.revokeCertificate(agent.agentId, certId);
      message.success('Сертификат отозван');
      afterMutation();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось отозвать сертификат');
    } finally {
      setBusy(false);
    }
  };

  const identityWarning = agent ? onecIdentityWarning(agent.source.identityStatus) : null;
  const connectionBadge = agent ? onecConnectionBadge(agent.connection) : null;
  const stateBadge = agent ? onecStateBadge(agent.state) : null;

  const certColumns = [
    {
      title: 'Отпечаток SHA-256',
      dataIndex: 'sha256Fingerprint',
      key: 'sha256Fingerprint',
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: 'Субъект', dataIndex: 'subject', key: 'subject', render: (v: string | null) => v ?? '—' },
    {
      title: 'Действует до',
      key: 'notAfter',
      render: (_: unknown, cert: OnecCertificate) => {
        const severity = onecCertExpirySeverity(cert.notAfter);
        const color = onecCertExpiryColor(severity);
        return cert.notAfter ? (
          <Tag color={color}>{new Date(cert.notAfter).toLocaleDateString('ru-RU')}</Tag>
        ) : (
          '—'
        );
      },
    },
    {
      title: 'Статус',
      key: 'status',
      render: (_: unknown, cert: OnecCertificate) =>
        cert.status === 'active' ? <Tag color="green">Активен</Tag> : <Tag>Отозван</Tag>,
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, cert: OnecCertificate) =>
        canManage && cert.status === 'active' ? (
          <Popconfirm
            title="Отозвать сертификат? Агент перестанет проходить проверку по этому сертификату."
            onConfirm={() => void revokeCertificate(cert.certId)}
            okText="Отозвать"
            cancelText="Отмена"
          >
            <Button danger size="small">
              Отозвать
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const historyColumns = [
    { title: 'Время', dataIndex: 'at', key: 'at', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
    { title: 'Состояние', dataIndex: 'state', key: 'state' },
    { title: 'Причина', dataIndex: 'stateReason', key: 'stateReason', render: (v: string | null) => v ?? '—' },
    { title: 'Описание', dataIndex: 'summary', key: 'summary', render: (summary: OnecStatusHistorySummary | null) => onecFormatHistorySummary(summary) },
  ];

  return (
    <Drawer title={agent?.displayName ?? 'Агент 1С'} open width={720} onClose={onClose}>
      {loading && !agent && <Spin />}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

      {agent && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {identityWarning && <Alert type="warning" showIcon message={identityWarning} />}
          {agent.config.rejectedVersion !== null && (
            <Alert
              type="error"
              showIcon
              message={`Агент отклонил конфигурацию v${agent.config.rejectedVersion}`}
              description={agent.config.rejectedReason ?? undefined}
            />
          )}

          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="Площадка">{agent.siteId}</Descriptions.Item>
            <Descriptions.Item label="Источник (1С)">{agent.source.displayName}</Descriptions.Item>
            <Descriptions.Item label="Статус">
              {agent.status === 'blocked' ? <Tag color="red">Заблокирован</Tag> : <Tag color="green">Активен</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="Версия записи">{agent.version}</Descriptions.Item>
            <Descriptions.Item label="Версия агента (ПО)">{agent.agentVersion ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Минимальная версия">{agent.minimumAgentVersion}</Descriptions.Item>
            <Descriptions.Item label="Подключение">
              {connectionBadge && <Tag>{connectionBadge.text}</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="Состояние">
              {stateBadge && <Tag>{stateBadge.text}</Tag>}
              {agent.stateReason && <div>{agent.stateReason}</div>}
            </Descriptions.Item>
            <Descriptions.Item label="Последний heartbeat">{onecRelativeTime(agent.lastHeartbeatAt)}</Descriptions.Item>
            <Descriptions.Item label="Доступность 1С">
              {agent.oneC ? (
                <span>
                  OData: {agent.oneC.odataAvailable ? 'да' : 'нет'}, Команды:{' '}
                  {agent.oneC.commandApiAvailable ? 'да' : 'нет'}
                  {agent.oneC.lastError ? ` — ${agent.oneC.lastError}` : ''}
                </span>
              ) : (
                '—'
              )}
            </Descriptions.Item>
            {agent.heartbeat?.uptimeSeconds !== undefined && (
              <Descriptions.Item label="Аптайм агента">
                {Math.floor(agent.heartbeat.uptimeSeconds / 3600)} ч
              </Descriptions.Item>
            )}
            {agent.heartbeat?.machine?.diskFreeBytes !== undefined && (
              <Descriptions.Item label="Свободно на диске">
                {(agent.heartbeat.machine.diskFreeBytes / 1024 / 1024 / 1024).toFixed(1)} ГБ
              </Descriptions.Item>
            )}
          </Descriptions>

          {canManage && (
            <Space>
              <Button onClick={() => setEditOpen(true)}>Редактировать</Button>
              <Popconfirm
                title={agent.status === 'blocked' ? 'Разблокировать агента?' : 'Заблокировать агента?'}
                onConfirm={() => void toggleBlocked()}
                okText={agent.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
                cancelText="Отмена"
              >
                <Button danger={agent.status !== 'blocked'} loading={busy}>
                  {agent.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
                </Button>
              </Popconfirm>
            </Space>
          )}

          <div>
            <Space style={{ marginBottom: 8 }}>
              <Text strong>Сертификаты</Text>
              {canManage && (
                <Button size="small" onClick={() => setCertModalOpen(true)}>
                  Добавить сертификат
                </Button>
              )}
            </Space>
            <Table<OnecCertificate>
              rowKey="certId"
              size="small"
              dataSource={agent.certificates}
              columns={certColumns}
              pagination={false}
            />
          </div>

          <div>
            <Text strong>История состояний</Text>
            <Table<OnecAgentHistoryItem>
              rowKey={(item) => `${item.at}-${item.state}`}
              size="small"
              dataSource={agent.history}
              columns={historyColumns}
              pagination={{ pageSize: 10 }}
            />
          </div>
        </Space>
      )}

      {agent && editOpen && (
        <AgentEditModal
          agent={agent}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            afterMutation();
          }}
        />
      )}

      {agent && certModalOpen && (
        <CertificateAddModal
          agentId={agent.agentId}
          onClose={() => setCertModalOpen(false)}
          onAdded={() => {
            setCertModalOpen(false);
            afterMutation();
          }}
        />
      )}
    </Drawer>
  );
}

function AgentEditModal({
  agent,
  onClose,
  onSaved,
}: {
  agent: OnecAgentDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm<{ siteId: string; displayName: string; minimumAgentVersion: string }>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onecApi.updateAgent(agent.agentId, { version: agent.version, ...values });
      message.success('Агент обновлён');
      onSaved();
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(
          error.code === 'ONEC_AGENT_STALE'
            ? 'Агент изменён другим пользователем; обновите данные'
            : error.message || 'Не удалось сохранить агента',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Редактировать агента"
      open
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Сохранить"
      cancelText="Отмена"
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          siteId: agent.siteId,
          displayName: agent.displayName,
          minimumAgentVersion: agent.minimumAgentVersion,
        }}
      >
        <Form.Item name="siteId" label="Площадка" rules={[{ required: true, message: 'Укажите площадку' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="displayName" label="Название" rules={[{ required: true, message: 'Укажите название' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="minimumAgentVersion" label="Минимальная версия агента">
          <Input placeholder="1.0" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

type CertificateInputMode = 'pem' | 'fingerprint';

function CertificateAddModal({
  agentId,
  onClose,
  onAdded,
}: {
  agentId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<CertificateInputMode>('pem');
  const [form] = Form.useForm<{ pem: string; sha256Fingerprint: string }>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onecApi.addCertificate(
        agentId,
        mode === 'pem' ? { pem: values.pem } : { sha256Fingerprint: values.sha256Fingerprint },
      );
      message.success('Сертификат добавлен');
      onAdded();
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.message || 'Не удалось добавить сертификат');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Добавить сертификат"
      open
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Добавить"
      cancelText="Отмена"
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Вставляйте только публичный сертификат"
        description="Никогда не вставляйте сюда закрытый ключ (private key) — это только клиентский сертификат для проверки подлинности агента."
      />
      <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)} style={{ marginBottom: 16 }}>
        <Radio.Button value="pem">PEM</Radio.Button>
        <Radio.Button value="fingerprint">SHA-256 отпечаток</Radio.Button>
      </Radio.Group>
      <Form form={form} layout="vertical">
        {mode === 'pem' ? (
          <Form.Item name="pem" label="Сертификат (PEM)" rules={[{ required: true, message: 'Вставьте сертификат' }]}>
            <Input.TextArea rows={8} placeholder="-----BEGIN CERTIFICATE-----" />
          </Form.Item>
        ) : (
          <Form.Item
            name="sha256Fingerprint"
            label="SHA-256 отпечаток"
            rules={[{ required: true, message: 'Укажите отпечаток' }]}
          >
            <Input placeholder="AB:CD:EF:..." />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

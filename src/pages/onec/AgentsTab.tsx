import React, { useMemo, useState } from 'react';
import { Badge, Button, Form, Input, Modal, Select, Space, Tag, Tooltip, message } from 'antd';
import { PlusOutlined, UserAddOutlined } from '@ant-design/icons';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type { OnecAgentView, OnecOverview, OnecSourceListItem } from './onecApi.types';
import {
  onecCertExpiryColor,
  onecCertExpirySeverity,
  onecConnectionBadge,
  onecRelativeTime,
  onecStateBadge,
} from './onecFormat';
import { AgentDetailsDrawer } from './AgentDetailsDrawer';

export interface AgentsTabProps {
  overview: OnecOverview | null;
  canManage: boolean;
  onChanged: () => void;
}

function queuesSummary(agent: OnecAgentView): string {
  const q = agent.queues;
  if (!q) return '—';
  return `команды ${q.commandsPending ?? 0} / результаты ${q.resultsPending ?? 0} / выгрузка ${q.etlBatchesPending ?? 0} / отказы ${q.deadLetters ?? 0}`;
}

function configSummary(agent: OnecAgentView): React.ReactNode {
  const { config } = agent;
  return (
    <Space direction="vertical" size={0}>
      <span>Опубликована: {config.publishedVersion ?? '—'}</span>
      <span>Активна у агента: {config.activeVersion ?? '—'}</span>
      {config.rejectedVersion !== null && (
        <Tooltip title={config.rejectedReason ?? undefined}>
          <Tag color="red">Отклонена v{config.rejectedVersion}</Tag>
        </Tooltip>
      )}
      {config.publishBlocked && <Tag color="orange">Публикация заблокирована</Tag>}
    </Space>
  );
}

export function AgentsTab({ overview, canManage, onChanged }: AgentsTabProps) {
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [detailsAgentId, setDetailsAgentId] = useState<string | null>(null);

  const agents = overview?.agents ?? [];

  const columns = useMemo(
    () => [
      {
        title: 'Агент',
        key: 'agent',
        render: (_: unknown, agent: OnecAgentView) => (
          <Space direction="vertical" size={0}>
            <a onClick={() => setDetailsAgentId(agent.agentId)}>{agent.displayName}</a>
            <span style={{ color: '#999' }}>{agent.siteId}</span>
            {agent.status === 'blocked' && <Tag color="red">Заблокирован</Tag>}
          </Space>
        ),
      },
      {
        title: 'Источник (1С)',
        key: 'source',
        render: (_: unknown, agent: OnecAgentView) => (
          <Space direction="vertical" size={0}>
            <span>{agent.source.displayName}</span>
            {agent.source.identityStatus === 'identity_changed' && (
              <Tag color="red">База сменилась</Tag>
            )}
          </Space>
        ),
      },
      {
        title: 'Подключение',
        key: 'connection',
        render: (_: unknown, agent: OnecAgentView) => {
          const badge = onecConnectionBadge(agent.connection);
          return <Badge status={badge.status} text={badge.text} />;
        },
      },
      {
        title: 'Состояние',
        key: 'state',
        render: (_: unknown, agent: OnecAgentView) => {
          const badge = onecStateBadge(agent.state);
          return (
            <Tooltip title={agent.stateReason ?? undefined}>
              <Badge status={badge.status} text={badge.text} />
            </Tooltip>
          );
        },
      },
      {
        title: 'Версия агента',
        key: 'agentVersion',
        render: (_: unknown, agent: OnecAgentView) => agent.agentVersion ?? '—',
      },
      {
        title: 'Последний heartbeat',
        key: 'lastHeartbeatAt',
        render: (_: unknown, agent: OnecAgentView) => onecRelativeTime(agent.lastHeartbeatAt),
      },
      {
        title: 'Очереди',
        key: 'queues',
        render: (_: unknown, agent: OnecAgentView) => queuesSummary(agent),
      },
      {
        title: 'Сертификат',
        key: 'certificate',
        render: (_: unknown, agent: OnecAgentView) => {
          const notAfter = agent.certificate.nearestRegisteredNotAfter;
          const severity = onecCertExpirySeverity(notAfter);
          const color = onecCertExpiryColor(severity);
          return (
            <span>
              {notAfter ? (
                <Tag color={color}>{new Date(notAfter).toLocaleDateString('ru-RU')}</Tag>
              ) : (
                '—'
              )}{' '}
              ({agent.certificate.activeCount})
            </span>
          );
        },
      },
      {
        title: 'Конфигурация',
        key: 'config',
        render: (_: unknown, agent: OnecAgentView) => configSummary(agent),
      },
      {
        title: 'Алерты',
        key: 'openAlerts',
        render: (_: unknown, agent: OnecAgentView) =>
          agent.openAlerts > 0 ? <Badge count={agent.openAlerts} /> : '—',
      },
    ],
    [],
  );

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        {canManage && (
          <Button icon={<PlusOutlined />} onClick={() => setSourceModalOpen(true)}>
            Добавить источник
          </Button>
        )}
        {canManage && (
          <Button icon={<UserAddOutlined />} onClick={() => setAgentModalOpen(true)}>
            Зарегистрировать агента
          </Button>
        )}
      </Space>

      <Table<OnecAgentView>
        rowKey="agentId"
        dataSource={agents}
        columns={columns}
        pagination={false}
        onRow={(agent) => ({ onClick: () => setDetailsAgentId(agent.agentId) })}
      />

      {sourceModalOpen && (
        <SourceCreateModal
          onClose={() => setSourceModalOpen(false)}
          onCreated={() => {
            setSourceModalOpen(false);
            onChanged();
          }}
        />
      )}

      {agentModalOpen && (
        <AgentCreateModal
          onClose={() => setAgentModalOpen(false)}
          onCreated={() => {
            setAgentModalOpen(false);
            onChanged();
          }}
        />
      )}

      {detailsAgentId && (
        <AgentDetailsDrawer
          agentId={detailsAgentId}
          canManage={canManage}
          onClose={() => setDetailsAgentId(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

function SourceCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form] = Form.useForm<{ code: string; displayName: string }>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onecApi.createSource(values);
      message.success('Источник добавлен');
      onCreated();
    } catch (error) {
      // antd's validateFields() rejection (FieldsError) is not an ApiError and
      // already renders inline field errors — nothing extra to show here.
      if (error instanceof ApiError) {
        message.error(error.message || 'Не удалось добавить источник');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Добавить источник 1С"
      open
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Добавить"
      cancelText="Отмена"
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="code"
          label="Код источника"
          rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9_-]{0,63}$/, message: 'латиница в нижнем регистре, цифры, _ и -' }]}
        >
          <Input placeholder="main-db" />
        </Form.Item>
        <Form.Item name="displayName" label="Название" rules={[{ required: true, message: 'Укажите название' }]}>
          <Input placeholder="Основная база" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AgentCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form] = Form.useForm<{
    agentId: string;
    sourceId: number;
    siteId: string;
    displayName: string;
    minimumAgentVersion?: string;
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [sources, setSources] = useState<OnecSourceListItem[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);

  React.useEffect(() => {
    let cancelled = false;
    onecApi
      .listSources()
      .then((data) => {
        if (!cancelled) setSources(data);
      })
      .catch(() => {
        if (!cancelled) message.error('Не удалось загрузить список источников');
      })
      .finally(() => {
        if (!cancelled) setLoadingSources(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await onecApi.createAgent(values);
      message.success('Агент зарегистрирован');
      onCreated();
    } catch (error) {
      if (error instanceof ApiError) {
        message.error(error.message || 'Не удалось зарегистрировать агента');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Зарегистрировать агента 1С"
      open
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="Зарегистрировать"
      cancelText="Отмена"
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="agentId"
          label="Идентификатор агента"
          rules={[{ required: true, pattern: /^[A-Za-z0-9._-]{1,64}$/, message: 'латиница, цифры, точка, _ и -' }]}
        >
          <Input placeholder="site-01-agent" />
        </Form.Item>
        <Form.Item name="sourceId" label="Источник" rules={[{ required: true, message: 'Выберите источник' }]}>
          <Select
            loading={loadingSources}
            options={sources.map((source) => ({ value: source.sourceId, label: source.displayName }))}
            placeholder="Выберите источник"
          />
        </Form.Item>
        <Form.Item name="siteId" label="Площадка" rules={[{ required: true, message: 'Укажите площадку' }]}>
          <Input placeholder="Цех 1" />
        </Form.Item>
        <Form.Item name="displayName" label="Название" rules={[{ required: true, message: 'Укажите название' }]}>
          <Input placeholder="Агент цеха 1" />
        </Form.Item>
        <Form.Item name="minimumAgentVersion" label="Минимальная версия агента">
          <Input placeholder="1.0" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

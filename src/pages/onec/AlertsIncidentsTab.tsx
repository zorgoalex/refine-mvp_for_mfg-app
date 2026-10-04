import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Popconfirm, Select, Space, Tag, Typography, message } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type { OnecAgentView, OnecAlert, OnecAlertState, OnecIncident } from './onecApi.types';
import {
  ONEC_ALERT_SEVERITY_LABELS,
  ONEC_ALERT_STATE_LABELS,
  onecAlertKindLabel,
  onecAlertResolvable,
  onecIncidentKindLabel,
} from './onecFormat';

const { Text } = Typography;

export interface AlertsIncidentsTabProps {
  agents: OnecAgentView[];
  canManage: boolean;
  canView: boolean;
}

const ALERT_STATE_OPTIONS: Array<{ value: OnecAlertState | 'all'; label: string }> = [
  { value: 'open', label: 'Открытые' },
  { value: 'acknowledged', label: 'Подтверждённые' },
  { value: 'resolved', label: 'Решённые' },
  { value: 'all', label: 'Все' },
];

const SEVERITY_COLORS: Record<string, string> = { info: 'blue', warning: 'orange', critical: 'red' };

function agentOptions(agents: OnecAgentView[]) {
  return [
    { value: '', label: 'Все агенты' },
    ...agents.map((agent) => ({ value: agent.agentId, label: agent.displayName })),
  ];
}

function detailsText(details: unknown): string {
  if (details === null || details === undefined) return '—';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

export function AlertsIncidentsTab({ agents, canManage, canView }: AlertsIncidentsTabProps) {
  const [alertState, setAlertState] = useState<OnecAlertState | 'all'>('open');
  const [alertAgentId, setAlertAgentId] = useState('');
  const [alerts, setAlerts] = useState<OnecAlert[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(true);

  const [incidentOpen, setIncidentOpen] = useState<'open' | 'all'>('open');
  const [incidentAgentId, setIncidentAgentId] = useState('');
  const [incidents, setIncidents] = useState<OnecIncident[]>([]);
  const [loadingIncidents, setLoadingIncidents] = useState(true);

  const loadAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    try {
      const data = await onecApi.listAlerts({
        state: alertState === 'all' ? undefined : alertState,
        agentId: alertAgentId || undefined,
      });
      setAlerts(data);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось загрузить алерты');
    } finally {
      setLoadingAlerts(false);
    }
  }, [alertState, alertAgentId]);

  const loadIncidents = useCallback(async () => {
    setLoadingIncidents(true);
    try {
      const data = await onecApi.listIncidents({
        open: incidentOpen === 'open' ? true : undefined,
        agentId: incidentAgentId || undefined,
      });
      setIncidents(data);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось загрузить инциденты');
    } finally {
      setLoadingIncidents(false);
    }
  }, [incidentOpen, incidentAgentId]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  useEffect(() => {
    void loadIncidents();
  }, [loadIncidents]);

  const acknowledgeAlert = async (alertId: number) => {
    try {
      await onecApi.acknowledgeAlert(alertId);
      message.success('Алерт подтверждён');
      void loadAlerts();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось подтвердить алерт');
    }
  };

  const resolveAlert = async (alertId: number) => {
    try {
      await onecApi.resolveAlert(alertId);
      message.success('Алерт закрыт');
      void loadAlerts();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось закрыть алерт');
    }
  };

  const resolveIncident = async (incidentId: number) => {
    try {
      await onecApi.resolveIncident(incidentId);
      message.success('Инцидент решён');
      void loadIncidents();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось решить инцидент');
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="Алерты" size="small">
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ minWidth: 160 }}
            value={alertState}
            onChange={setAlertState}
            options={ALERT_STATE_OPTIONS}
          />
          <Select
            style={{ minWidth: 200 }}
            value={alertAgentId}
            onChange={setAlertAgentId}
            options={agentOptions(agents)}
          />
        </Space>
        <Table<OnecAlert>
          rowKey="alertId"
          loading={loadingAlerts}
          dataSource={alerts}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Тип', key: 'kind', render: (_: unknown, alert: OnecAlert) => onecAlertKindLabel(alert.kind) },
            { title: 'Агент', dataIndex: 'agentName', key: 'agentName', render: (v: string | null, alert: OnecAlert) => v ?? alert.agentId },
            {
              title: 'Важность',
              key: 'severity',
              render: (_: unknown, alert: OnecAlert) => (
                <Tag color={SEVERITY_COLORS[alert.severity]}>{ONEC_ALERT_SEVERITY_LABELS[alert.severity] ?? alert.severity}</Tag>
              ),
            },
            {
              title: 'Статус',
              key: 'state',
              render: (_: unknown, alert: OnecAlert) => ONEC_ALERT_STATE_LABELS[alert.state] ?? alert.state,
            },
            { title: 'Открыт', dataIndex: 'openedAt', key: 'openedAt', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
            { title: 'Последний раз замечен', dataIndex: 'lastSeenAt', key: 'lastSeenAt', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
            { title: 'Подробности', key: 'details', render: (_: unknown, alert: OnecAlert) => <Text ellipsis>{detailsText(alert.details)}</Text> },
            {
              title: '',
              key: 'actions',
              render: (_: unknown, alert: OnecAlert) => (
                <Space size={4}>
                  {canView && alert.state === 'open' ? (
                    <Button size="small" onClick={() => void acknowledgeAlert(alert.alertId)}>
                      Подтвердить
                    </Button>
                  ) : null}
                  {canManage && onecAlertResolvable(alert.kind, alert.state) ? (
                    <Button size="small" onClick={() => void resolveAlert(alert.alertId)}>
                      Закрыть
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Инциденты" size="small">
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ minWidth: 160 }}
            value={incidentOpen}
            onChange={setIncidentOpen}
            options={[
              { value: 'open', label: 'Открытые' },
              { value: 'all', label: 'Все' },
            ]}
          />
          <Select
            style={{ minWidth: 200 }}
            value={incidentAgentId}
            onChange={setIncidentAgentId}
            options={agentOptions(agents)}
          />
        </Space>
        <Table<OnecIncident>
          rowKey="incidentId"
          loading={loadingIncidents}
          dataSource={incidents}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Тип', key: 'kind', render: (_: unknown, incident: OnecIncident) => onecIncidentKindLabel(incident.kind) },
            { title: 'Агент', dataIndex: 'agentId', key: 'agentId', render: (v: string | null) => v ?? '—' },
            { title: 'Повторений', dataIndex: 'occurrences', key: 'occurrences' },
            { title: 'Впервые', dataIndex: 'firstAt', key: 'firstAt', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
            { title: 'Последний раз', dataIndex: 'lastAt', key: 'lastAt', render: (v: string) => new Date(v).toLocaleString('ru-RU') },
            {
              title: 'Статус',
              key: 'resolved',
              render: (_: unknown, incident: OnecIncident) =>
                incident.resolvedAt ? <Tag color="green">Решён</Tag> : <Tag color="orange">Открыт</Tag>,
            },
            { title: 'Подробности', key: 'details', render: (_: unknown, incident: OnecIncident) => <Text ellipsis>{detailsText(incident.details)}</Text> },
            {
              title: '',
              key: 'actions',
              render: (_: unknown, incident: OnecIncident) =>
                canManage && !incident.resolvedAt ? (
                  <Popconfirm title="Отметить инцидент решённым?" onConfirm={() => void resolveIncident(incident.incidentId)} okText="Решить" cancelText="Отмена">
                    <Button size="small">Решить</Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
        />
      </Card>
    </Space>
  );
}

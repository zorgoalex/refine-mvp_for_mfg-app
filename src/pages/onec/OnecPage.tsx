import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Spin, Tabs, Typography } from 'antd';
import { ApiError, isApiError } from '../../api/apiError';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { onecApi } from './onecApi';
import type { OnecOverview } from './onecApi.types';
import { AgentsTab } from './AgentsTab';
import { ConfigurationTab } from './ConfigurationTab';
import { CommandsTab } from './CommandsTab';
import { EtlTab } from './EtlTab';
import { MirrorTab } from './MirrorTab';
import { AlertsIncidentsTab } from './AlertsIncidentsTab';

const { Title } = Typography;

/** Overview auto-refresh cadence (spec: "Auto-refresh overview every 30 s"). */
export const ONEC_OVERVIEW_POLL_MS = 30_000;

/**
 * Top-level "Интеграция 1С" section: agents, configuration, alerts/incidents.
 *
 * Visibility is enforced here too (not only in the sider/route registration)
 * so direct navigation to /onec without the flag/permission shows a friendly
 * gate instead of an empty or broken page.
 */
export function OnecPage() {
  const canView = can('onec.view') || can('onec.manage') || can('onec.commands.send');
  const canManage = can('onec.manage');
  const canSendCommands = can('onec.commands.send');
  const sectionVisible = featureFlags.useBackendOnec && canView;

  const [overview, setOverview] = useState<OnecOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backendDisabled, setBackendDisabled] = useState(false);
  const [activeTab, setActiveTab] = useState('agents');

  const load = useCallback(async () => {
    try {
      const data = await onecApi.overview();
      setOverview(data);
      setBackendDisabled(false);
      setError(null);
    } catch (err) {
      if (isApiError(err, 'ONEC_AGENT_DISABLED')) {
        setBackendDisabled(true);
        setError(null);
      } else if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        setError('Недостаточно прав для просмотра интеграции с 1С');
      } else {
        setError('Не удалось загрузить обзор интеграции с 1С');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!sectionVisible) return undefined;
    void load();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, ONEC_OVERVIEW_POLL_MS);
    return () => clearInterval(interval);
  }, [sectionVisible, load]);

  if (!sectionVisible) {
    return <Alert type="warning" showIcon message="Нет доступа к интеграции с 1С" />;
  }

  if (backendDisabled) {
    return (
      <Alert
        type="info"
        showIcon
        message="Интеграция с 1С отключена"
        description="Обратитесь к администратору, чтобы включить интеграцию на бэкенде."
      />
    );
  }

  if (loading && !overview) return <Spin />;

  const openAlerts = overview?.openAlerts ?? 0;
  const agents = overview?.agents ?? [];

  const items = [
    {
      key: 'agents',
      label: 'Агенты',
      children: <AgentsTab overview={overview} canManage={canManage} onChanged={() => void load()} />,
    },
    {
      key: 'config',
      label: 'Конфигурация',
      children: <ConfigurationTab agents={agents} canManage={canManage} />,
    },
    {
      key: 'commands',
      label: 'Команды',
      children: (
        <CommandsTab agents={agents} canSend={canSendCommands} onNavigateToConfig={() => setActiveTab('config')} />
      ),
    },
    {
      key: 'etl',
      label: 'ETL',
      children: <EtlTab agents={agents} canSendCommands={canSendCommands} canManage={canManage} />,
    },
    {
      key: 'mirror',
      label: 'Данные 1С',
      children: <MirrorTab agents={agents} />,
    },
    {
      key: 'alerts',
      label: openAlerts > 0 ? `Алерты и инциденты (${openAlerts})` : 'Алерты и инциденты',
      children: <AlertsIncidentsTab agents={agents} canManage={canManage} canView={canView} />,
    },
  ];

  return (
    <div className="onec-page">
      <Title level={3}>Интеграция 1С</Title>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />}
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={items} />
    </div>
  );
}

import React from 'react';
import { Alert, Button, Space, Tabs, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { DuplicatesTab } from './DuplicatesTab';
import { integrationTabs } from './integrationsModel';

const { Title, Paragraph } = Typography;

function LinkTab({ to, text, button }: { to: string; text: string; button: string }) {
  return (
    <Space direction="vertical" size="middle">
      <Paragraph style={{ marginBottom: 0 }}>{text}</Paragraph>
      <Link to={to}><Button type="primary">{button}</Button></Link>
    </Space>
  );
}

/** «Интеграции»: the duplicates journal plus entry points to the 1C and Bitrix24 screens. */
export function IntegrationsPage() {
  const canView = can('integrations.duplicates.view');
  const canResolve = can('integrations.duplicates.resolve');
  const tabs = integrationTabs({
    canDuplicates: canView,
    canOnec: featureFlags.useBackendOnec && (can('onec.view') || can('onec.manage') || can('onec.commands.send')),
    canBitrix: can('bitrix24.requests.view'),
  });

  if (!canView) {
    return <Alert type="warning" showIcon message="Нет доступа к разделу «Интеграции»" />;
  }

  const items = tabs.map((tab) => {
    if (tab.key === 'duplicates') {
      return { key: tab.key, label: tab.label, children: <DuplicatesTab canResolve={canResolve} /> };
    }
    if (tab.key === 'onec') {
      return {
        key: tab.key,
        label: tab.label,
        children: <LinkTab to="/onec" text="Агенты, конфигурация, обмен данными и оповещения интеграции с 1С." button="Открыть «Интеграция 1С»" />,
      };
    }
    return {
      key: tab.key,
      label: tab.label,
      children: <LinkTab to="/bitrix24/incoming-requests" text="Входящие заявки из Bitrix24." button="Открыть входящие заявки Bitrix24" />,
    };
  });

  return (
    <div className="integrations-page">
      <Title level={3}>Интеграции</Title>
      <Tabs items={items} destroyInactiveTabPane />
    </div>
  );
}

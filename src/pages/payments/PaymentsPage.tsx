import type { IResourceComponentsProps } from '@refinedev/core';
import { Tabs } from 'antd';
import React, { lazy, Suspense, useState } from 'react';

import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';
import { PaymentList } from './list';

const OnecReceiptsTab = lazy(async () => ({ default: (await import('./OnecReceiptsTab')).OnecReceiptsTab }));

/** Вкладка «Поступления 1С» видна при включённой интеграции 1С и обоих правах; backend проверяет те же права. */
export function canSeeOnecReceiptsTab(): boolean {
  return featureFlags.useBackendOnec && can('payments.onec.view') && can('payments.view');
}

/**
 * Экран «Платежи»: список платежей (как раньше) и, при праве, вкладка «Поступления 1С». Без права вкладок нет
 * вовсе — экран выглядит как прежде.
 */
export const PaymentsPage: React.FC<IResourceComponentsProps> = (props) => {
  const [tab, setTab] = useState<'payments' | 'onec'>('payments');
  if (!canSeeOnecReceiptsTab()) return <PaymentList {...props} />;
  return (
    <Tabs
      className="payments-page-tabs"
      activeKey={tab}
      onChange={(key) => setTab(key === 'onec' ? 'onec' : 'payments')}
      destroyInactiveTabPane
      items={[
        { key: 'payments', label: 'Платежи', children: <PaymentList {...props} /> },
        { key: 'onec', label: 'Поступления 1С', children: <Suspense fallback={null}><OnecReceiptsTab /></Suspense> },
      ]}
    />
  );
};

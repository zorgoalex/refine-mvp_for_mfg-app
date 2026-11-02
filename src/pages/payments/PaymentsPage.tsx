import type { IResourceComponentsProps } from '@refinedev/core';
import { Tabs } from 'antd';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { PaymentList } from './list';
import { canSeeOnecReceiptsTab, readOnecLineParam } from './onecReceiptsAccess';

const OnecReceiptsTab = lazy(async () => ({ default: (await import('./OnecReceiptsTab')).OnecReceiptsTab }));

export { canSeeOnecReceiptsTab };

/**
 * Экран «Платежи»: список платежей (как раньше) и, при праве, вкладка «Поступления 1С». Без права вкладок нет
 * вовсе — экран выглядит как прежде.
 */
export const PaymentsPage: React.FC<IResourceComponentsProps> = (props) => {
  const location = useLocation();
  // `?tab=onec&onecLine=N` — переход из «Финансов» заказа: открыть вкладку 1С и карточку строки.
  const requestedLineId = readOnecLineParam(location.search);
  const requestedOnec = new URLSearchParams(location.search).get('tab') === 'onec';
  const [tab, setTab] = useState<'payments' | 'onec'>(requestedOnec ? 'onec' : 'payments');
  useEffect(() => {
    if (requestedOnec) setTab('onec');
  }, [requestedOnec, location.key]);
  if (!canSeeOnecReceiptsTab()) return <PaymentList {...props} />;
  return (
    <Tabs
      className="payments-page-tabs"
      activeKey={tab}
      onChange={(key) => setTab(key === 'onec' ? 'onec' : 'payments')}
      destroyInactiveTabPane
      items={[
        { key: 'payments', label: 'Платежи', children: <PaymentList {...props} /> },
        { key: 'onec', label: 'Поступления 1С', children: <Suspense fallback={null}><OnecReceiptsTab requestedLineId={requestedLineId} requestKey={location.key} /></Suspense> },
      ]}
    />
  );
};

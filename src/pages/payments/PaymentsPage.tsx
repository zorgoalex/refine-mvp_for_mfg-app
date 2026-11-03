import type { IResourceComponentsProps } from '@refinedev/core';
import { Tabs } from 'antd';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { PaymentList } from './list';
import { canSeeOnecReceiptsTab, readOnecLineParam, withoutOnecLinkParams } from './onecReceiptsAccess';

const OnecReceiptsTab = lazy(async () => ({ default: (await import('./OnecReceiptsTab')).OnecReceiptsTab }));

export { canSeeOnecReceiptsTab };

/**
 * Экран «Платежи»: список платежей (как раньше) и, при праве, вкладка «Поступления 1С». Без права вкладок нет
 * вовсе — экран выглядит как прежде.
 */
export const PaymentsPage: React.FC<IResourceComponentsProps> = (props) => {
  const location = useLocation();
  const navigate = useNavigate();
  // `?tab=onec&onecLine=N` — одноразовая ссылка из «Финансов» заказа: открыть вкладку 1С и карточку строки, затем убрать
  // параметры из адреса. Иначе список платежей (Refine `syncWithLocation` сохраняет чужие параметры) при каждом своём
  // обновлении адреса снова переключал бы на «Поступления 1С».
  const requestedLineId = readOnecLineParam(location.search);
  const requestedOnec = new URLSearchParams(location.search).get('tab') === 'onec';
  const [tab, setTab] = useState<'payments' | 'onec'>(requestedOnec ? 'onec' : 'payments');
  const [cardRequest, setCardRequest] = useState<{ lineId: number; seq: number } | null>(
    requestedLineId === null ? null : { lineId: requestedLineId, seq: 1 },
  );
  useEffect(() => {
    if (!requestedOnec && requestedLineId === null) return;
    if (requestedOnec) setTab('onec');
    if (requestedLineId !== null) setCardRequest((previous) => ({ lineId: requestedLineId, seq: (previous?.seq ?? 0) + 1 }));
    navigate({ pathname: location.pathname, search: withoutOnecLinkParams(location.search) }, { replace: true });
  }, [requestedOnec, requestedLineId, navigate, location.pathname, location.search]);
  if (!canSeeOnecReceiptsTab()) return <PaymentList {...props} />;
  return (
    <Tabs
      className="payments-page-tabs"
      activeKey={tab}
      onChange={(key) => setTab(key === 'onec' ? 'onec' : 'payments')}
      destroyInactiveTabPane
      items={[
        { key: 'payments', label: 'Платежи', children: <PaymentList {...props} /> },
        { key: 'onec', label: 'Поступления 1С', children: <Suspense fallback={null}><OnecReceiptsTab requestedLineId={cardRequest?.lineId ?? null} requestKey={cardRequest?.seq} /></Suspense> },
      ]}
    />
  );
};

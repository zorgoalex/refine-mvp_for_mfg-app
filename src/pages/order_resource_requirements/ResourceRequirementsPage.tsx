import { Tabs } from 'antd';
import { useGetIdentity } from '@refinedev/core';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ordersApi } from '../../api/ordersApi';
import { procurementWorkspaceApi } from '../../api/procurementWorkspaceApi';
import { LocalizedList } from '../../components/LocalizedList';
import { OrderResourceRequirementList } from './list';
import { resolveSupplyTab, type ResourceRequirementsTab } from './resourceRequirementsTabs';
import { RrScreen } from '../procurement_workspace/RrScreen';

const SupplyWorkspace = lazy(async () => ({ default: (await import('../procurement_workspace/SupplyWorkspace')).SupplyWorkspace }));

/**
 * Экран «Потребности заказов в ресурсах»: вкладка «Потребность заказов» — существующий
 * список без изменений (план §1.1); «Экран снабжения» — рабочее место снабженца,
 * только при capabilities.supplyWorkspace и праве procurement.view.
 */
export function ResourceRequirementsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: identity, isLoading: identityLoading } = useGetIdentity<{ permissions?: string[] }>();
  const canView = (identity?.permissions ?? []).includes('procurement.view');
  const [workspaceEnabled, setWorkspaceEnabled] = useState(false);
  const [urgent, setUrgent] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    ordersApi.listResourceDemands({ page: 1, pageSize: 1 })
      .then((response) => { if (alive) setWorkspaceEnabled(response.capabilities?.supplyWorkspace === true); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const available = workspaceEnabled && canView && !identityLoading;
  const tab: ResourceRequirementsTab = resolveSupplyTab(searchParams.get('tab'), available);

  // Бейдж срочных — один запрос, пока снабженец не открыл вкладку (дальше счётчик обновляет сама вкладка).
  useEffect(() => {
    if (!available || urgent !== null) return undefined;
    let alive = true;
    procurementWorkspaceApi.worklist({ preset: 'urgent' })
      .then((response) => { if (alive) setUrgent((current) => current ?? response.counts.urgent); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [available, urgent]);

  const [supplyMounted, setSupplyMounted] = useState(tab === 'supply');
  useEffect(() => { if (tab === 'supply') setSupplyMounted(true); }, [tab]);
  const onUrgentCount = useCallback((count: number) => setUrgent(count), []);

  const changeTab = (next: string) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    if (next === 'supply') params.set('tab', 'supply'); else params.delete('tab');
    return params;
  }, { replace: true });

  const items = [
    {
      key: 'demand',
      label: 'Потребность заказов',
      children: <OrderResourceRequirementList embedded active={tab === 'demand'} />,
    },
    ...(available ? [{
      key: 'supply',
      label: (
        <span>
          Экран снабжения
          {urgent !== null && urgent > 0 && <span className="rr-badge rr-badge--bad" title="Срочно на этой неделе">{urgent}</span>}
        </span>
      ),
      children: supplyMounted
        ? <Suspense fallback={null}><SupplyWorkspace active={tab === 'supply'} onUrgentCount={onUrgentCount} /></Suspense>
        : null,
    }] : []),
  ];

  return (
    <LocalizedList title="Потребности заказов в ресурсах">
      <RrScreen>
      <Tabs
        className="rr-page-tabs"
        activeKey={tab}
        onChange={changeTab}
        items={items}
        // Одна вкладка — без полосы вкладок: экран выглядит ровно как раньше.
        renderTabBar={available ? undefined : () => <></>}
      />
      </RrScreen>
    </LocalizedList>
  );
}

import React, { useCallback } from 'react';
import { Button, Space, Tag } from 'antd';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { useOrderFormData } from '../../hooks/useOrderFormData';
import { useSheetMaterialOptions } from '../../hooks/useSheetMaterialOptions';
import { can } from '../../utils/permissions';
import { ClientScreenControl } from './ClientScreenControl';
import { getClientScreenPresenter } from './clientScreenInstance';
import { useClientScreenOrderBridge } from './useClientScreenOrderBridge';

/**
 * Customer screen in the header of the order edit form. The form passes only what it already has;
 * everything else is read here, so the form itself gets no new hooks. With the feature off nothing
 * is mounted at all.
 */
interface Props {
  orderKey: string;
  orderNumber: string | null;
  activeTab: string;
  operational: boolean;
}

const Connected: React.FC<Props> = ({ orderKey, orderNumber, activeTab, operational }) => {
  const formData = useOrderFormData();
  const keepAlive = useKeepAlive();
  const sheetMaterials = useSheetMaterialOptions();
  const byId = sheetMaterials.byId;
  const sheetMaterialName = useCallback(
    (id: number | null | undefined) => (id === null || id === undefined ? undefined : byId.get(Number(id))?.label),
    [byId],
  );
  const { provider } = useClientScreenOrderBridge({
    orderKey, orderNumber, activeTab, operational, references: formData.references, sheetMaterialName,
    canViewServiceMoney: can('orders.view_financials'),
    active: keepAlive.isActive,
  });
  // The names shown to the customer come from the form's backend reference data. When the form runs
  // on its legacy lookups instead (flag off, or the aggregate failed), presenting is not offered.
  const referencesReady = formData.enabled && formData.data !== null;
  return <ClientScreenControl orderKey={orderKey} provider={provider} referencesReady={referencesReady} />;
};

/**
 * An error of the customer screen must never take the order header down with it: the failed part is
 * replaced by a small notice with a way back, and the customer screen is switched off.
 */
export class ClientScreenBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    void getClientScreenPresenter()?.disableWorkstation().catch(() => undefined);
  }

  retry = (): void => {
    void getClientScreenPresenter()?.enableWorkstation().catch(() => undefined);
    this.setState({ failed: false });
  };

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Space size={6}>
        <Tag color="red">Экран клиента отключён из-за ошибки</Tag>
        <Button style={{ height: '27px', fontSize: '13px', padding: '0 12px' }} onClick={this.retry}>Включить снова</Button>
      </Space>
    );
  }
}

export const ClientScreenOrderHeader: React.FC<Props> = (props) => {
  if (!getClientScreenPresenter()) return null;
  return <ClientScreenBoundary><Connected {...props} /></ClientScreenBoundary>;
};

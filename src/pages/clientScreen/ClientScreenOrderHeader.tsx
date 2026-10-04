import React, { useCallback } from 'react';
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
  const { references } = useOrderFormData();
  const sheetMaterials = useSheetMaterialOptions();
  const byId = sheetMaterials.byId;
  const sheetMaterialName = useCallback(
    (id: number | null | undefined) => (id === null || id === undefined ? undefined : byId.get(Number(id))?.label),
    [byId],
  );
  const { provider } = useClientScreenOrderBridge({
    orderKey, orderNumber, activeTab, operational, references, sheetMaterialName,
    canViewServiceMoney: can('orders.view_financials'),
  });
  return <ClientScreenControl orderKey={orderKey} provider={provider} />;
};

/** An error of the customer screen must never take the order header down with it. */
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    void getClientScreenPresenter()?.disableWorkstation().catch(() => undefined);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export const ClientScreenOrderHeader: React.FC<Props> = (props) => {
  if (!getClientScreenPresenter()) return null;
  return <Boundary><Connected {...props} /></Boundary>;
};

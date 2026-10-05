import React from 'react';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { ClientScreenControl } from './ClientScreenControl';
import { getClientScreenPresenter, useClientScreenView } from './clientScreenInstance';
import { ClientScreenBoundary } from './ClientScreenOrderHeader';
import type { OrderShowSourceInput } from './orderShowSnapshotSource';
import { useClientScreenClientContacts } from './useClientScreenClientContacts';
import { orderShowPresentationKey, useClientScreenShowBridge } from './useClientScreenShowBridge';

/**
 * Customer screen in the header of the order VIEW page. The page passes what it has loaded and what
 * it shows; nothing is loaded here. With the feature off nothing is mounted at all.
 */
interface Props extends OrderShowSourceInput {
  orderId: number | string;
  activeInfoPanel: string | null;
  /** The page's reference lists and details are loaded: without them names would be missing. */
  ready: boolean;
}

const Connected: React.FC<Props> = ({ orderId, ready, ...input }) => {
  const orderKey = orderShowPresentationKey(orderId);
  const presentedHere = useClientScreenView().presentedOrderKey === orderKey;
  const clientId = Number(input.record.client_id);
  const clientContacts = useClientScreenClientContacts(Number.isFinite(clientId) && clientId > 0 ? clientId : null, presentedHere);
  const { provider } = useClientScreenShowBridge({ ...input, clientContacts, orderKey, active: useKeepAlive().isActive });
  return <ClientScreenControl orderKey={orderKey} provider={provider} referencesReady={ready} />;
};

export const ClientScreenShowHeader: React.FC<Props> = (props) => {
  if (!getClientScreenPresenter()) return null;
  return <ClientScreenBoundary><Connected {...props} /></ClientScreenBoundary>;
};

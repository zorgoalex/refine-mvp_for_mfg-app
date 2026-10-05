import { useEffect, useMemo, useRef } from 'react';
import { getClientScreenPresenter } from './clientScreenInstance';
import type { ClientScreenOrderProvider } from './clientScreenPresenter';
import type { ClientScreenUi } from './clientScreenSnapshotSchema';
import { buildOrderShowSource, orderShowMirroredTab, type OrderShowSourceInput } from './orderShowSnapshotSource';
import { useClientScreenScroll } from './useClientScreenOrderBridge';

/**
 * Connects one order VIEW page to the customer screen. It only reads what the page has loaded and
 * shows; while this order is presented it tells the presenter about changes.
 */
export interface ClientScreenShowBridgeInput extends OrderShowSourceInput {
  /** Key of this presentation source; differs from the edit form's key of the same order. */
  orderKey: string;
  /** The info panel open on the page ('finance', 'groups', …) or null. */
  activeInfoPanel: string | null;
  /** This page's workspace tab is the one on screen. */
  active: boolean;
}

export const orderShowPresentationKey = (orderId: number | string): string => `view:${orderId}`;

export function useClientScreenShowBridge(input: ClientScreenShowBridgeInput): { provider: ClientScreenOrderProvider } {
  const latest = useRef(input);
  latest.current = input;
  const scrollRatio = useClientScreenScroll(input.orderKey, input.active);

  const provider = useMemo<ClientScreenOrderProvider>(() => ({
    getSource: () => buildOrderShowSource(latest.current),
    getUi(): ClientScreenUi {
      const current = latest.current;
      return {
        tab: orderShowMirroredTab(current.activeInfoPanel, current.canViewFinancials),
        focus: null,
        editing: null,
        scroll: { ratio: scrollRatio() },
        page: null,
      };
    },
  }), [scrollRatio]);

  const { orderKey } = input;

  // The page is gone (tab closed, another order opened in it): the customer sees the splash.
  useEffect(() => () => {
    getClientScreenPresenter()?.hide(orderKey);
  }, [orderKey]);

  const columns = input.columnKeys.join('\u0001');
  useEffect(() => {
    getClientScreenPresenter()?.notifyChanged(orderKey);
  }, [
    orderKey, input.record, input.clientName, input.details, input.groupedRows, input.groupField, columns, input.payments,
    input.names.millingType, input.names.edgeType, input.names.film, input.names.paymentType, input.names.productionStatus,
    input.names.materialOf, input.canViewFinancials,
  ]);

  useEffect(() => {
    getClientScreenPresenter()?.notifyUi(orderKey);
  }, [orderKey, input.activeInfoPanel, input.active]);

  return { provider };
}

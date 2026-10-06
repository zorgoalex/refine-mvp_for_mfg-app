import { useEffect, useMemo, useRef } from 'react';
import { getClientScreenPresenter } from './clientScreenInstance';
import type { ClientScreenOrderProvider } from './clientScreenPresenter';
import type { ClientScreenUi } from './clientScreenSnapshotSchema';
import { buildOrderShowSource, orderShowMirroredTab, type OrderShowSourceInput } from './orderShowSnapshotSource';
import { releaseClientScreenSource, useClientScreenScroll } from './useClientScreenOrderBridge';

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

export { orderShowPresentationKey } from './clientScreenOrderKeys';

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

  // Back on screen: the live source again. Gone: the presentation goes on while the tab stays open.
  useEffect(() => {
    getClientScreenPresenter()?.attach(orderKey, provider);
    return () => releaseClientScreenSource(orderKey, provider);
  }, [orderKey, provider]);

  const columns = input.columnKeys.join('\u0001');
  useEffect(() => {
    getClientScreenPresenter()?.notifyChanged(orderKey);
  }, [
    orderKey, input.record, input.clientName, input.clientContacts, input.details, input.groupedRows, input.groupField, columns, input.payments,
    input.names.millingType, input.names.edgeType, input.names.film, input.names.paymentType, input.names.productionStatus,
    input.names.materialOf, input.canViewFinancials, input.hdfDetails, input.cutJobByDetailId, input.bathCutJobByDetailId, input.dowelingLinks,
    input.employeeName, input.projectLabel, input.liveProductionStatusByDetailId, input.groupLabelOf,
  ]);

  useEffect(() => {
    getClientScreenPresenter()?.notifyUi(orderKey);
  }, [orderKey, input.activeInfoPanel, input.active]);

  return { provider };
}

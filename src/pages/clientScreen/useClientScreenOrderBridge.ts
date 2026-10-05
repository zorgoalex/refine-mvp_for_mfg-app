import { useEffect, useMemo, useRef } from 'react';
import type { OrderFormDataReferences } from '../../query/orderFormDataReferences';
import { getOrderDraftStore } from '../../stores/orderFormStore';
import type { ClientScreenIdFor } from './buildClientScreenSnapshot';
import { getClientScreenPresenter } from './clientScreenInstance';
import type { ClientScreenOrderProvider } from './clientScreenPresenter';
import { CLIENT_SCREEN_TAB_KEYS, type ClientScreenTabKey, type ClientScreenUi } from './clientScreenSnapshotSchema';
import { buildOrderEditSource, DETAIL_COLUMN_FIELDS, type OrderEditSourceInput } from './orderEditSnapshotSource';

/**
 * Connects one order edit form to the customer screen. It only READS the form: the draft store, the
 * reference names the form has already loaded, the active tab. While this order is presented it
 * tells the presenter about changes; otherwise it does nothing.
 */
export interface ClientScreenOrderBridgeInput {
  orderKey: string;
  /** Full order number for the title, when the form has it. */
  orderNumber: string | null;
  activeTab: string;
  /** The compact "operational" layout names and orders its tabs differently. */
  operational: boolean;
  references: OrderFormDataReferences | null | undefined;
  sheetMaterialName: (id: number | null | undefined) => string | undefined;
  canViewServiceMoney: boolean;
  /** This order's workspace tab is the one on screen (several order forms stay mounted at once). */
  active: boolean;
}

const TAB_LABELS: Record<ClientScreenTabKey, [string, string]> = {
  basic: ['Основная информация', 'Обзор'],
  details: ['Детали заказа', 'Состав'],
  dates: ['Даты', 'Логистика'],
  finance: ['Финансы', 'Финансы'],
  services: ['Услуги/товары', 'Услуги/товары'],
};
const TAB_ORDER: Record<'default' | 'operational', ClientScreenTabKey[]> = {
  default: ['basic', 'details', 'dates', 'finance', 'services'],
  operational: ['basic', 'details', 'finance', 'dates', 'services'],
};

/** Tabs of the form the customer screen can mirror, with the labels and order the manager sees. */
export function orderFormMirrorTabs(operational: boolean): Array<{ key: ClientScreenTabKey; label: string }> {
  return TAB_ORDER[operational ? 'operational' : 'default'].map((key) => ({ key, label: TAB_LABELS[key][operational ? 1 : 0] }));
}

const fromList = (options: ReadonlyArray<{ value?: unknown; label?: unknown }> | undefined) => (id: number | null | undefined) => {
  if (id === null || id === undefined) return undefined;
  const found = options?.find((option) => Number(option.value) === Number(id));
  return found && typeof found.label === 'string' ? found.label : undefined;
};
const fromMap = (map: Map<number, string> | undefined) => (id: number | null | undefined) =>
  (id === null || id === undefined ? undefined : map?.get(Number(id)));

export function orderFormNames(
  references: OrderFormDataReferences | null | undefined,
  sheetMaterialName: (id: number | null | undefined) => string | undefined,
): OrderEditSourceInput['names'] {
  return {
    client: fromList(references?.clients),
    orderStatus: fromList(references?.orderStatuses),
    paymentStatus: fromList(references?.paymentStatuses),
    productionStatus: fromMap(references?.productionStatusNameById),
    employee: fromList(references?.employees),
    sheetMaterial: sheetMaterialName,
    millingType: fromMap(references?.millingTypeNameById),
    edgeType: fromMap(references?.edgeTypeNameById),
    film: fromMap(references?.filmNameById),
    paymentType: fromMap(references?.paymentTypeNameById),
  };
}

/** The manager's tab as a mirrored tab key, or null when the customer screen has no such tab. */
export function mirroredTab(activeTab: string): ClientScreenTabKey | null {
  return (CLIENT_SCREEN_TAB_KEYS as readonly string[]).includes(activeTab) ? activeTab as ClientScreenTabKey : null;
}

function currentScrollRatio(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

/** Detail columns in the form's default order; the manager's own column settings come in a later step. */
const DEFAULT_DETAIL_COLUMNS = Object.keys(DETAIL_COLUMN_FIELDS);

export function useClientScreenOrderBridge(input: ClientScreenOrderBridgeInput): { provider: ClientScreenOrderProvider } {
  const latest = useRef(input);
  latest.current = input;
  // Scroll position of THIS order: sampled only while its workspace tab is on screen, kept otherwise.
  const scrollRatio = useRef(0);

  const provider = useMemo<ClientScreenOrderProvider>(() => ({
    getSource() {
      const current = latest.current;
      const state = getOrderDraftStore(current.orderKey).getState();
      return buildOrderEditSource({
        header: state.header,
        details: state.details,
        payments: state.payments,
        catalogLines: state.catalogLines,
        dowelingLinks: state.dowelingLinks,
        orderNumber: current.orderNumber,
        tabs: orderFormMirrorTabs(current.operational),
        names: orderFormNames(current.references, current.sheetMaterialName),
        detailColumnOrder: DEFAULT_DETAIL_COLUMNS,
        grouping: null,
        canViewServiceMoney: current.canViewServiceMoney,
      });
    },
    getUi(_idFor: ClientScreenIdFor): ClientScreenUi {
      const current = latest.current;
      if (current.active) scrollRatio.current = currentScrollRatio();
      return {
        // The manager's own tab; on a tab that is not mirrored the presenter keeps the customer's last one.
        tab: mirroredTab(current.activeTab),
        focus: null,
        editing: null,
        scroll: { ratio: scrollRatio.current },
        page: null,
      };
    },
  }), []);

  const { orderKey } = input;

  // Draft changes of the presented order go to the customer screen.
  useEffect(() => {
    const presenter = getClientScreenPresenter();
    if (!presenter) return undefined;
    const unsubscribe = getOrderDraftStore(orderKey).subscribe(() => presenter.notifyChanged(orderKey));
    return () => {
      unsubscribe();
      // The form of the presented order is gone (tab closed, order switched): the customer sees the splash.
      presenter.hide(orderKey);
    };
  }, [orderKey]);

  // Names loaded later, the order number and the layout change what is shown as well.
  useEffect(() => {
    getClientScreenPresenter()?.notifyChanged(orderKey);
  }, [orderKey, input.references, input.orderNumber, input.operational, input.canViewServiceMoney, input.sheetMaterialName]);

  useEffect(() => {
    getClientScreenPresenter()?.notifyUi(orderKey);
  }, [orderKey, input.activeTab, input.active]);

  useEffect(() => {
    const presenter = getClientScreenPresenter();
    if (!presenter) return undefined;
    let frame = 0;
    const onScroll = () => {
      // Another order's tab may be on screen: its scrolling is not this order's.
      if (frame || !latest.current.active || presenter.getView().presentedOrderKey !== orderKey) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        presenter.notifyUi(orderKey);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [orderKey]);

  return { provider };
}

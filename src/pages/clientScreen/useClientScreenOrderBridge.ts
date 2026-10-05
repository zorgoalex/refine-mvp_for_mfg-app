import { useEffect, useMemo, useRef } from 'react';
import type { OrderFormDataReferences } from '../../query/orderFormDataReferences';
import { getOrderDraftStore } from '../../stores/orderFormStore';
import type { ClientScreenIdFor } from './buildClientScreenSnapshot';
import { getClientScreenPresenter } from './clientScreenInstance';
import type { ClientScreenOrderProvider } from './clientScreenPresenter';
import { CLIENT_SCREEN_TAB_KEYS, type ClientScreenTabKey, type ClientScreenUi } from './clientScreenSnapshotSchema';
import {
  buildOrderEditSource, DETAIL_COLUMN_FIELDS, detailRowKey, orderEditEditingValues, type OrderEditSourceInput,
} from './orderEditSnapshotSource';
import {
  orderDetailMirrorStructure, readOrderDetailTableMirror, subscribeOrderDetailTableMirror, type OrderDetailTableMirror,
} from './orderDetailTableMirror';

/**
 * Connects one order edit form to the customer screen. It only READS the form: the draft store, the
 * reference names the form has already loaded, the active tab, and what the detail table shows
 * (its columns, row order, page, groups, the row being edited). While this order is presented it
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
  /** Film names including films no longer offered for new details; the form's own list when absent. */
  filmNameById?: Map<number, string>;
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
  filmNameById?: Map<number, string>,
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
    film: fromMap(filmNameById ?? references?.filmNameById),
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

/** Detail columns in the form's default order, used until the detail table has been on screen. */
const DEFAULT_DETAIL_COLUMNS = Object.keys(DETAIL_COLUMN_FIELDS);
/** How often the open row editor is looked at for new values while the order is presented. */
const EDITOR_POLL_MS = 200;

const editorValuesOf = (mirror: OrderDetailTableMirror): Record<string, unknown> => {
  try {
    return mirror.getEditingValues() ?? {};
  } catch {
    return {};
  }
};
const activeCellOf = (mirror: OrderDetailTableMirror): { rowKey: string; columnKey: string } | null => {
  try {
    const cell = mirror.getActiveCell();
    return cell ? { rowKey: String(cell.rowKey), columnKey: String(cell.columnKey) } : null;
  } catch {
    return null;
  }
};

/** The table's page, when it is one the customer screen can take. */
export function mirroredPage(page: OrderDetailTableMirror['page'] | undefined): ClientScreenUi['page'] {
  if (!page || !Number.isSafeInteger(page.current) || !Number.isSafeInteger(page.size)) return null;
  if (page.current < 1 || page.current > 100000 || page.size < 1 || page.size > 1000) return null;
  return { current: page.current, size: page.size };
}

/**
 * The row being edited as the customer screen takes it: the editor's current values as display text
 * and the cell the manager is in (the editor's cell, or the cell the keyboard is in when no editor
 * is open). Filtering by the settings happens later, in the presenter.
 */
export function mirroredEditing(
  mirror: OrderDetailTableMirror | null,
  details: ReadonlyArray<OrderEditSourceInput['details'][number]>,
  names: OrderEditSourceInput['names'],
  idFor: ClientScreenIdFor,
): Pick<ClientScreenUi, 'focus' | 'editing'> {
  if (!mirror) return { focus: null, editing: null };
  const exists = (rowKey: string) => details.some((item) => detailRowKey(item) === rowKey);
  const cellFocus = (rowKey: string, columnKey: string | null): ClientScreenUi['focus'] => {
    const field = columnKey ? DETAIL_COLUMN_FIELDS[columnKey] : undefined;
    return field && exists(rowKey) ? { code: `details.${field}`, rowId: idFor('detail', rowKey) } : null;
  };
  const editing = mirror.editing;
  const detail = editing ? details.find((item) => detailRowKey(item) === editing.rowKey) : undefined;
  if (!editing || !detail) {
    const cell = activeCellOf(mirror);
    return { focus: cell ? cellFocus(cell.rowKey, cell.columnKey) : null, editing: null };
  }
  const values = orderEditEditingValues(detail, editorValuesOf(mirror), names, mirror.columnKeys);
  return {
    focus: cellFocus(editing.rowKey, editing.field),
    editing: values.length ? { rowId: idFor('detail', editing.rowKey), values } : null,
  };
}

export function useClientScreenOrderBridge(input: ClientScreenOrderBridgeInput): { provider: ClientScreenOrderProvider } {
  const latest = useRef(input);
  latest.current = input;
  // Scroll position of THIS order: sampled only while its workspace tab is on screen, kept otherwise.
  const scrollRatio = useRef(0);

  const provider = useMemo<ClientScreenOrderProvider>(() => ({
    getSource() {
      const current = latest.current;
      const store = getOrderDraftStore(current.orderKey);
      const state = store.getState();
      const mirror = readOrderDetailTableMirror(store);
      return buildOrderEditSource({
        header: state.header,
        details: state.details,
        payments: state.payments,
        catalogLines: state.catalogLines,
        dowelingLinks: state.dowelingLinks,
        orderNumber: current.orderNumber,
        tabs: orderFormMirrorTabs(current.operational),
        names: orderFormNames(current.references, current.sheetMaterialName, current.filmNameById),
        // The manager's own columns, sorting and grouping, once the detail table has been on screen.
        detailColumnOrder: mirror?.columnKeys ?? DEFAULT_DETAIL_COLUMNS,
        detailRowOrder: mirror?.rowKeys ?? null,
        grouping: mirror?.grouping ?? null,
        // Its live values travel with the interface state; here the row only has to exist.
        editingRow: mirror?.editing ? { rowKey: mirror.editing.rowKey, values: {} } : null,
        canViewServiceMoney: current.canViewServiceMoney,
      });
    },
    getUi(idFor: ClientScreenIdFor): ClientScreenUi {
      const current = latest.current;
      if (current.active) scrollRatio.current = currentScrollRatio();
      const store = getOrderDraftStore(current.orderKey);
      const mirror = readOrderDetailTableMirror(store);
      const names = orderFormNames(current.references, current.sheetMaterialName, current.filmNameById);
      return {
        // The manager's own tab; on a tab that is not mirrored the presenter keeps the customer's last one.
        tab: mirroredTab(current.activeTab),
        ...mirroredEditing(mirror, store.getState().details, names, idFor),
        scroll: { ratio: scrollRatio.current },
        page: mirroredPage(mirror?.page),
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
  }, [orderKey, input.references, input.orderNumber, input.operational, input.canViewServiceMoney, input.sheetMaterialName, input.filmNameById]);

  // The detail table: its columns, row order and groups change the snapshot; the page and the cell
  // are interface state. The open row editor and the cell the keyboard is in are looked at on a
  // timer, only while this order is presented, so the table itself does no extra work per keystroke.
  useEffect(() => {
    const presenter = getClientScreenPresenter();
    if (!presenter) return undefined;
    const store = getOrderDraftStore(orderKey);
    const presented = () => presenter.getView().presentedOrderKey === orderKey;
    let structure = '';
    let editorValues = '';
    const unsubscribe = subscribeOrderDetailTableMirror(store, () => {
      if (!presented()) return;
      const next = orderDetailMirrorStructure(readOrderDetailTableMirror(store));
      if (next !== structure) {
        structure = next;
        presenter.notifyChanged(orderKey);
      } else presenter.notifyUi(orderKey);
    });
    const timer = window.setInterval(() => {
      if (!presented()) return;
      const mirror = readOrderDetailTableMirror(store);
      let next = '';
      try {
        if (mirror) next = JSON.stringify([mirror.editing ? editorValuesOf(mirror) : null, activeCellOf(mirror)]);
      } catch {
        return;
      }
      if (next === editorValues) return;
      editorValues = next;
      presenter.notifyUi(orderKey);
    }, EDITOR_POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [orderKey]);

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

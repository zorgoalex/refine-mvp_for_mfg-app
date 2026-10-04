import { CLIENT_SCREEN_GROUPS, isClientScreenCodeVisible, type ClientScreenCode } from './clientScreenRegistry';
import {
  CLIENT_SCREEN_TAB_KEYS, type ClientScreenField, type ClientScreenSnapshot, type ClientScreenTabKey, type ClientScreenTable,
  type ClientScreenUi,
} from './clientScreenSnapshotSchema';

/**
 * What an order screen (edit form or view page) hands over for presenting. Values are already
 * display text. `undefined` means the manager does not have the value at all (for example money
 * without the right to see it): such a field is not sent. `null` or '' is an empty value: «—».
 * Keys of rows and groups are private to the manager window and never leave it.
 */
export type ClientScreenValue = string | null | undefined;
type FieldsOf<G extends string> = Partial<Record<G, ClientScreenValue>>;

export interface ClientScreenRowSource<F extends string> {
  key: string;
  values: FieldsOf<F>;
}

export interface ClientScreenOrderSource {
  /** Tabs as the manager sees them: their order and their labels. */
  tabs: ReadonlyArray<{ key: ClientScreenTabKey; label: string }>;
  summary: FieldsOf<'number' | 'client' | 'parts' | 'area' | 'final' | 'debt'>;
  basic: FieldsOf<'client' | 'order_name' | 'order_date' | 'order_status' | 'payment_status' | 'production_status' | 'manager' | 'priority' | 'doweling' | 'notes'>;
  dates: FieldsOf<'planned' | 'completion' | 'issue'>;
  finance: FieldsOf<'total' | 'discount' | 'surcharge' | 'final' | 'paid' | 'debt'>;
  payments: ReadonlyArray<ClientScreenRowSource<'date' | 'type' | 'amount' | 'note'>>;
  details: {
    /** Detail fields in the order of the manager's own visible columns. */
    columnOrder: ReadonlyArray<DetailField>;
    rows: ReadonlyArray<ClientScreenRowSource<DetailField>>;
    /** How the manager groups the rows; the group title is the value of `field`. */
    grouping?: { field: DetailField | null; groups: ReadonlyArray<{ key: string; title: string; rowKeys: ReadonlyArray<string> }> } | null;
  };
  services: ReadonlyArray<ClientScreenRowSource<'name' | 'quantity' | 'price' | 'sum'>>;
}

export type DetailField = 'n' | 'name' | 'height' | 'width' | 'quantity' | 'area' | 'material' | 'milling_type' | 'edge_type' | 'film'
  | 'price_per_sqm' | 'cost' | 'note' | 'production_status';

/** Issues opaque ids for rows and groups; the manager window keeps one per presentation. */
export type ClientScreenIdFor = (scope: 'detail' | 'detail-group' | 'payment' | 'service', key: string) => string;

const EMPTY = '—';
const RIGHT_ALIGNED = new Set(['height', 'width', 'quantity', 'area', 'price_per_sqm', 'cost', 'amount', 'price', 'sum']);
const LABELS = new Map<string, string>(CLIENT_SCREEN_GROUPS.flatMap((group) => group.fields.map((field) => [field.code, field.label] as const)));
const text = (value: ClientScreenValue): string => (value === null || value === undefined || value === '' ? EMPTY : value);

function fields<G extends string>(group: string, order: readonly G[], values: FieldsOf<G>, visible: ReadonlySet<string>): ClientScreenField[] {
  const result: ClientScreenField[] = [];
  for (const key of order) {
    const code = `${group}.${key}` as ClientScreenCode;
    if (!isClientScreenCodeVisible(code, visible) || values[key] === undefined) continue;
    result.push({ code, label: LABELS.get(code) ?? key, value: text(values[key]) });
  }
  return result;
}

const fieldKeys = (group: string): string[] =>
  (CLIENT_SCREEN_GROUPS.find((item) => item.key === group)?.fields ?? []).map((field) => field.code.slice(group.length + 1));

/**
 * Builds the snapshot the customer may see. Only values of codes that are ticked (a field together
 * with its tab) are copied; nothing else of the source reaches the result — not as a value, not as a
 * label, not inside an id or a group title.
 */
export function buildClientScreenSnapshot(source: ClientScreenOrderSource, visibleCodes: Iterable<string>, idFor: ClientScreenIdFor): ClientScreenSnapshot {
  const visible = new Set(visibleCodes);
  const tabOn = (key: ClientScreenTabKey) => visible.has(`tab.${key}`) && source.tabs.some((tab) => tab.key === key);

  const snapshot: ClientScreenSnapshot = {
    title: visible.has('summary.number') && source.summary.number ? `Заказ № ${source.summary.number}` : 'Ваш заказ',
    summary: fields('summary', ['client', 'parts', 'area', 'final', 'debt'], source.summary, visible),
    tabs: source.tabs
      .filter((tab) => (CLIENT_SCREEN_TAB_KEYS as readonly string[]).includes(tab.key) && tabOn(tab.key))
      .map((tab) => (tab.key === 'details' ? { key: tab.key, label: tab.label, counter: String(source.details.rows.length) } : { key: tab.key, label: tab.label })),
  };

  if (tabOn('basic')) snapshot.basic = fields('basic', fieldKeys('basic') as Array<keyof ClientScreenOrderSource['basic']>, source.basic, visible);
  if (tabOn('dates')) snapshot.dates = fields('dates', fieldKeys('dates') as Array<keyof ClientScreenOrderSource['dates']>, source.dates, visible);

  if (tabOn('finance')) {
    const financeKeys = (fieldKeys('finance') as string[]).filter((key) => key !== 'payments' && key !== 'payments_note');
    snapshot.finance = { fields: fields('finance', financeKeys as Array<keyof ClientScreenOrderSource['finance']>, source.finance, visible) };
    if (isClientScreenCodeVisible('finance.payments', visible)) {
      const withNote = isClientScreenCodeVisible('finance.payments_note', visible);
      const columns: ClientScreenTable['columns'] = [
        { code: 'finance.payments', label: 'Дата', align: 'left' },
        { code: 'finance.payments', label: 'Тип', align: 'left' },
        { code: 'finance.payments', label: 'Сумма', align: 'right' },
        ...(withNote ? [{ code: 'finance.payments_note' as const, label: 'Примечание', align: 'left' as const }] : []),
      ];
      snapshot.finance.payments = {
        columns,
        rows: source.payments.map((row) => ({
          id: idFor('payment', row.key),
          cells: [text(row.values.date), text(row.values.type), text(row.values.amount), ...(withNote ? [text(row.values.note)] : [])],
        })),
      };
    }
  }

  if (tabOn('details')) {
    const order = source.details.columnOrder.filter((field, index, all) => all.indexOf(field) === index
      && isClientScreenCodeVisible(`details.${field}`, visible) && available(source.details.rows, field));
    const table: ClientScreenTable = {
      columns: order.map((field) => ({
        code: `details.${field}` as ClientScreenCode, label: LABELS.get(`details.${field}`) ?? field, align: RIGHT_ALIGNED.has(field) ? 'right' : 'left',
      })),
      rows: source.details.rows.map((row) => ({ id: idFor('detail', row.key), cells: order.map((field) => text(row.values[field])) })),
    };
    const grouping = source.details.grouping;
    // Group headers carry the value of the grouping field, so they go only when that field may be seen.
    if (grouping?.field && isClientScreenCodeVisible(`details.${grouping.field}`, visible)) {
      const known = new Set(source.details.rows.map((row) => row.key));
      table.groups = grouping.groups.map((group) => ({
        id: idFor('detail-group', group.key),
        title: text(group.title),
        rowIds: group.rowKeys.filter((key) => known.has(key)).map((key) => idFor('detail', key)),
      }));
    }
    snapshot.details = table;
  }

  if (tabOn('services')) {
    const order = (['name', 'quantity', 'price', 'sum'] as const)
      .filter((field) => isClientScreenCodeVisible(`services.${field}`, visible) && available(source.services, field));
    snapshot.services = {
      columns: order.map((field) => ({
        code: `services.${field}` as ClientScreenCode, label: LABELS.get(`services.${field}`) ?? field, align: RIGHT_ALIGNED.has(field) ? 'right' : 'left',
      })),
      rows: source.services.map((row) => ({ id: idFor('service', row.key), cells: order.map((field) => text(row.values[field])) })),
    };
  }
  return snapshot;
}

/** A column whose value the manager has for no row at all (no right to see it) is not sent, not even as dashes. */
function available<F extends string>(rows: ReadonlyArray<ClientScreenRowSource<F>>, field: F): boolean {
  return rows.length === 0 || rows.some((row) => row.values[field] !== undefined);
}

/**
 * The interface state the customer may see next to `snapshot`: it goes through the same policy as
 * the data. A tab, a focus mark, a row reference or a value being edited that the snapshot does not
 * contain is dropped — in particular the editor value of a field that is not ticked.
 */
export function filterClientScreenUi(ui: ClientScreenUi, snapshot: ClientScreenSnapshot, visibleCodes: Iterable<string>): ClientScreenUi {
  const visible = new Set(visibleCodes);
  const tabs = new Set<string>(snapshot.tabs.map((tab) => tab.key));
  const rowIds = new Set<string>([
    ...(snapshot.details?.rows ?? []), ...(snapshot.services?.rows ?? []), ...(snapshot.finance?.payments?.rows ?? []),
  ].map((row) => row.id));
  const detailRowIds = new Set<string>((snapshot.details?.rows ?? []).map((row) => row.id));
  const detailCodes = new Set<string>((snapshot.details?.columns ?? []).map((column) => column.code));
  const shown = (code: string) => isClientScreenCodeVisible(code, visible) && (code.startsWith('summary.') || tabs.has(code.split('.')[0]));

  const focus = ui.focus && shown(ui.focus.code) && (ui.focus.rowId === undefined || rowIds.has(ui.focus.rowId)) ? ui.focus : null;
  const values = ui.editing && detailRowIds.has(ui.editing.rowId) ? ui.editing.values.filter((item) => detailCodes.has(item.code)) : [];
  return {
    tab: ui.tab && tabs.has(ui.tab) ? ui.tab : null,
    focus,
    editing: ui.editing && values.length ? { rowId: ui.editing.rowId, values } : null,
    scroll: ui.scroll ? { ratio: ui.scroll.ratio, ...(ui.scroll.anchorRowId && rowIds.has(ui.scroll.anchorRowId) ? { anchorRowId: ui.scroll.anchorRowId } : {}) } : null,
    page: ui.page && tabs.has('details') ? ui.page : null,
  };
}

/** Stable opaque ids for one presentation: the same key always gets the same id, keys never leak. */
export function createClientScreenIdMap(random: () => string): ClientScreenIdFor {
  const ids = new Map<string, string>();
  return (scope, key) => {
    const full = `${scope}\u0000${key}`;
    let id = ids.get(full);
    if (!id) {
      id = random();
      ids.set(full, id);
    }
    return id;
  };
}

/** The tab the customer sees: the manager's tab when it is visible, otherwise the last visible one. */
export function resolveClientScreenTab(
  managerTab: string | null, lastVisible: ClientScreenTabKey | null, snapshot: Pick<ClientScreenSnapshot, 'tabs'>,
): ClientScreenTabKey | null {
  const keys = snapshot.tabs.map((tab) => tab.key);
  if (managerTab && (keys as string[]).includes(managerTab)) return managerTab as ClientScreenTabKey;
  if (lastVisible && keys.includes(lastVisible)) return lastVisible;
  return keys[0] ?? null;
}

import { CLIENT_SCREEN_GROUPS, isClientScreenCodeVisible, type ClientScreenCode } from './clientScreenRegistry';
import { MATERIAL_FILM_FIELDS, MATERIAL_SHEET_FIELDS, type MaterialFilmField, type MaterialSheetField } from './orderMaterialsMirror';
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
  /** The order header above the tabs, as the manager's header shows it (no statuses, priority or project). */
  summary: FieldsOf<'number' | 'order_name' | 'client' | 'client_phone' | 'client_phones' | 'deadline' | 'positions' | 'parts' | 'area' | 'material' | 'milling_type' | 'edge_type' | 'film' | 'final' | 'discount' | 'surcharge' | 'paid' | 'debt'
    | 'designer' | 'basis_project' | 'project' | 'order_status' | 'payment_status' | 'production_status' | 'priority' | 'created_by'>;
  basic: FieldsOf<'client' | 'order_name' | 'order_date' | 'order_status' | 'payment_status' | 'production_status' | 'manager' | 'priority' | 'doweling' | 'notes'>;
  dates: FieldsOf<'planned' | 'completion' | 'issue'>;
  /** The HDF tab of the edit form; a screen without such a tab leaves it out. */
  hdf?: { fields: FieldsOf<'min_threshold' | 'total'>; rows: ReadonlyArray<ClientScreenRowSource<HdfField>> };
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
  /** The «Материалы» tab as that tab reports it; absent while the tab is not on the manager's screen. */
  requirements?: {
    /** Columns the manager's own tables have; a column outside these lists is never sent, ticked or not. */
    filmColumns: ReadonlyArray<MaterialFilmField>;
    sheetColumns: ReadonlyArray<MaterialSheetField>;
    films: ReadonlyArray<ClientScreenRowSource<MaterialFilmField>>;
    sheets: ReadonlyArray<ClientScreenRowSource<MaterialSheetField>>;
  };
}

/** Columns of the HDF table, in the order of the manager's tab. */
export const HDF_FIELDS = ['position', 'milling_type', 'source_height', 'source_width', 'source_quantity', 'parameter', 'height', 'width', 'quantity', 'area',
  'status', 'production_status', 'cut_job', 'bazis_cut_sets'] as const;
export type HdfField = typeof HDF_FIELDS[number];

export type DetailField = 'n' | 'name' | 'height' | 'width' | 'quantity' | 'area' | 'material' | 'milling_type' | 'edge_type' | 'film'
  | 'price_per_sqm' | 'cost' | 'note' | 'production_status'
  | 'hdf_parameter' | 'doweling' | 'cut_job' | 'bath_cut_job' | 'bazis_cut_sets' | 'priority' | 'basis_project' | 'basis_product' | 'basis_data'
  | 'basis_designation';

/** Issues opaque ids for rows and groups; the manager window keeps one per presentation. */
export type ClientScreenIdFor = (scope: 'detail' | 'detail-group' | 'payment' | 'service' | 'hdf' | 'film' | 'sheet', key: string) => string;

const EMPTY = '—';
const RIGHT_ALIGNED = new Set(['height', 'width', 'quantity', 'area', 'price_per_sqm', 'cost', 'amount', 'price', 'sum', 'hdf_parameter', 'priority',
  'source_height', 'source_width', 'source_quantity', 'parameter', 'film_area', 'film_meters', 'film_stock', 'sheet_area', 'sheet_stock']);
const LABELS = new Map<string, string>(CLIENT_SCREEN_GROUPS.flatMap((group) => group.fields.map((field) => [field.code, field.label] as const)));
/** The longest text the wire takes for one value; longer text is cut, visibly, instead of failing the whole snapshot. */
export const CLIENT_SCREEN_TEXT_LIMIT = 2000;
const text = (value: ClientScreenValue): string => {
  if (value === null || value === undefined || value === '') return EMPTY;
  return value.length > CLIENT_SCREEN_TEXT_LIMIT ? `${value.slice(0, CLIENT_SCREEN_TEXT_LIMIT - 1)}…` : value;
};

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
    title: clientScreenTitle(source, visible).text,
    // The name is a header line of its own only when the title is made of the number.
    summary: fields('summary', SUMMARY_ORDER.filter((key) => key !== 'order_name' || clientScreenTitle(source, visible).by === 'number'), source.summary, visible),
    tabs: source.tabs
      .filter((tab) => (CLIENT_SCREEN_TAB_KEYS as readonly string[]).includes(tab.key) && tabOn(tab.key) && (tab.key !== 'hdf' || Boolean(source.hdf))
        && (tab.key !== 'requirements' || Boolean(source.requirements)))
      .map((tab) => (tab.key === 'details' ? { key: tab.key, label: tab.label.slice(0, 200), counter: String(source.details.rows.length) } : { key: tab.key, label: tab.label.slice(0, 200) })),
  };

  if (tabOn('basic')) snapshot.basic = fields('basic', fieldKeys('basic') as Array<keyof ClientScreenOrderSource['basic']>, source.basic, visible);
  if (tabOn('dates')) snapshot.dates = fields('dates', fieldKeys('dates') as Array<keyof ClientScreenOrderSource['dates']>, source.dates, visible);

  if (tabOn('hdf') && source.hdf) {
    const hdf = source.hdf;
    snapshot.hdf = { fields: fields('hdf', ['min_threshold', 'total'], hdf.fields, visible) };
    const order = HDF_FIELDS.filter((field) => isClientScreenCodeVisible(`hdf.${field}`, visible) && available(hdf.rows, field));
    if (order.length > 0) {
      snapshot.hdf.table = {
        columns: order.map((field) => ({
          code: `hdf.${field}` as ClientScreenCode, label: LABELS.get(`hdf.${field}`) ?? field, align: RIGHT_ALIGNED.has(field) ? 'right' : 'left',
        })),
        rows: hdf.rows.map((row) => ({ id: idFor('hdf', row.key), cells: order.map((field) => text(row.values[field])) })),
      };
    }
  }

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
    // The row number is always the first column: the manager and the customer see different amounts
    // of the list and need a common way to name a row. It needs no tick of its own.
    const order: DetailField[] = ['n', ...source.details.columnOrder.filter((field, index, all) => field !== 'n' && all.indexOf(field) === index
      && isClientScreenCodeVisible(`details.${field}`, visible) && available(source.details.rows, field))];
    // (isClientScreenCodeVisible knows the same rule: `details.n` goes with its tab.)
    const table: ClientScreenTable = {
      columns: order.map((field) => ({
        code: `details.${field}` as ClientScreenCode, label: LABELS.get(`details.${field}`) ?? field, align: RIGHT_ALIGNED.has(field) ? 'right' : 'left',
      })),
      rows: source.details.rows.map((row) => ({ id: idFor('detail', row.key), cells: order.map((field) => text(row.values[field])) })),
    };
    const grouping = source.details.grouping;
    // Group headers carry the value of the grouping field, so they go only when that very column is
    // on the customer's table: ticked, a value the manager has at all (not money without the right
    // to see it), and a column the manager's own table shows (a column withheld from the manager by
    // a permission or by the column settings never names its values in a group title either).
    if (grouping?.field && order.includes(grouping.field) && available(source.details.rows, grouping.field)
      && source.details.rows.some((row) => row.values[grouping.field as DetailField] !== undefined)) {
      const field = grouping.field;
      const rowByKey = new Map(source.details.rows.map((row) => [row.key, row]));
      table.groups = grouping.groups.map((group) => {
        const rowKeys = group.rowKeys.filter((key) => rowByKey.has(key));
        return {
          id: idFor('detail-group', group.key),
          // Cut jobs are named by the table's cells (its list of the last ready jobs is the
          // authority), not by the grouping label, which may still carry a job that is gone.
          title: TITLE_FROM_CELL.has(field) ? text(rowKeys.length ? rowByKey.get(rowKeys[0])!.values[field] : null) : text(group.title),
          rowIds: rowKeys.map((key) => idFor('detail', key)),
        };
      });
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
  if (tabOn('requirements') && source.requirements) {
    const requirements = source.requirements;
    const tableOf = <F extends string>(
      scope: 'film' | 'sheet', all: readonly F[], shown: ReadonlyArray<F>, rows: ReadonlyArray<ClientScreenRowSource<F>>,
    ): ClientScreenTable | undefined => {
      // The manager's table has the column (said by the tab itself, so it holds for an empty table too), it is ticked, and it has values.
      const order = all.filter((field) => shown.includes(field) && isClientScreenCodeVisible(`requirements.${field}`, visible) && available(rows, field));
      if (order.length === 0) return undefined;
      return {
        columns: order.map((field) => ({
          code: `requirements.${field}` as ClientScreenCode, label: MATERIAL_COLUMN_LABELS[field] ?? field, align: RIGHT_ALIGNED.has(field) ? 'right' : 'left',
        })),
        // An empty string is a cell the tab leaves blank on purpose (the totals row), not a missing value.
        rows: rows.map((row) => ({ id: idFor(scope, row.key), cells: order.map((field) => (row.values[field] === '' ? '' : text(row.values[field]))) })),
      };
    };
    const films = tableOf('film', MATERIAL_FILM_FIELDS, requirements.filmColumns, requirements.films);
    const sheets = tableOf('sheet', MATERIAL_SHEET_FIELDS, requirements.sheetColumns, requirements.sheets);
    snapshot.requirements = { ...(films ? { films } : {}), ...(sheets ? { sheets } : {}) };
  }
  return snapshot;
}

/** Column headers of the two «Материалы» tables, as the manager's tab names them. */
const MATERIAL_COLUMN_LABELS: Readonly<Record<string, string>> = {
  film_name: 'Пленка',
  film_area: 'м²',
  film_details: 'Детали',
  film_meters: 'Пог. м',
  film_sheets: 'Листы',
  film_cut_jobs: 'Раскрои',
  film_stock: 'На складе, пог. м',
  film_coverage: 'Покрытие',
  sheet_name: 'Материал',
  sheet_area: 'Кол-во м²',
  sheet_details: 'Кол-во деталей',
  sheet_stock: 'На складе (1С)',
  sheet_coverage: 'Покрытие',
};

/** Groupings whose titles are taken from the cells of their rows. */
const TITLE_FROM_CELL: ReadonlySet<DetailField> = new Set<DetailField>(['cut_job', 'bath_cut_job']);

/** Header fields in the order of the manager's header; the number and the name make the title. */
const SUMMARY_ORDER = ['order_name', 'client', 'client_phone', 'client_phones', 'deadline', 'positions', 'parts', 'area', 'material', 'milling_type', 'edge_type', 'film',
  'final', 'discount', 'surcharge', 'paid', 'debt', 'order_status', 'payment_status', 'production_status', 'priority', 'designer', 'basis_project', 'project',
  'created_by'] as const;

/** «Заказ № …» by the number, else «Заказ …» by the name as in the manager's header — each only when ticked. */
function clientScreenTitle(source: ClientScreenOrderSource, visible: ReadonlySet<string>): { text: string; by: 'number' | 'name' | null } {
  if (visible.has('summary.number') && source.summary.number) return { text: `Заказ № ${source.summary.number}`, by: 'number' };
  if (visible.has('summary.order_name') && source.summary.order_name) return { text: `Заказ ${source.summary.order_name}`.slice(0, 200), by: 'name' };
  return { text: 'Ваш заказ', by: null };
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
    ...(snapshot.details?.rows ?? []), ...(snapshot.services?.rows ?? []), ...(snapshot.finance?.payments?.rows ?? []), ...(snapshot.hdf?.table?.rows ?? []),
    ...(snapshot.requirements?.films?.rows ?? []), ...(snapshot.requirements?.sheets?.rows ?? []),
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

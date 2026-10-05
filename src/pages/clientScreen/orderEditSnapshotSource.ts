import { CURRENCY_SYMBOL } from '../../config/currency';
import type { Order, OrderDetail, OrderDowelingLink, Payment } from '../../types/orders';
import { formatDate } from '../../utils/dateFormat';
import { formatNumber } from '../../utils/numberFormat';
import { calculateOrderTotalArea } from '../../utils/orderArea';
import { orderCatalogLineAmount, orderCatalogSubtotal, type OrderCatalogLine } from '../../utils/orderCatalogLines';
import { isOrderDetailPlaceholder } from '../../utils/orderDetailRows';
import type { ClientScreenOrderSource, ClientScreenValue, DetailField } from './buildClientScreenSnapshot';
import { CLIENT_SCREEN_TAB_KEYS, type ClientScreenTabKey } from './clientScreenSnapshotSchema';

/**
 * Turns the state of the order edit form into display text, the way the manager sees it on the
 * form: names instead of ids, the form's own date and number formats. Pure; the form passes what
 * it already has (draft state, loaded reference names, its tabs, column order and grouping).
 */
type NameOf = (id: number | null | undefined) => string | undefined;

export interface OrderEditSourceInput {
  header: Partial<Order>;
  details: readonly OrderDetail[];
  payments: readonly Payment[];
  catalogLines: readonly OrderCatalogLine[];
  dowelingLinks: readonly OrderDowelingLink[];
  /** Full order number shown in the page title; while it is not known the customer sees a generic title. */
  orderNumber: string | null;
  /** Tabs of the form in the manager's order with the manager's labels (all of them; unknown keys are ignored). */
  tabs: ReadonlyArray<{ key: string; label: string }>;
  names: {
    client: NameOf; orderStatus: NameOf; paymentStatus: NameOf; productionStatus: NameOf; employee: NameOf;
    sheetMaterial: NameOf; millingType: NameOf; edgeType: NameOf; film: NameOf; paymentType: NameOf;
  };
  /** Keys of the visible detail table columns in the manager's order (table column keys). */
  detailColumnOrder: readonly string[];
  /** Current grouping of the detail table, if any: the grouping field of detailGrouping.ts and its groups. */
  grouping: { field: string; groups: ReadonlyArray<{ key: string; label: string; rowKeys: ReadonlyArray<string | number> }> } | null;
  /** The services table shows prices only with orders.view_financials. */
  canViewServiceMoney: boolean;
  /**
   * Keys of the detail rows in the order of the manager's table (its sorting and grouping). Rows the
   * list does not name follow in the order of their numbers; without a list all rows do.
   */
  detailRowOrder?: readonly (string | number)[] | null;
  /**
   * The detail row whose editor is open, with editor values to show in place of the saved ones
   * (table column keys). An empty grid row being filled is shown as well: the customer sees a
   * detail appear the moment the manager starts it.
   */
  editingRow?: { rowKey: string | number; values: Partial<OrderDetail> } | null;
}

/** Detail table column key → registry field. Columns without an entry are never shown to the customer. */
export const DETAIL_COLUMN_FIELDS: Readonly<Record<string, DetailField>> = {
  detail_number: 'n', detail_name: 'name', height: 'height', width: 'width', quantity: 'quantity', area: 'area',
  sheet_material_type_id: 'material', milling_type_id: 'milling_type', edge_type_id: 'edge_type', film_id: 'film',
  milling_cost_per_sqm: 'price_per_sqm', detail_cost: 'cost', note: 'note', production_status_id: 'production_status',
};

/** Grouping field of the detail table → registry field. A grouping without an entry sends no group headers. */
export const GROUPING_FIELDS: Readonly<Record<string, DetailField>> = {
  detail_number: 'n', area: 'area', milling: 'milling_type', edge: 'edge_type', material: 'material', note: 'note',
  price: 'price_per_sqm', detail_cost: 'cost', film: 'film', production_status: 'production_status',
};

/** Money the manager does not have (undefined) stays unavailable; it is never turned into a zero. */
const money = (value: number | null | undefined): ClientScreenValue =>
  (value === undefined ? undefined : value === null ? null : `${formatNumber(Number(value) || 0, 2)} ${CURRENCY_SYMBOL}`);
const dateText = (value: Date | string | null | undefined): ClientScreenValue =>
  (value ? formatDate(typeof value === 'string' ? value : value.toISOString()) : null);
const named = (id: number | null | undefined, nameOf: NameOf): ClientScreenValue => (id === null || id === undefined ? null : nameOf(id) ?? null);
const size = (value: number | null | undefined): ClientScreenValue =>
  (value === null || value === undefined ? null : formatNumber(Number(value), Number(value) % 1 === 0 ? 0 : 2));
const amount = (value: number | null | undefined): ClientScreenValue =>
  (value === undefined ? undefined : value === null ? null : formatNumber(value, 2));
export const detailRowKey = (detail: OrderDetail): string => String(detail.temp_id ?? detail.detail_id ?? 0);

function detailValues(detail: OrderDetail, names: OrderEditSourceInput['names']): Record<DetailField, ClientScreenValue> {
  return {
    n: detail.detail_number === null || detail.detail_number === undefined ? null : String(detail.detail_number),
    name: detail.detail_name ?? null,
    height: size(detail.height),
    width: size(detail.width),
    quantity: detail.quantity === null || detail.quantity === undefined ? null : formatNumber(detail.quantity, 0),
    area: detail.area === null || detail.area === undefined ? null : `${formatNumber(detail.area, 2)} м²`,
    material: named(detail.sheet_material_type_id, names.sheetMaterial) ?? detail.material_name_resolved ?? null,
    milling_type: named(detail.milling_type_id, names.millingType),
    edge_type: named(detail.edge_type_id, names.edgeType),
    film: named(detail.film_id, names.film),
    // Money the manager does not have at all (undefined) stays unavailable; an empty price is null.
    price_per_sqm: amount(detail.milling_cost_per_sqm),
    cost: amount(detail.detail_cost),
    note: detail.note ?? null,
    production_status: named(detail.production_status_id, names.productionStatus),
  };
}

export function buildOrderEditSource(input: OrderEditSourceInput): ClientScreenOrderSource {
  const { header, names } = input;
  const editing = input.editingRow;
  const editingKey = editing ? String(editing.rowKey) : null;
  // Empty grid rows are not details; the one being filled right now is. The row being edited is
  // shown with the values of its editor, as the manager sees it.
  const business = orderedDetails(
    (input.details as OrderDetail[]).filter((detail) => !isOrderDetailPlaceholder(detail) || detailRowKey(detail) === editingKey),
    input.detailRowOrder,
  ).map((detail) => (editing && detailRowKey(detail) === editingKey ? { ...detail, ...editing.values } : detail));
  const partsCount = business.reduce((sum, detail) => sum + (Number(detail.quantity) || 0), 0);
  const totalArea = calculateOrderTotalArea(business);
  const totalPaid = input.payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const totalAmount = business.reduce((sum, detail) => sum + (Number(detail.detail_cost) || 0), 0) + orderCatalogSubtotal(input.catalogLines as OrderCatalogLine[]);
  // Same rules as the order summary on the form (OrderHeaderSummary).
  const finalAmount = Number(header.final_amount) || Number(header.total_amount) || totalAmount || 0;
  const paidAmount = Number(header.paid_amount) || totalPaid || 0;
  const remaining = Math.max(0, finalAmount - paidAmount);
  // The order total is known only if the manager has some amount to build it from.
  const totalKnown = header.final_amount !== undefined || header.total_amount !== undefined
    || business.some((detail) => detail.detail_cost !== undefined) || input.catalogLines.length > 0 && input.canViewServiceMoney;

  const doweling = input.dowelingLinks
    .map((link) => link.doweling_order?.doweling_order_name)
    .filter((name): name is string => Boolean(name));

  const columnOrder = input.detailColumnOrder.map((key) => DETAIL_COLUMN_FIELDS[key]).filter((field): field is DetailField => Boolean(field));
  const groupingField = input.grouping ? GROUPING_FIELDS[input.grouping.field] ?? null : null;

  return {
    tabs: input.tabs.filter((tab): tab is { key: ClientScreenTabKey; label: string } => (CLIENT_SCREEN_TAB_KEYS as readonly string[]).includes(tab.key)),
    summary: {
      // Only the order number: the order name is a separate field with its own tick.
      number: input.orderNumber || null,
      client: named(header.client_id, names.client),
      parts: `${formatNumber(partsCount, 0)}`,
      area: `${formatNumber(totalArea, 2)} м²`,
      final: totalKnown ? money(finalAmount) : undefined,
      debt: totalKnown ? money(remaining) : undefined,
    },
    basic: {
      client: named(header.client_id, names.client),
      order_name: header.order_name ?? null,
      order_date: dateText(header.order_date),
      order_status: named(header.order_status_id, names.orderStatus),
      payment_status: named(header.payment_status_id, names.paymentStatus),
      production_status: named(header.production_status_id, names.productionStatus),
      manager: named(header.manager_id, names.employee),
      priority: header.priority === null || header.priority === undefined ? null : formatNumber(header.priority, 0),
      doweling: doweling.length ? doweling.join(', ') : null,
      notes: header.notes ?? null,
    },
    dates: {
      planned: dateText(header.planned_completion_date),
      completion: dateText(header.completion_date),
      issue: dateText(header.issue_date),
    },
    finance: {
      total: money(header.total_amount),
      discount: money(header.discount),
      surcharge: money(header.surcharge),
      final: money(header.final_amount),
      paid: money(header.paid_amount),
      debt: header.final_amount === undefined || header.paid_amount === undefined
        ? undefined
        : money(Math.max(0, (Number(header.final_amount) || 0) - (Number(header.paid_amount) || 0))),
    },
    payments: input.payments.map((payment) => ({
      key: String(payment.temp_id ?? payment.payment_id ?? 0),
      values: {
        date: dateText(payment.payment_date),
        type: named(payment.type_paid_id, names.paymentType),
        amount: money(payment.amount),
        note: payment.notes ?? null,
      },
    })),
    details: {
      columnOrder,
      rows: business.map((detail) => ({ key: detailRowKey(detail), values: detailValues(detail, names) })),
      grouping: input.grouping
        ? {
          field: groupingField,
          groups: input.grouping.groups.map((group) => ({ key: group.key, title: group.label, rowKeys: group.rowKeys.map(String) })),
        }
        : null,
    },
    services: input.catalogLines.map((line) => ({
      key: line.id ? `id:${line.id}` : String(line.clientKey ?? ''),
      values: {
        name: line.name,
        quantity: line.unitName ? `${line.quantity} ${line.unitName}` : line.quantity,
        // Without the right to see prices the manager's table has no price columns: nothing to send.
        price: input.canViewServiceMoney ? serviceMoney(line.unitPrice) : undefined,
        sum: input.canViewServiceMoney ? serviceMoney(orderCatalogLineAmount(line.quantity, line.unitPrice)) : undefined,
      },
    })),
  };
}

/** The manager's table order; rows it does not name go after, by number (the table's own default). */
function orderedDetails(details: OrderDetail[], order: OrderEditSourceInput['detailRowOrder']): OrderDetail[] {
  const position = new Map<string, number>((order ?? []).map((key, index) => [String(key), index]));
  return details
    .map((detail, index) => ({ detail, index, at: position.get(detailRowKey(detail)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.at === b.at ? (Number(a.detail.detail_number) || 0) - (Number(b.detail.detail_number) || 0) || a.index - b.index : a.at < b.at ? -1 : 1))
    .map((item) => item.detail);
}

const NUMERIC_EDITOR_KEYS = new Set(['height', 'width', 'quantity', 'area', 'milling_cost_per_sqm', 'detail_cost',
  'sheet_material_type_id', 'milling_type_id', 'edge_type_id', 'film_id', 'production_status_id']);

/**
 * Display text of the row being edited, from the current values of its editor: one item per visible
 * table column the customer screen knows. What the customer may see of it is decided later, by the
 * same settings as the data.
 */
export function orderEditEditingValues(
  detail: OrderDetail,
  editorValues: Readonly<Record<string, unknown>>,
  names: OrderEditSourceInput['names'],
  columnKeys: readonly string[],
): Array<{ code: `details.${DetailField}`; value: string }> {
  const merged: Record<string, unknown> = { ...detail };
  for (const key of Object.keys(DETAIL_COLUMN_FIELDS)) {
    const value = editorValues[key];
    if (value === undefined || key === 'detail_number') continue;
    if (!NUMERIC_EDITOR_KEYS.has(key)) merged[key] = value === null ? null : String(value);
    else if (value === null || value === '') merged[key] = null;
    else if (Number.isFinite(Number(value))) merged[key] = Number(value);
  }
  const display = detailValues(merged as unknown as OrderDetail, names);
  const result: Array<{ code: `details.${DetailField}`; value: string }> = [];
  for (const key of columnKeys) {
    const field = DETAIL_COLUMN_FIELDS[key];
    const value = field ? display[field] : undefined;
    if (!field || value === undefined || result.some((item) => item.code === `details.${field}`)) continue;
    result.push({ code: `details.${field}`, value: value === null || value === '' ? '—' : value.slice(0, 2000) });
  }
  return result;
}

function serviceMoney(value: string | null | undefined): ClientScreenValue {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
}

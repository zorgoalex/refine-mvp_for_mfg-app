import { CURRENCY_SYMBOL } from '../../config/currency';
import type { Order, OrderDetail, OrderDowelingLink, OrderHdfDetail, Payment } from '../../types/orders';
import { formatDate } from '../../utils/dateFormat';
import { formatNumber } from '../../utils/numberFormat';
import { calculateOrderTotalArea } from '../../utils/orderArea';
import { orderCatalogLineAmount, orderCatalogSubtotal, type OrderCatalogLine } from '../../utils/orderCatalogLines';
import { resolveHeaderMaterialName } from '../../utils/materialDisplayName';
import { resolveOrderBasisProject } from '../../utils/orderBasisProject';
import { isOrderDetailPlaceholder } from '../../utils/orderDetailRows';
import { collectOrderBasisProjects } from '../orders/components/sections/orderBasisProjects';
import { formatBazisCutSetsGroupLabel, formatCutJobGroupLabel } from '../orders/detailGrouping';
import { buildOrderHeaderMaterialSummaryItems } from '../orders/orderMaterialsSummary';
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
  /**
   * Contact data of the order's client, already formatted. A value that is not loaded (or that the
   * manager may not see) is undefined and is not sent; a client without it has null.
   */
  clientContacts?: ClientScreenClientContacts | null;
  /** HDF details of the order: the header's material line names them with their area. */
  hdfDetails?: readonly OrderHdfDetail[];
  /** Full order number shown in the page title; while it is not known the customer sees a generic title. */
  orderNumber: string | null;
  /** Tabs of the form in the manager's order with the manager's labels (all of them; unknown keys are ignored). */
  tabs: ReadonlyArray<{ key: string; label: string }>;
  names: {
    client: NameOf; orderStatus: NameOf; paymentStatus: NameOf; productionStatus: NameOf; employee: NameOf;
    sheetMaterial: NameOf; millingType: NameOf; edgeType: NameOf; film: NameOf; paymentType: NameOf;
  };
  /** Labels of the cut jobs the detail table shows for a row, when the table is on screen. */
  cutJobLabelsOf?: ((rowKey: string) => { cut_job: string | null; bath_cut_job: string | null } | null) | null;
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

export interface ClientScreenClientContacts {
  /** The primary phone (or the first one). */
  phone: string | null | undefined;
  /** The other phones, comma separated. */
  otherPhones: string | null | undefined;
}

/** Phone number the way the order header shows it: "8 xxx xxx xxxx". */
export function clientScreenPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) return `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  if (digits.length === 10) return `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
  return phone;
}

/**
 * The loaded phone rows that belong to this client. A list that holds a phone of another client is
 * a stale answer (the client of the order was just changed): it is treated as not loaded.
 */
export function clientScreenPhonesOf<T extends { client_id?: unknown }>(
  clientId: number | null | undefined,
  rows: readonly T[] | null | undefined,
): readonly T[] | undefined {
  if (clientId === null || clientId === undefined || !rows) return undefined;
  return rows.every((row) => Number(row.client_id) === Number(clientId)) ? rows : undefined;
}

/** Phones of one client as the customer screen shows them; `undefined` while they are not loaded. */
export function clientScreenClientContacts(
  phones: ReadonlyArray<{ phone_number?: string | null; is_primary?: boolean | null }> | null | undefined,
): ClientScreenClientContacts {
  if (!phones) return { phone: undefined, otherPhones: undefined };
  const numbers = phones.filter((item) => typeof item.phone_number === 'string' && item.phone_number.trim() !== '');
  const primary = numbers.find((item) => item.is_primary) ?? numbers[0];
  const others = numbers.filter((item) => item !== primary).map((item) => clientScreenPhone(item.phone_number as string));
  return {
    phone: primary ? clientScreenPhone(primary.phone_number as string) : null,
    otherPhones: others.length ? others.join(', ') : null,
  };
}

/** Detail table column key → registry field. Columns without an entry are never shown to the customer. */
export const DETAIL_COLUMN_FIELDS: Readonly<Record<string, DetailField>> = {
  detail_number: 'n', detail_name: 'name', height: 'height', width: 'width', quantity: 'quantity', area: 'area',
  sheet_material_type_id: 'material', milling_type_id: 'milling_type', edge_type_id: 'edge_type', film_id: 'film',
  milling_cost_per_sqm: 'price_per_sqm', detail_cost: 'cost', note: 'note', production_status_id: 'production_status',
  hdf_parameter_override_mm: 'hdf_parameter', doweling: 'doweling', cut_job: 'cut_job', bath_cut_job: 'bath_cut_job', bazis_cut_sets: 'bazis_cut_sets',
  priority: 'priority', basis_project: 'basis_project', basis_product: 'basis_product', basis_data: 'basis_data', basis_designation: 'basis_designation',
};

/** Grouping field of the detail table → registry field. A grouping without an entry sends no group headers. */
export const GROUPING_FIELDS: Readonly<Record<string, DetailField>> = {
  detail_number: 'n', area: 'area', milling: 'milling_type', edge: 'edge_type', material: 'material', note: 'note',
  price: 'price_per_sqm', detail_cost: 'cost', film: 'film', production_status: 'production_status',
  hdf_parameter: 'hdf_parameter', doweling: 'doweling', cut_job: 'cut_job', bath_cut_job: 'bath_cut_job', basis_project: 'basis_project',
  bazis_cut_sets: 'bazis_cut_sets',
};

/** Money the manager does not have (undefined) stays unavailable; it is never turned into a zero. */
export const clientScreenMoney = (value: number | null | undefined): ClientScreenValue =>
  (value === undefined ? undefined : value === null ? null : `${formatNumber(Number(value) || 0, 2)} ${CURRENCY_SYMBOL}`);
export const clientScreenDate = (value: Date | string | null | undefined): ClientScreenValue =>
  (value ? formatDate(typeof value === 'string' ? value : value.toISOString()) : null);
const named = (id: number | null | undefined, nameOf: NameOf): ClientScreenValue => (id === null || id === undefined ? null : nameOf(id) ?? null);
const size = (value: number | null | undefined): ClientScreenValue =>
  (value === null || value === undefined ? null : formatNumber(Number(value), Number(value) % 1 === 0 ? 0 : 2));
const amount = (value: number | null | undefined): ClientScreenValue =>
  (value === undefined ? undefined : value === null ? null : formatNumber(value, 2));
export const detailRowKey = (detail: OrderDetail): string => String(detail.temp_id ?? detail.detail_id ?? 0);

/** One detail as display text: names instead of ids, the formats of the order screens. */
const dashless = (label: string): ClientScreenValue => (label === '' || label === '—' ? null : label);
const plain = (value: unknown): ClientScreenValue => (typeof value === 'string' && value.trim() !== '' ? value : null);

export function orderDetailDisplayValues(
  detail: OrderDetail,
  names: Pick<OrderEditSourceInput['names'], 'sheetMaterial' | 'millingType' | 'edgeType' | 'film' | 'productionStatus'>,
  /** Cut job labels as the table shows them; without them the detail's own references are used. */
  cutJobs?: { cut_job: string | null; bath_cut_job: string | null } | null,
): Record<DetailField, ClientScreenValue> {
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
    hdf_parameter: detail.hdf_parameter_override_mm === null || detail.hdf_parameter_override_mm === undefined
      ? null
      : formatNumber(Number(detail.hdf_parameter_override_mm), 2),
    doweling: detail.doweling === true ? 'Да' : null,
    cut_job: cutJobs ? cutJobs.cut_job : dashless(formatCutJobGroupLabel(detail.cut_job ?? undefined)),
    bath_cut_job: cutJobs ? cutJobs.bath_cut_job : dashless(formatCutJobGroupLabel(detail.bath_cut_job ?? undefined)),
    bazis_cut_sets: dashless(formatBazisCutSetsGroupLabel(detail.bazis_cut_sets)),
    priority: detail.priority === null || detail.priority === undefined ? null : formatNumber(Number(detail.priority), 0),
    basis_project: plain(resolveOrderBasisProject(detail as never).name),
    basis_product: plain(detail.basis_product),
    basis_data: plain(detail.basis_data),
    basis_designation: plain(detail.basis_designation),
  };
}

/**
 * The basis project and the designer lines of the order header, by the manager's header rule: the
 * basis projects of the details, else the name of the latest doweling order; the designer is named
 * only when there is no basis project — of the latest doweling order, else the order's own.
 */
export function clientScreenHeaderPeople(input: {
  details: ReadonlyArray<Readonly<Record<string, unknown>>>;
  dowelingLinks: ReadonlyArray<{ doweling_order?: { doweling_order_name?: string | null; design_engineer_id?: number | null } | null }>;
  header: { doweling_order_name?: string | null; design_engineer_id?: number | null };
  employeeName: (id: number) => string | undefined;
}): { basis_project: ClientScreenValue; designer: ClientScreenValue } {
  const basisProjects = collectOrderBasisProjects(input.details as never);
  const latest = input.dowelingLinks.length ? input.dowelingLinks[input.dowelingLinks.length - 1] : null;
  const fallback = plain(latest?.doweling_order?.doweling_order_name) ?? plain(input.header.doweling_order_name);
  const designerId = basisProjects.length > 0
    ? null
    : latest ? latest.doweling_order?.design_engineer_id ?? null : input.header.design_engineer_id ?? null;
  return {
    basis_project: basisProjects.length > 0 ? basisProjects.join(', ') : fallback,
    designer: designerId === null || designerId === undefined ? null : input.employeeName(Number(designerId)) ?? null,
  };
}

/**
 * The lines of the order header that come from the details, as the manager's header shows them:
 * how many positions, the materials (with HDF and its area; the order's own material when no detail
 * names one), and the milling, edge and film when
 * every detail has the same one («—» otherwise).
 */
export function clientScreenHeaderFromDetails(
  rows: ReadonlyArray<Partial<Record<DetailField, ClientScreenValue>>>,
  hdfDetails: readonly OrderHdfDetail[] | null | undefined,
  /** The order's own material: named when no detail names one, as in the manager's header. */
  headerMaterial?: string | null,
): { positions: string; material: ClientScreenValue; milling_type: ClientScreenValue; edge_type: ClientScreenValue; film: ClientScreenValue } {
  const distinct = (field: DetailField): string[] =>
    Array.from(new Set(rows.map((row) => row[field]).filter((value): value is string => typeof value === 'string' && value !== '')));
  const common = (field: DetailField): ClientScreenValue => {
    const values = distinct(field);
    return values.length === 1 ? values[0] : null;
  };
  const detailMaterials = distinct('material');
  const materialNames = detailMaterials.length > 0 ? detailMaterials : headerMaterial ? [headerMaterial] : [];
  const materials = buildOrderHeaderMaterialSummaryItems(materialNames, (hdfDetails ?? []) as OrderHdfDetail[]).map((item) => item.label);
  return {
    positions: formatNumber(rows.length, 0),
    material: materials.length ? materials.join(', ') : null,
    milling_type: common('milling_type'),
    edge_type: common('edge_type'),
    film: common('film'),
  };
}

/** A discount or surcharge is a header line only when there is one, as in the manager's header. */
export const clientScreenExtraMoney = (value: unknown, allowed: boolean): ClientScreenValue =>
  (allowed && Number(value) > 0 ? clientScreenMoney(Number(value)) : undefined);

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

  const detailRows = business.map((detail) => {
    const key = detailRowKey(detail);
    return { key, values: orderDetailDisplayValues(detail, names, input.cutJobLabelsOf?.(key)) };
  });
  return {
    tabs: input.tabs.filter((tab): tab is { key: ClientScreenTabKey; label: string } => (CLIENT_SCREEN_TAB_KEYS as readonly string[]).includes(tab.key)),
    summary: {
      // The number and the name are separate fields, each with its own tick; either can make the title.
      number: input.orderNumber || null,
      order_name: header.order_name ?? null,
      client: named(header.client_id, names.client),
      client_phone: input.clientContacts?.phone,
      client_phones: input.clientContacts?.otherPhones,
      deadline: clientScreenDate(header.planned_completion_date),
      ...clientScreenHeaderFromDetails(detailRows.map((row) => row.values), input.hdfDetails, resolveHeaderMaterialName(header as never)),
      parts: `${formatNumber(partsCount, 0)}`,
      area: `${formatNumber(totalArea, 2)} м²`,
      final: totalKnown ? clientScreenMoney(finalAmount) : undefined,
      discount: clientScreenExtraMoney(header.discount, totalKnown),
      surcharge: clientScreenExtraMoney(header.surcharge, totalKnown),
      paid: totalKnown ? clientScreenMoney(paidAmount) : undefined,
      debt: totalKnown ? clientScreenMoney(remaining) : undefined,
      order_status: named(header.order_status_id, names.orderStatus),
      payment_status: named(header.payment_status_id, names.paymentStatus),
      production_status: named(header.production_status_id, names.productionStatus),
      priority: header.priority === null || header.priority === undefined ? null : formatNumber(header.priority, 0),
      ...clientScreenHeaderPeople({
        details: business as never, dowelingLinks: input.dowelingLinks as never, header: header as never,
        employeeName: (id) => names.employee(id),
      }),
      // The edit form's header shows neither the project nor who created the order.
      project: undefined,
      created_by: undefined,
    },
    basic: {
      client: named(header.client_id, names.client),
      order_name: header.order_name ?? null,
      order_date: clientScreenDate(header.order_date),
      order_status: named(header.order_status_id, names.orderStatus),
      payment_status: named(header.payment_status_id, names.paymentStatus),
      production_status: named(header.production_status_id, names.productionStatus),
      manager: named(header.manager_id, names.employee),
      priority: header.priority === null || header.priority === undefined ? null : formatNumber(header.priority, 0),
      doweling: doweling.length ? doweling.join(', ') : null,
      notes: header.notes ?? null,
    },
    dates: {
      planned: clientScreenDate(header.planned_completion_date),
      completion: clientScreenDate(header.completion_date),
      issue: clientScreenDate(header.issue_date),
    },
    finance: {
      total: clientScreenMoney(header.total_amount),
      discount: clientScreenMoney(header.discount),
      surcharge: clientScreenMoney(header.surcharge),
      final: clientScreenMoney(header.final_amount),
      paid: clientScreenMoney(header.paid_amount),
      debt: header.final_amount === undefined || header.paid_amount === undefined
        ? undefined
        : clientScreenMoney(Math.max(0, (Number(header.final_amount) || 0) - (Number(header.paid_amount) || 0))),
    },
    payments: input.payments.map((payment) => ({
      key: String(payment.temp_id ?? payment.payment_id ?? 0),
      values: {
        date: clientScreenDate(payment.payment_date),
        type: named(payment.type_paid_id, names.paymentType),
        amount: clientScreenMoney(payment.amount),
        note: payment.notes ?? null,
      },
    })),
    details: {
      columnOrder,
      rows: detailRows,
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
/** Money the manager may not have at all: an editor without a value for it does not make it "empty". */
const MONEY_EDITOR_KEYS = new Set(['milling_cost_per_sqm', 'detail_cost']);

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
  // Cells the table fills from its own knowledge (the last ready cut job) are not the editor's:
  // the snapshot already has them as the table shows them.
  const TABLE_OWNED = new Set<DetailField>(['cut_job', 'bath_cut_job']);
  const merged: Record<string, unknown> = { ...detail };
  for (const key of Object.keys(DETAIL_COLUMN_FIELDS)) {
    // A field the editor does not have keeps its saved value. A field the editor has without a
    // value was cleared by the manager (a cleared select holds `undefined`): it is empty.
    if (key === 'detail_number' || !Object.prototype.hasOwnProperty.call(editorValues, key)) continue;
    const value = editorValues[key];
    if (value === undefined) {
      if (!MONEY_EDITOR_KEYS.has(key) || merged[key] !== undefined) merged[key] = null;
    } else if (!NUMERIC_EDITOR_KEYS.has(key)) merged[key] = value === null ? null : String(value);
    else if (value === null || value === '') merged[key] = null;
    else if (Number.isFinite(Number(value))) merged[key] = Number(value);
  }
  // The saved material name belongs to the saved material only.
  if (merged.sheet_material_type_id !== detail.sheet_material_type_id) merged.material_name_resolved = null;
  const display = orderDetailDisplayValues(merged as unknown as OrderDetail, names);
  const result: Array<{ code: `details.${DetailField}`; value: string }> = [];
  for (const key of columnKeys) {
    const field = DETAIL_COLUMN_FIELDS[key];
    const value = field ? display[field] : undefined;
    if (!field || TABLE_OWNED.has(field) || value === undefined || result.some((item) => item.code === `details.${field}`)) continue;
    result.push({ code: `details.${field}`, value: value === null || value === '' ? '—' : value.slice(0, 2000) });
  }
  return result;
}

function serviceMoney(value: string | null | undefined): ClientScreenValue {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
}

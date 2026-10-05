import type { OrderDetail } from '../../types/orders';
import { formatNumber } from '../../utils/numberFormat';
import { calculateOrderTotalArea } from '../../utils/orderArea';
import type { ClientScreenOrderSource, ClientScreenValue, DetailField } from './buildClientScreenSnapshot';
import type { ClientScreenTabKey } from './clientScreenSnapshotSchema';
import { orderDetailMirrorRows } from './orderDetailTableMirror';
import { clientScreenDate, clientScreenMoney, GROUPING_FIELDS, orderDetailDisplayValues } from './orderEditSnapshotSource';

/**
 * Turns what the order VIEW page has loaded into the same display source the edit form gives: names
 * instead of ids, the page's own formats. Pure. The view page shows the detail table all the time
 * and the finance panel on demand, so the customer gets those two tabs.
 */
type Names = ReadonlyMap<number, string>;

export interface OrderShowSourceInput {
  /** The order record of the view page (names are already in it). */
  record: Readonly<Record<string, unknown>>;
  clientName: string | null | undefined;
  /** Details in the order on screen (the page's own sorting). */
  details: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** The page's grouped data source while grouping is on (separators and details), otherwise null. */
  groupedRows: ReadonlyArray<unknown> | null;
  groupField: string | null;
  /** The page's title of a group, by one of its details (for a first group drawn without a separator). */
  groupLabelOf?: (detail: Readonly<Record<string, unknown>>) => string;
  /** Keys of the visible detail table columns, left to right (the view page's column keys). */
  columnKeys: readonly string[];
  payments: ReadonlyArray<Readonly<Record<string, unknown>>>;
  names: {
    millingType: Names; edgeType: Names; film: Names; paymentType: Names;
    productionStatus: (id: number) => string | undefined;
    /** The material name the page shows for a detail. */
    materialOf: (detail: Readonly<Record<string, unknown>>) => string | null | undefined;
  };
  /** Without it the page shows no money at all: nothing of it is passed on. */
  canViewFinancials: boolean;
}

/** View page column key → registry field. Columns without an entry are never shown to the customer. */
export const SHOW_DETAIL_COLUMN_FIELDS: Readonly<Record<string, DetailField>> = {
  detail_number: 'n', detail_name: 'name', height: 'height', width: 'width', quantity: 'quantity', area: 'area',
  material: 'material', milling_type: 'milling_type', edge_type: 'edge_type', film: 'film',
  milling_cost_per_sqm: 'price_per_sqm', detail_cost: 'cost', note: 'note', production_status_id: 'production_status',
};

const SHOW_TABS: ReadonlyArray<{ key: ClientScreenTabKey; label: string }> = [
  { key: 'details', label: 'Детали заказа' },
  { key: 'finance', label: 'Финансы' },
];

/** The view page's panel as a customer tab: the finance panel, otherwise the detail table. */
export function orderShowMirroredTab(activeInfoPanel: string | null | undefined, canViewFinancials: boolean): ClientScreenTabKey {
  return activeInfoPanel === 'finance' && canViewFinancials ? 'finance' : 'details';
}

const numberOrNull = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const idOf = (value: unknown): number | null => {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
};
export const orderShowDetailKey = (detail: Readonly<Record<string, unknown>>): string => String(detail.temp_id ?? detail.detail_id ?? 0);

export function buildOrderShowSource(input: OrderShowSourceInput): ClientScreenOrderSource {
  const { record, names } = input;
  const money = (value: unknown): ClientScreenValue => (input.canViewFinancials ? clientScreenMoney(numberOrNull(value)) : undefined);
  // The name the page itself falls back to when its reference list has no entry for the id.
  const nameOf = (map: Names, idKey: string, nameKey: string) => {
    const extra = new Map<number, string>();
    for (const detail of input.details) {
      const id = idOf(detail[idKey]);
      const text = textOrNull(detail[nameKey]);
      if (id !== null && text) extra.set(id, text);
    }
    return (id: number | null | undefined) => (id === null || id === undefined ? undefined : map.get(Number(id)) ?? extra.get(Number(id)));
  };
  const detailNames = {
    sheetMaterial: () => undefined,
    millingType: nameOf(names.millingType, 'milling_type_id', 'milling_type_name'),
    edgeType: nameOf(names.edgeType, 'edge_type_id', 'edge_type_name'),
    film: nameOf(names.film, 'film_id', 'film_name'),
    productionStatus: (id: number | null | undefined) => (id === null || id === undefined ? undefined : names.productionStatus(Number(id))),
  };
  const asDetail = (detail: Readonly<Record<string, unknown>>): OrderDetail => ({
    ...detail,
    // The material is whatever name the page resolved; ids of the material never matter here.
    sheet_material_type_id: null,
    material_name_resolved: names.materialOf(detail) ?? null,
    milling_type_id: idOf(detail.milling_type_id), edge_type_id: idOf(detail.edge_type_id), film_id: idOf(detail.film_id),
    production_status_id: idOf(detail.production_status_id),
    milling_cost_per_sqm: input.canViewFinancials ? numberOrNull(detail.milling_cost_per_sqm) : undefined,
    detail_cost: input.canViewFinancials ? numberOrNull(detail.detail_cost) : undefined,
  }) as unknown as OrderDetail;

  const details = input.details.map(asDetail);
  const partsCount = details.reduce((sum, detail) => sum + (Number(detail.quantity) || 0), 0);
  const finalAmount = Number(record.final_amount) || Number(record.total_amount) || 0;
  const paidAmount = Number(record.paid_amount) || 0;
  const totalKnown = input.canViewFinancials && (record.final_amount !== undefined || record.total_amount !== undefined);

  const grouped = input.groupedRows && input.groupField
    ? orderDetailMirrorRows<Readonly<Record<string, unknown>>>(input.groupedRows as never[], {
      groupField: input.groupField, keyOf: orderShowDetailKey, labelOf: (detail) => input.groupLabelOf?.(detail) ?? '',
    }).grouping
    : null;

  const columnOrder = input.columnKeys.map((key) => SHOW_DETAIL_COLUMN_FIELDS[key]).filter((field): field is DetailField => Boolean(field));
  const client = textOrNull(input.clientName) ?? textOrNull(record.client_name);

  return {
    tabs: SHOW_TABS.filter((tab) => tab.key !== 'finance' || input.canViewFinancials),
    summary: {
      // The view page has no full order number; the order name is never used in its place.
      number: null,
      client,
      parts: formatNumber(partsCount, 0),
      area: `${formatNumber(calculateOrderTotalArea(details), 2)} м²`,
      final: totalKnown ? money(finalAmount) : undefined,
      debt: totalKnown ? money(Math.max(0, finalAmount - paidAmount)) : undefined,
    },
    // The view page has no such tabs; nothing of them is sent.
    basic: {},
    dates: {},
    finance: {
      total: money(record.total_amount),
      discount: money(record.discount),
      surcharge: money(record.surcharge),
      final: money(record.final_amount),
      paid: money(record.paid_amount),
      debt: !input.canViewFinancials || record.final_amount === undefined || record.paid_amount === undefined
        ? undefined
        : money(Math.max(0, (Number(record.final_amount) || 0) - (Number(record.paid_amount) || 0))),
    },
    payments: input.canViewFinancials
      ? input.payments.map((payment) => ({
        key: String(payment.temp_id ?? payment.payment_id ?? 0),
        values: {
          date: clientScreenDate(payment.payment_date as string | null | undefined),
          type: idOf(payment.type_paid_id) === null ? null : names.paymentType.get(idOf(payment.type_paid_id) as number) ?? null,
          amount: money(payment.amount),
          note: textOrNull(payment.notes),
        },
      }))
      : [],
    details: {
      columnOrder,
      rows: details.map((detail, index) => ({ key: orderShowDetailKey(input.details[index]), values: orderDetailDisplayValues(detail, detailNames) })),
      grouping: grouped
        ? {
          field: GROUPING_FIELDS[grouped.field] ?? null,
          groups: grouped.groups.map((group) => ({ key: group.key, title: group.label, rowKeys: [...group.rowKeys] })),
        }
        : null,
    },
    services: [],
  };
}

import type {
  ProcurementHistoryEventDto,
  ProcurementHistoryEventKind,
  ProcurementHistoryRequestLinkDto,
} from '../application/procurement-history.types';

/** Строка заявки по заказу строки заявки — номер заявки и единица строки (для вложенных связей). */
export type LineOrderRefs = ReadonlyMap<number, { number: string | null; unit: string | null }>;

/** События журнала, из которых собирается история закупа (§5.6). Отказы по правам (denied) не показываются. */
export const PROCUREMENT_HISTORY_EVENTS: Readonly<Record<string, ProcurementHistoryEventKind>> = {
  'order_resource.procurement_marked': 'marked',
  'order_resource.procurement_unmarked': 'unmarked',
  'order_resource.onec_allocation_added': 'allocation_added',
  'order_resource.onec_allocation_removed': 'allocation_removed',
  'order_resource.onec_allocation_linked_to_request': 'allocation_linked',
  'order_resource.onec_allocation_unlinked_from_request': 'allocation_unlinked',
  'procurement.supplier_request_created': 'request_created',
  'procurement.supplier_request_updated': 'request_updated',
  'procurement.supplier_request_sent': 'request_sent',
  'procurement.supplier_request_closed': 'request_closed',
  'procurement.supplier_request_cancelled': 'request_cancelled',
};

export const ORDER_RESOURCE_HISTORY_EVENTS = Object.keys(PROCUREMENT_HISTORY_EVENTS).filter((event) => event.startsWith('order_resource.'));
export const SUPPLIER_REQUEST_HISTORY_EVENTS = Object.keys(PROCUREMENT_HISTORY_EVENTS).filter((event) => event.startsWith('procurement.'));

export interface ProcurementHistoryRow {
  audit_id: string;
  created_at: Date | string;
  /** created_at с микросекундами (UTC) — для курсора: Date в JS теряет микросекунды. */
  cursor_at: string;
  event: string;
  actor_name: string | null;
  metadata_json: Record<string, unknown> | null;
  diff_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  allocation_unit: string | null;
  link_unit: string | null;
  doc_id: string | number | null;
  doc_kind: string | null;
  doc_number: string | null;
  doc_date: Date | string | null;
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const asString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const toIso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const toDate = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
};

/** Значение «стало» из diff_json `{ field: { from, to } }`. */
function diffTo(diff: Json | null, field: string): unknown {
  return asObject(diff?.[field])?.to;
}

/**
 * Количество этого заказа в строке заявки этого материала по снимку «после» (§5.6). Количества других заказов
 * заявки не раскрываются; заказ, убранный из заявки, — null.
 */
function requestOrderQuantity(after: Json | null, orderId: number, resourceKey: string): { quantity: number | null; unit: string | null } {
  const lines = Array.isArray(after?.lines) ? after!.lines as unknown[] : [];
  for (const raw of lines) {
    const line = asObject(raw);
    if (!line || line.resourceKey !== resourceKey) continue;
    const orders = Array.isArray(line.orders) ? line.orders as unknown[] : [];
    const order = orders.map(asObject).find((entry) => entry !== null && asNumber(entry.orderId) === orderId);
    if (order) return { quantity: asNumber(order.quantity), unit: asString(line.unit) };
  }
  return { quantity: null, unit: null };
}

/**
 * Строка журнала → событие истории. Только белый список полей: никаких других заказов заявки, сумма оплаты —
 * только с finance.view (вместе с валютой).
 */
export function mapHistoryRow(
  row: ProcurementHistoryRow,
  context: { orderId: number; resourceKey: string; canSeeAmounts: boolean; lineOrders?: LineOrderRefs },
): ProcurementHistoryEventDto | null {
  const kind = PROCUREMENT_HISTORY_EVENTS[row.event];
  if (!kind) return null;
  const meta = asObject(row.metadata_json) ?? {};
  const diff = asObject(row.diff_json);
  const docId = asNumber(row.doc_id);
  const event: ProcurementHistoryEventDto = {
    id: row.audit_id,
    at: toIso(row.created_at),
    kind,
    actorName: row.actor_name,
    origin: null,
    role: null,
    quantity: null,
    unit: null,
    amount: null,
    currency: null,
    markedPurchased: false,
    document: docId === null ? null : { documentId: docId, docKind: row.doc_kind, number: row.doc_number, date: toDate(row.doc_date) },
    request: null,
    requestLinks: [],
  };
  const role = meta.role === 'receipt' || meta.role === 'payment' ? meta.role : null;
  const requestId = asNumber(meta.supplierRequestId);
  if (requestId !== null) event.request = { supplierRequestId: requestId, number: asString(meta.requestNumber) };

  switch (kind) {
    case 'marked':
      event.origin = asString(diffTo(diff, 'origin'));
      event.quantity = asNumber(diffTo(diff, 'quantityAtMark'));
      event.unit = asString(diffTo(diff, 'unitAtMark'));
      break;
    case 'unmarked':
      break;
    case 'allocation_added':
    case 'allocation_removed':
      event.role = role;
      if (role === 'receipt') {
        event.quantity = asNumber(meta.quantity);
        event.unit = row.allocation_unit;
      } else if (role === 'payment' && context.canSeeAmounts) {
        event.amount = asNumber(meta.amount);
        // Только снимок валюты операции (CR1-1): текущая валюта документа могла смениться после снятия распределения.
        event.currency = event.amount === null ? null : asString(meta.currency);
      }
      event.markedPurchased = kind === 'allocation_added' && diffTo(diff, 'purchased') === true;
      event.requestLinks = [
        ...nestedLinks(meta.requestLinks, 'linked', role, context.lineOrders),
        ...nestedLinks(meta.removedRequestLinks, 'unlinked', role, context.lineOrders),
      ];
      break;
    case 'allocation_linked':
    case 'allocation_unlinked': {
      event.role = role;
      // Связь прихода — количество в единице строки заявки; сумм оплат в журнале нет (R1 ф.3б-2).
      const link = asObject(diffTo(diff, 'link')) ?? asObject(asObject(diff?.link)?.from);
      if (role === 'receipt') {
        event.quantity = asNumber(link?.quantity);
        event.unit = event.quantity === null ? null : row.link_unit;
      }
      break;
    }
    default: {
      const { quantity, unit } = requestOrderQuantity(asObject(row.after_json), context.orderId, context.resourceKey);
      event.quantity = quantity;
      event.unit = unit;
    }
  }
  return event;
}

/** Идентификаторы заказов строк заявок во вложенных связях распределений — для одного запроса номеров и единиц. */
export function nestedLineOrderIds(rows: readonly ProcurementHistoryRow[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    const meta = asObject(row.metadata_json);
    for (const field of ['requestLinks', 'removedRequestLinks']) {
      const list = Array.isArray(meta?.[field]) ? meta![field] as unknown[] : [];
      for (const raw of list) {
        const id = asNumber(asObject(raw)?.lineOrderId);
        if (id !== null) ids.add(id);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function nestedLinks(
  value: unknown,
  action: 'linked' | 'unlinked',
  role: 'receipt' | 'payment' | null,
  lineOrders: LineOrderRefs | undefined,
): ProcurementHistoryRequestLinkDto[] {
  const list = Array.isArray(value) ? value : [];
  const links: ProcurementHistoryRequestLinkDto[] = [];
  for (const raw of list) {
    const link = asObject(raw);
    const supplierRequestId = asNumber(link?.supplierRequestId);
    if (!link || supplierRequestId === null) continue;
    const refs = lineOrders?.get(asNumber(link.lineOrderId) ?? -1);
    const quantity = role === 'receipt' ? asNumber(link.quantity) : null;
    links.push({ action, supplierRequestId, number: refs?.number ?? null, quantity, unit: quantity === null ? null : refs?.unit ?? null });
  }
  return links;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Момент курсора — ровно формат, который отдаёт SQL (`…T…Z` с микросекундами). */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Курсор страницы: момент и audit_id последнего события (порядок created_at DESC, audit_id DESC). */
export function encodeHistoryCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

export function decodeHistoryCursor(value: string): { at: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed;
    if (typeof at !== 'string' || typeof id !== 'string') return null;
    // Год 0000 JavaScript принимает, PostgreSQL — нет (CR3-1).
    if (!CURSOR_AT.test(at) || at.startsWith('0000') || !UUID.test(id)) return null;
    // Календарная дата — до SQL (CR2-2): Date.parse нормализует 30 февраля в март, PostgreSQL такую строку отклонит.
    const time = Date.parse(at);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== at.slice(0, 19)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

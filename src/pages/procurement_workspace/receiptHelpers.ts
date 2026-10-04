import type {
  OnecAllocationState,
  OnecDocumentCardDto,
  OnecDocumentLineSummaryDto,
  OnecDocumentListItemDto,
  OnecDocumentListParams,
} from '../../api/types/onecDocumentsApi.types';
import type { ProcurementWorklistLine } from '../../api/types/procurementWorkspaceApi.types';
import { WORKLIST_URL_KEYS } from './worklistHelpers';

/** Фильтр списка приходов: не распределённые (в т.ч. частично) / распределённые полностью / все. */
export type ReceiptListFilter = 'open' | 'full' | 'all';
export const RECEIPT_FILTERS: readonly ReceiptListFilter[] = ['open', 'full', 'all'];
export const RECEIPT_FILTER_LABELS: Record<ReceiptListFilter, string> = {
  open: 'Не распределённые',
  full: 'Распределённые',
  all: 'Все',
};
export const RECEIPT_PAGE_SIZE = 30;

export function parseReceiptFilter(value: string | null): ReceiptListFilter {
  return (RECEIPT_FILTERS as readonly string[]).includes(value ?? '') ? (value as ReceiptListFilter) : 'open';
}

export function matchesReceiptFilter(state: OnecAllocationState, filter: ReceiptListFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'full' ? state === 'full' : state !== 'full';
}

/** Параметры списка приходов; `legacy` — старый backend без `allocation`/`withLines` (фильтр тогда на клиенте). */
export function receiptListParams(filter: ReceiptListFilter, page: number, legacy = false): OnecDocumentListParams {
  if (legacy) return { tab: 'receipts', postedOnly: true, page: 1, pageSize: 50 };
  return {
    tab: 'receipts',
    postedOnly: true,
    page,
    pageSize: RECEIPT_PAGE_SIZE,
    withLines: true,
    ...(filter === 'all' ? {} : { allocation: filter }),
  };
}

const quantityFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
export function formatReceiptQuantity(value: number, unitName: string | null): string {
  return `${quantityFormat.format(value)}${unitName ? ` ${unitName}` : ''}`;
}

export function lineSummaryText(line: OnecDocumentLineSummaryDto): string {
  return `${line.name} — ${formatReceiptQuantity(line.quantity, line.unitName)}`;
}

export function receiptSupplier(document: Pick<OnecDocumentListItemDto, 'supplierName' | 'counterpartyName'>): string {
  return document.supplierName ?? document.counterpartyName ?? '—';
}

export interface AllocatedOrderRow {
  key: string;
  orderId: number;
  orderName: string;
  /** Полный номер — из рабочего списка; нет строки там (заказ вне окна) — null. */
  fullNumber: string | null;
  /** Потребность заказа в этом материале и её единица — из рабочего списка. */
  need: number | null;
  needUnit: 'm2' | 'lm' | null;
  /** Обеспечено из этого поступления, в единице строки документа. */
  quantity: number;
}

export interface AllocatedLineGroup {
  lineId: number;
  lineNo: number;
  name: string;
  unitName: string | null;
  /** Количество в документе по строке. */
  documentQuantity: number;
  /** Распределено на заказы (включая заказы вне области пользователя). */
  allocated: number;
  remaining: number;
  /** Нарушение «распределено ≤ количеству документа» — показывается предупреждением. */
  exceeded: boolean;
  rows: AllocatedOrderRow[];
  hiddenAllocationsCount: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * «Распределено по заказам» (замечание 10): по каждой строке прихода — заказы, их потребность и сколько
 * обеспечено из этого поступления. Строки без распределений не показываются.
 */
export function buildAllocatedGroups(
  card: Pick<OnecDocumentCardDto, 'lines'>,
  worklistLines: ReadonlyArray<Pick<ProcurementWorklistLine, 'orderId' | 'resourceKey' | 'need' | 'unit' | 'fullNumber'>>,
): AllocatedLineGroup[] {
  const demand = new Map(worklistLines.map((line) => [`${line.orderId}|${line.resourceKey}`, line]));
  const groups: AllocatedLineGroup[] = [];
  for (const line of card.lines) {
    if (line.isDocumentTotal) continue;
    const receipts = line.allocations.filter((allocation) => allocation.role === 'receipt');
    if (receipts.length === 0 && line.hiddenAllocationsCount === 0) continue;
    const byOrder = new Map<string, AllocatedOrderRow>();
    for (const allocation of receipts) {
      const key = `${allocation.orderId}|${allocation.resourceKey}`;
      const known = demand.get(key);
      const row = byOrder.get(key) ?? {
        key,
        orderId: allocation.orderId,
        orderName: allocation.orderName,
        fullNumber: known?.fullNumber ?? null,
        need: known?.need ?? null,
        needUnit: known?.unit ?? null,
        quantity: 0,
      };
      row.quantity = round3(row.quantity + (allocation.quantity ?? 0));
      byOrder.set(key, row);
    }
    const allocated = round3(line.allocated ?? [...byOrder.values()].reduce((sum, row) => sum + row.quantity, 0));
    groups.push({
      lineId: line.lineId,
      lineNo: line.lineNo,
      name: line.material?.name ?? line.nomenclatureName ?? `Строка ${line.lineNo}`,
      unitName: line.unitName,
      documentQuantity: line.quantity,
      allocated,
      remaining: round3(line.quantity - allocated),
      exceeded: allocated > line.quantity + 1e-9,
      rows: [...byOrder.values()].sort((left, right) => left.orderId - right.orderId),
      hiddenAllocationsCount: line.hiddenAllocationsCount,
    });
  }
  return groups;
}

/** Адрес рабочего списка с заказами этого поступления: набор «Всё» + фильтр «Документ 1С», прочие фильтры сброшены. */
export function worklistForReceiptParams(current: URLSearchParams, documentId: number): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of WORKLIST_URL_KEYS) next.delete(key);
  next.delete('section');
  next.set('preset', 'all');
  next.set('wlDoc', String(documentId));
  return next;
}

/** Дописать страницу к списку без повторов (документ мог «переехать» между страницами, пока список открыт). */
export function mergeReceiptPages<T extends { documentId: number }>(current: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(current.map((document) => document.documentId));
  return [...current, ...page.filter((document) => !seen.has(document.documentId))];
}

/** Прокрутка списка дошла до конца (с запасом) и есть что подгружать. */
export function shouldLoadNextReceipts(input: { scrollTop: number; clientHeight: number; scrollHeight: number; loaded: number; total: number; busy: boolean }): boolean {
  if (input.busy || input.loaded >= input.total) return false;
  return input.scrollTop + input.clientHeight >= input.scrollHeight - 24;
}

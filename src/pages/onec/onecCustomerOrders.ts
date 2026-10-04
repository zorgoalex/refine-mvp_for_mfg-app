// Заказы покупателей 1С и связанные документы (поступления, возвраты, накладные): типы ответа API и чистые помощники
// вкладки «Заказы 1С» (план 2026-10-02-onec-customer-documents-plan.md §6–§7).

export interface OnecDocumentRef {
  refKey: string;
  type: string | null;
  /** null — документ 1С не загружен в ERP (вне окна загрузки или вида). */
  documentId: number | null;
  docKind: string | null;
  number: string | null;
  docDate: string | null;
}

export interface OnecCustomerOrderSummary {
  documentId: number;
  sourceId: number;
  refKey: string;
  number: string;
  docDate: string;
  posted: boolean;
  deletedInOnec: boolean;
  missingInSource: boolean;
  counterpartyName: string | null;
  amount: string | null;
  currency: string | null;
  /** Поступления − возвраты (проведённые, не помеченные), в валюте заказа. */
  paid: string;
  /** Суммы строк проведённых накладных по заказу, в валюте заказа. */
  shipped: string;
  /** Оплаты (поступления − возвраты) и отгрузки по заказу в других валютах — отдельно, без пересчёта. */
  otherCurrency: Array<{ currency: string | null; paid: string; shipped: string }>;
  authorName: string | null;
  responsibleName: string | null;
  stateRefKey: string | null;
  stateName: string | null;
  paymentStatus: string | null;
  productionStatus: string | null;
  deliveryMethod: string | null;
  shipmentDate: string | null;
}

export interface OnecCustomerOrderList {
  total: number;
  limit: number;
  offset: number;
  states: Array<{ refKey: string; name: string | null; count: number }>;
  items: OnecCustomerOrderSummary[];
}

export interface OnecLinkedDocument {
  documentId: number;
  docKind: string;
  number: string;
  docDate: string;
  posted: boolean;
  deletedInOnec: boolean;
  missingInSource: boolean;
  currency: string | null;
  amount: string | null;
  advance: boolean;
  authorName?: string | null;
  settlements?: OnecDocumentRef[];
}

export interface OnecCustomerOrderDetail extends OnecCustomerOrderSummary {
  docAt: string | null;
  comment: string | null;
  orderKindName: string | null;
  completionVariant: string | null;
  deliveryAddress: string | null;
  deliveryServiceName: string | null;
  expectedDeliveryDate: string | null;
  onecChangedAt: string | null;
  basis: OnecDocumentRef | null;
  lines: Array<{
    lineNo: number;
    section: string;
    nomenclatureName: string | null;
    quantity: string;
    unitName: string | null;
    price: string | null;
    amount: string | null;
    content: string | null;
    shipmentDate: string | null;
    isStockItem: boolean;
    removedInOnec: boolean;
  }>;
  payments: OnecLinkedDocument[];
  shipments: OnecLinkedDocument[];
}

export const ONEC_DOC_KIND_LABELS: Readonly<Record<string, string>> = {
  customer_order: 'Заказ покупателя',
  cash_receipt: 'Поступление в кассу',
  bank_receipt: 'Поступление на счёт',
  cash_refund: 'Возврат из кассы',
  bank_refund: 'Возврат со счёта',
  sales_shipment: 'Расходная накладная',
  supplier_return: 'Возврат поставщику',
  purchase_receipt: 'Приходная накладная',
  cash_outflow: 'Расход из кассы',
  bank_outflow: 'Расход со счёта',
  inventory_writeoff: 'Списание',
  inventory_transfer: 'Перемещение',
};

/** Название вида документа ERP или типа 1С (`Document_СчетНаОплату` → «СчетНаОплату»). */
export function onecDocKindLabel(kind: string | null, type?: string | null): string {
  if (kind && ONEC_DOC_KIND_LABELS[kind]) return ONEC_DOC_KIND_LABELS[kind];
  if (type) return type.replace(/^Document_/, '');
  return kind ?? '—';
}

export const isRefund = (kind: string): boolean => kind === 'cash_refund' || kind === 'bank_refund';

/** Сумма NUMERIC-строки для показа: «1 234,50 KZT»; null — прочерк. */
export function formatMoney(value: string | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const text = number.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${text} ${currency}` : text;
}

export type SettlementTone = 'none' | 'partial' | 'full' | 'over';

/** Доля оплаты/отгрузки к сумме заказа: нет, частично, полностью, сверх суммы (на копейки не реагирует). */
export function settlementTone(done: string, total: string | null): SettlementTone {
  const sum = Number(total ?? 0);
  const value = Number(done);
  if (!Number.isFinite(value) || value <= 0.004) return 'none';
  if (!Number.isFinite(sum) || sum <= 0) return 'over';
  if (value + 0.004 < sum) return 'partial';
  if (value - 0.004 > sum) return 'over';
  return 'full';
}

export const SETTLEMENT_TONE_COLORS: Readonly<Record<SettlementTone, string | undefined>> = {
  none: undefined,
  partial: 'orange',
  full: 'green',
  over: 'purple',
};

/** Состояние документа 1С одной строкой: не проведён / помечен на удаление / нет в выгрузке. */
export function documentStateLabel(doc: { posted: boolean; deletedInOnec: boolean; missingInSource: boolean }): string | null {
  if (doc.missingInSource) return 'нет в выгрузке 1С';
  if (doc.deletedInOnec) return 'помечен на удаление';
  if (!doc.posted) return 'не проведён';
  return null;
}

/** Подпись сумм в других валютах: «+ 100,00 USD оплачено, 50,00 USD отгружено»; пусто — null. */
export function otherCurrencyLabel(items: OnecCustomerOrderSummary['otherCurrency']): string | null {
  const parts = items.flatMap((item) => {
    const values: string[] = [];
    if (Number(item.paid) !== 0) values.push(`${formatMoney(item.paid, item.currency)} оплачено`);
    if (Number(item.shipped) !== 0) values.push(`${formatMoney(item.shipped, item.currency)} отгружено`);
    return values;
  });
  return parts.length > 0 ? `+ ${parts.join(', ')}` : null;
}

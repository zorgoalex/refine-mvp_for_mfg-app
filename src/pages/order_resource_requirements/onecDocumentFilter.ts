import type { DateOnlyString } from '../../api/types/orderApi.types';
import { formatDate } from '../../utils/dateFormat';
import { isOnecPaymentKind, isOnecReceiptKind, type OnecDocKind } from './onecDocKind';
import { ordersLabel } from './resourceKinds';

/** Backend режет список документов «Документ 1С»-фильтра по этому лимиту (новее — вперёд). */
export const ONEC_DOCUMENT_FILTER_MAX = 200;

/**
 * Подписи вида документа именно для этого фильтра — отдельно от
 * `ONEC_DOC_KIND_SHORT_LABELS` (используется в чипах привязанных документов),
 * чтобы не менять уже вышедший текст чипов заодно с новым фильтром.
 */
const ONEC_DOCUMENT_FILTER_KIND_LABELS: Record<OnecDocKind, string> = {
  purchase_receipt: 'Поступление',
  cash_outflow: 'РКО',
  bank_outflow: 'Списание',
};

export interface OnecDocumentFilterDoc {
  documentId: number;
  kind: OnecDocKind;
  number: string;
  date: DateOnlyString;
  /**
   * Заказов текущей выборки списка с активным распределением этого документа.
   * Отсутствует, если подпись собрана из карточки документа (deep link на
   * документ, не входящий в текущую выборку `GET .../onec-documents`).
   */
  ordersCount?: number;
}

/** Выбранное значение фильтра: только то, что нужно для Select/Tag/query. */
export interface OnecDocumentFilterValue {
  documentId: number;
  label: string;
}

/** Значение `?onecDocumentId=` из адресной строки — только положительное целое. */
export function parseOnecDocumentIdParam(value: string | null | undefined): number | null {
  if (!value) return null;
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/** Подпись опции/выбранного значения: «Поступление №E2E-1 от 28.09.2026[ · 3 заказа]». */
export function onecDocumentFilterOptionLabel(
  doc: Pick<OnecDocumentFilterDoc, 'kind' | 'number' | 'date' | 'ordersCount'>,
): string {
  const base = `${ONEC_DOCUMENT_FILTER_KIND_LABELS[doc.kind]} №${doc.number} от ${formatDate(doc.date)}`;
  return doc.ordersCount != null ? `${base} · ${ordersLabel(doc.ordersCount)}` : base;
}

/** Заглушка подписи, когда карточку документа (deep link) не удалось загрузить. */
export function onecDocumentFilterFallbackLabel(documentId: number): string {
  return `Документ #${documentId}`;
}

/** Текст закрываемого тега активного фильтра. */
export function onecDocumentFilterTagText(label: string): string {
  return `Только заказы документа 1С: ${label}`;
}

export interface OnecDocumentFilterOptionGroup {
  label: string;
  options: Array<{ value: number; label: string }>;
}

/**
 * Группы «Приходы»/«Оплаты» для Select фильтра. Пустая группа не попадает в
 * результат — иначе Select показал бы заголовок группы без единой опции.
 */
export function buildOnecDocumentFilterOptionGroups(
  documents: readonly OnecDocumentFilterDoc[],
): OnecDocumentFilterOptionGroup[] {
  const receipts = documents.filter((doc) => isOnecReceiptKind(doc.kind));
  const payments = documents.filter((doc) => isOnecPaymentKind(doc.kind));
  const groups: OnecDocumentFilterOptionGroup[] = [];
  if (receipts.length > 0) groups.push({ label: 'Приходы', options: receipts.map(toFilterOption) });
  if (payments.length > 0) groups.push({ label: 'Оплаты', options: payments.map(toFilterOption) });
  return groups;
}

function toFilterOption(doc: OnecDocumentFilterDoc): { value: number; label: string } {
  return { value: doc.documentId, label: onecDocumentFilterOptionLabel(doc) };
}

/** Подсказка «показаны первые N», когда backend обрезал список документов лимитом. */
export function onecDocumentFilterTruncatedHint(truncated: boolean): string | null {
  return truncated ? `Показаны первые ${ONEC_DOCUMENT_FILTER_MAX} документов.` : null;
}

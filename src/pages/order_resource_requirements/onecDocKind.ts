/**
 * Общий словарь видов документов 1С — используется и на карточке/списке
 * потребностей заказа (чипы привязанных документов), и на экране
 * «Закупки → Документы 1С» (фаза 3). Один источник подписей на оба экрана.
 */
export type OnecDocKind = 'purchase_receipt' | 'cash_outflow' | 'bank_outflow';

export const ONEC_DOC_KIND_LABELS: Record<OnecDocKind, string> = {
  purchase_receipt: 'Поступление товаров и услуг',
  cash_outflow: 'Расходный кассовый ордер',
  bank_outflow: 'Списание со счёта',
};

export const ONEC_DOC_KIND_SHORT_LABELS: Record<OnecDocKind, string> = {
  purchase_receipt: 'Приход',
  cash_outflow: 'РКО',
  bank_outflow: 'Списание',
};

export function onecDocKindLabel(kind: OnecDocKind): string {
  return ONEC_DOC_KIND_LABELS[kind];
}

export function onecDocKindShortLabel(kind: OnecDocKind): string {
  return ONEC_DOC_KIND_SHORT_LABELS[kind];
}

export function isOnecReceiptKind(kind: OnecDocKind): boolean {
  return kind === 'purchase_receipt';
}

export function isOnecPaymentKind(kind: OnecDocKind): boolean {
  return !isOnecReceiptKind(kind);
}

/** Маршрут карточки документа 1С — единая точка правды для ссылок из обоих экранов. */
export function onecDocumentShowPath(documentId: number): string {
  return `/procurement/onec-documents/show/${documentId}`;
}

export function onecDocumentListPath(): string {
  return '/procurement/onec-documents';
}

/**
 * Обратная ссылка «документ 1С → потребности заказов»: список потребностей с
 * предвыбранным фильтром «Документ 1С». Единая точка правды для обеих ссылок
 * на экранах документов 1С (список «в потребностях», карточка «Показать
 * заказы в потребностях»).
 */
export function orderResourceRequirementsOnecFilterPath(documentId: number): string {
  return `/order-resource-requirements?onecDocumentId=${documentId}`;
}

export type OnecDocumentStatus = 'posted' | 'unposted' | 'deleted';

export function onecDocumentStatus(posted: boolean, deletedInOnec: boolean): OnecDocumentStatus {
  if (deletedInOnec) return 'deleted';
  return posted ? 'posted' : 'unposted';
}

export const ONEC_DOCUMENT_STATUS_LABELS: Record<OnecDocumentStatus, string> = {
  posted: 'проведён',
  unposted: 'не проведён',
  deleted: 'удалён в 1С',
};

export function onecDocumentStatusLabel(posted: boolean, deletedInOnec: boolean): string {
  return ONEC_DOCUMENT_STATUS_LABELS[onecDocumentStatus(posted, deletedInOnec)];
}

export const ONEC_DOCUMENT_STATUS_TAG_COLORS: Record<OnecDocumentStatus, string | undefined> = {
  posted: 'success',
  unposted: undefined,
  deleted: 'error',
};

export function onecDocumentStatusTagColor(posted: boolean, deletedInOnec: boolean): string | undefined {
  return ONEC_DOCUMENT_STATUS_TAG_COLORS[onecDocumentStatus(posted, deletedInOnec)];
}

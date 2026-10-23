import { ApiError } from '../../api/apiError';
import type {
  ClientOnecDocument, ClientOnecDocumentGroup, ClientOnecDocumentsResponse, ClientOnecDocumentsSummary, ClientOnecDocumentState,
} from '../../api/partyContactsApi';

/** Вкладка «Документы 1С» показывается тем, у кого есть оба права; остальное (какие документы, деньги) решает backend. */
export function canSeeClientOnecDocuments(can: (permission: 'clients.onec_documents.view' | 'orders.view') => boolean): boolean {
  return can('clients.onec_documents.view') && can('orders.view');
}

export const CLIENT_ONEC_DOCUMENT_GROUPS: ReadonlyArray<{ group: ClientOnecDocumentGroup; label: string }> = [
  { group: 'orders', label: 'Заказы покупателя' },
  { group: 'shipments', label: 'Отгрузки' },
  { group: 'receipts', label: 'Поступления денег' },
  { group: 'refunds', label: 'Возвраты денег' },
];

const KIND_LABELS: Record<string, string> = {
  customer_order: 'Заказ покупателя',
  sales_shipment: 'Расходная накладная',
  cash_receipt: 'Поступление в кассу',
  bank_receipt: 'Поступление на счёт',
  cash_refund: 'Возврат из кассы',
  bank_refund: 'Возврат со счёта',
};

/** Название вида документа; незнакомый вид показывается как есть. */
export function clientOnecDocumentKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Пометка о документе, который в итог не входит; у проведённого документа пометки нет. */
export function clientOnecDocumentStateNote(state: ClientOnecDocumentState): string | null {
  if (state === 'not_posted') return 'не проведён';
  if (state === 'deleted') return 'помечен на удаление';
  if (state === 'missing') return 'нет в 1С';
  return null;
}

/** «12 500,00» из строки суммы 1С; пусто, если backend сумму не отдал (нет права видеть финансы). */
export function clientOnecMoney(value: string | null | undefined): string {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return '';
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ' ');
  return `${negative ? '−' : ''}${grouped},${(fraction + '00').slice(0, 2)}`;
}

/** Сумма документа с валютой, если она не тенге. */
export function clientOnecDocumentAmount(document: Pick<ClientOnecDocument, 'amount' | 'currency'>): string {
  const money = clientOnecMoney(document.amount);
  return money && document.currency && document.currency !== 'KZT' ? `${money} ${document.currency}` : money;
}

/** Подписи кнопок выбора вида: «Все (37)», «Отгрузки (12)»… */
export function clientOnecGroupOptions(groups: ClientOnecDocumentsResponse['groups']): Array<{ value: ClientOnecDocumentGroup | 'all'; label: string }> {
  const total = CLIENT_ONEC_DOCUMENT_GROUPS.reduce((sum, item) => sum + (groups[item.group] ?? 0), 0);
  return [{ value: 'all', label: `Все (${total})` },
    ...CLIENT_ONEC_DOCUMENT_GROUPS.map((item) => ({ value: item.group, label: `${item.label} (${groups[item.group] ?? 0})` }))];
}

/**
 * Итог вкладки по проведённым документам одной валюты. Долг — отгружено минус оплачено (поступления минус
 * возвраты): плюс — клиент должен, минус — аванс. Это данные 1С; с итогом «Документов ERP» не складывается.
 */
export function clientOnecTotals(summary: ClientOnecDocumentsSummary): Array<{ label: string; value: string }> {
  const balance = summary.balance.startsWith('-')
    ? { label: 'Аванс', value: clientOnecMoney(summary.balance.slice(1)) }
    : { label: 'Долг по отгрузкам', value: clientOnecMoney(summary.balance) };
  return [
    { label: 'Заказано', value: clientOnecMoney(summary.ordered) },
    { label: 'Отгружено', value: clientOnecMoney(summary.shipped) },
    { label: 'Поступило', value: clientOnecMoney(summary.received) },
    { label: 'Возвращено', value: clientOnecMoney(summary.refunded) },
    balance,
  ];
}

/** Заголовок итога: валюта названа всегда, чтобы сумму в другой валюте не приняли за тенге. */
export function clientOnecTotalsTitle(currency: string | null): string {
  if (currency === 'KZT') return 'Итог по 1С, тенге';
  return currency ? `Итог по 1С, ${currency}` : 'Итог по 1С, валюта неизвестна';
}

/** Пояснение над списком: пользователь с доступом «только свои» видит не все документы контрагента. */
export function clientOnecScopeNote(scope: ClientOnecDocumentsResponse['scope']): string | null {
  return scope === 'own'
    ? 'Показаны только документы 1С, которые относятся к вашим заказам (вы автор или менеджер заказа); итог — по ним. Возвраты денег, документы без заказа и документы, где есть заказы других менеджеров или строки без заказа, не показаны.'
    : null;
}

/** Почему список не показан: нет прав, старый backend без этого чтения или сбой. */
export function clientOnecDocumentsProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Недостаточно прав для просмотра документов 1С клиента.';
  if (error instanceof ApiError && error.status === 404 && error.code !== 'CLIENT_NOT_FOUND') return 'Документы 1С клиента появятся после обновления сервера.';
  return 'Не удалось загрузить документы 1С клиента. Обновите страницу.';
}

import type { OnecUnitCode } from '../../api/types/onecDocumentsApi.types';
import type {
  ProcurementHistoryCurrent,
  ProcurementHistoryDocumentRef,
  ProcurementHistoryEvent,
} from '../../api/types/procurementHistoryApi.types';
import { onecUnitLabel } from '../onec_purchase_documents/onecDocumentsHelpers';
import { formatDate } from './worklistHelpers';
import { currencyLabel } from './supplierRequestsHelpers';

/**
 * Чистая логика «Истории» материала заказа (этап 4a): заголовки событий, строка документа 1С,
 * сводка «сейчас» — на русском. Drawer — только рендер.
 */

const ONEC_UNIT_CODES: readonly OnecUnitCode[] = ['sheet', 'm2', 'lm', 'pcs', 'set'];

function isOnecUnitCode(value: string): value is OnecUnitCode {
  return (ONEC_UNIT_CODES as readonly string[]).includes(value);
}

const quantityFormatter3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const amountFormatter2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** Единица события (код 1С или потребности m2/lm) — та же подпись, что и в остальном экране снабжения. */
export function eventUnitLabel(unit: string | null): string {
  if (!unit) return '';
  return onecUnitLabel(isOnecUnitCode(unit) ? unit : null, unit);
}

/** «7 лист» / «12,5 м²» — количество события с его единицей. */
export function formatEventQuantity(quantity: number, unit: string | null): string {
  const label = eventUnitLabel(unit);
  const value = quantityFormatter3.format(quantity);
  return label ? `${value} ${label}` : value;
}

/** Сумма с валютой операции; у старых событий без снимка валюты — только число (текущую валюту не подставляем). */
export function formatEventAmount(amount: number, currency: string | null): string {
  const value = amountFormatter2.format(amount);
  return currency ? `${value} ${currencyLabel(currency)}` : value;
}

/** «привязан к заявке 26-0017 — 5 лист» / «отвязана от заявки 26-0018» — вложенные связи распределения. */
export function historyRequestLinkLabels(event: ProcurementHistoryEvent): string[] {
  const isPayment = event.role === 'payment';
  return (event.requestLinks ?? []).map((link) => {
    const verb = link.action === 'linked'
      ? (isPayment ? 'привязана к заявке' : 'привязан к заявке')
      : (isPayment ? 'отвязана от заявки' : 'отвязан от заявки');
    const number = link.number ?? `#${link.supplierRequestId}`;
    const quantity = link.quantity !== null ? ` — ${formatEventQuantity(link.quantity, link.unit)}` : '';
    return `${isPayment ? 'Оплата' : 'Приход'} ${verb} ${number}${quantity}`;
  });
}

export function originLabel(origin: string | null): string {
  if (origin === 'manual') return 'вручную';
  if (origin === 'onec') return 'приходом 1С';
  return '';
}

const REQUEST_ACTION_LABELS: Record<'request_created' | 'request_updated' | 'request_sent' | 'request_closed' | 'request_cancelled', string> = {
  request_created: 'создана',
  request_updated: 'изменена',
  request_sent: 'отправлена',
  request_closed: 'закрыта',
  request_cancelled: 'отменена',
};

/** Номер заявки для текста события — её человеческий номер, иначе `#id`. */
function requestLabel(event: Pick<ProcurementHistoryEvent, 'request'>): string {
  if (!event.request) return '—';
  return event.request.number ?? `#${event.request.supplierRequestId}`;
}

/** Заголовок события (план §4a): на русском, со всеми уточнениями из контракта. */
export function historyEventTitle(event: ProcurementHistoryEvent): string {
  switch (event.kind) {
    case 'marked': {
      const origin = originLabel(event.origin);
      const base = `Отмечено «Закуплено»${origin ? ` ${origin}` : ''}`;
      const quantity = event.quantity !== null ? ` — потребность ${formatEventQuantity(event.quantity, event.unit)}` : '';
      return `${base}${quantity}`;
    }
    case 'unmarked':
      return 'Снята отметка «Закуплено»';
    case 'allocation_added':
    case 'allocation_removed': {
      const added = event.kind === 'allocation_added';
      if (event.role === 'payment') {
        const base = added ? 'Оплата распределена' : 'Распределение оплаты снято';
        const amount = event.amount !== null ? ` — ${formatEventAmount(event.amount, event.currency)}` : '';
        return `${base}${amount}`;
      }
      const base = added ? 'Приход распределён' : 'Распределение прихода снято';
      const quantity = event.quantity !== null ? ` — ${formatEventQuantity(event.quantity, event.unit)}` : '';
      const marked = event.markedPurchased ? ' — отмечено «Закуплено»' : '';
      return `${base}${quantity}${marked}`;
    }
    case 'allocation_linked':
    case 'allocation_unlinked': {
      const linked = event.kind === 'allocation_linked';
      const isPayment = event.role === 'payment';
      const subject = isPayment ? 'Оплата' : 'Приход';
      const request = requestLabel(event);
      const verb = isPayment
        ? (linked ? 'привязана к заявке' : 'отвязана от заявки')
        : (linked ? 'привязан к заявке' : 'отвязан от заявки');
      const quantity = !isPayment && event.quantity !== null ? ` — ${formatEventQuantity(event.quantity, event.unit)}` : '';
      return `${subject} ${verb} ${request}${quantity}`;
    }
    case 'request_created':
    case 'request_updated':
    case 'request_sent':
    case 'request_closed':
    case 'request_cancelled': {
      const request = requestLabel(event);
      const action = REQUEST_ACTION_LABELS[event.kind];
      const quantity = event.quantity !== null ? ` — по заказу ${formatEventQuantity(event.quantity, event.unit)}` : '';
      return `Заявка ${request} ${action}${quantity}`;
    }
    default:
      return event.kind;
  }
}

const DOC_KIND_LABELS: Record<string, string> = {
  purchase_receipt: 'Поступление',
  bank_outflow: 'Списание с р/с',
  cash_outflow: 'Выдача из кассы',
};

/** «Поступление № 123 от 01.10.2026» — строка документа 1С под событием, или null без документа. */
export function historyDocumentLabel(document: ProcurementHistoryDocumentRef | null): string | null {
  if (!document) return null;
  const kindLabel = document.docKind ? DOC_KIND_LABELS[document.docKind] ?? document.docKind : 'Документ';
  const number = document.number ? ` № ${document.number}` : '';
  const date = document.date ? ` от ${formatDate(document.date)}` : '';
  return `${kindLabel}${number}${date}`;
}

/** Сводка «Сейчас»: потребность, статус «Закуплено», предупреждение об изменившейся потребности. */
export function currentSummaryLines(current: ProcurementHistoryCurrent | null): string[] {
  if (!current) return [];
  const lines: string[] = [];
  lines.push(`Сейчас: потребность ${current.quantity !== null ? formatEventQuantity(current.quantity, current.unit) : 'нет данных'}`);
  const origin = originLabel(current.origin);
  lines.push(current.purchased ? `Закуплено${origin ? ` (${origin})` : ''}` : 'Не закуплено');
  if (current.changedSinceMark && current.quantityAtMark !== null && current.unitAtMark !== null && current.quantity !== null) {
    lines.push(
      `Потребность изменилась после отметки: было ${formatEventQuantity(current.quantityAtMark, current.unitAtMark)} ` +
        `(при отметке) → сейчас ${formatEventQuantity(current.quantity, current.unit)}`,
    );
  }
  return lines;
}

/** Новые события — сверху: сервер обычно уже отдаёт так, но Drawer не зависит от этого порядка. */
export function sortHistoryEventsDesc(events: ProcurementHistoryEvent[]): ProcurementHistoryEvent[] {
  return [...events].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
}

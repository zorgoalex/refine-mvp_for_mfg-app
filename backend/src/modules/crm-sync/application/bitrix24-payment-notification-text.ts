import type { PaymentNotificationLine, PaymentNotificationPayload } from '../../payments/application/payment-change-notification';
import { safeOutboundText } from './bitrix24-safe-text';

/** Longest body of a comment or a notification. */
export const NOTIFICATION_TEXT_LIMIT = 1500;

export interface NotificationTextContext {
  notificationId: string;
  orderId: string;
  dealId: string;
  /** ERP frontend origin (FRONTEND_ORIGIN). */
  erpBaseUrl: string | null;
  /** Bitrix24 portal host, e.g. portal.bitrix24.kz. */
  portalHost: string | null;
  syncIncomplete: boolean;
}

export function notificationMarker(notificationId: string): string {
  return `ERP-уведомление: ${notificationId}`;
}

/**
 * The deal comment and the notification text. Only the stored payload is used; every dynamic value is cleaned
 * again here, and the only links are the ERP order and the deal, built from configuration and numeric ids.
 */
export function renderPaymentNotification(payload: PaymentNotificationPayload, context: NotificationTextContext): {
  comment: string;
  notify: string;
} {
  const orderName = safeOutboundText(payload.orderName) || `№${context.orderId}`;
  const actor = safeOutboundText(payload.actorName);
  const header = `Оплаты заказа «${orderName}» изменены в ERP${actor ? ` (${actor})` : ''}:`;
  const totals = `Оплачено: ${money(payload.paidAfter)}${payload.finalAmount === null ? '' : ` из ${money(payload.finalAmount)}`}` +
    (payload.statusAfter ? ` — ${safeOutboundText(payload.statusAfter)}` : '');
  const warning = context.syncIncomplete ? 'Оплата в Bitrix ещё не обновлена — проверьте в ERP.' : null;
  const erpLink = erpOrderUrl(context.erpBaseUrl, context.orderId);
  const dealLink = dealUrl(context.portalHost, context.dealId);
  const marker = notificationMarker(context.notificationId);

  const commentTail = [totals, warning, erpLink ? `[URL=${erpLink}]Открыть заказ в ERP[/URL]` : null, marker]
    .filter((line): line is string => line !== null);
  const notifyTail = [totals, warning,
    [dealLink ? `[URL=${dealLink}]Сделка[/URL]` : null, erpLink ? `[URL=${erpLink}]Заказ в ERP[/URL]` : null]
      .filter(Boolean).join(' · ') || null]
    .filter((line): line is string => line !== null);
  const lines = payload.lines.map(renderLine);
  return {
    comment: fit(header, lines, commentTail),
    notify: fit(header, lines, notifyTail),
  };
}

/** Header, as many change lines as fit, «и ещё N изменений», then the tail (always kept whole). */
function fit(header: string, lines: string[], tail: string[]): string {
  const fixed = header.length + tail.reduce((sum, line) => sum + line.length + 1, 0) + 40;
  const shown: string[] = [];
  let used = fixed;
  for (const line of lines) {
    if (used + line.length + 1 > NOTIFICATION_TEXT_LIMIT) break;
    shown.push(line);
    used += line.length + 1;
  }
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`и ещё ${rest} ${plural(rest, 'изменение', 'изменения', 'изменений')}`);
  return [header, ...shown, ...tail].join('\n');
}

function renderLine(line: PaymentNotificationLine): string {
  const other = safeOutboundText(line.otherOrderName);
  switch (line.kind) {
    case 'added':
      return `• добавлена оплата ${describe(line.amountAfter, line.dateAfter, line.typeAfter)}`;
    case 'restored':
      return `• восстановлена оплата ${describe(line.amountAfter, line.dateAfter, line.typeAfter)}`;
    case 'deleted':
      return `• удалена оплата ${describe(line.amountBefore, line.dateBefore, line.typeBefore)}`;
    case 'moved_out':
      return `• оплата ${describe(line.amountBefore, line.dateBefore, line.typeBefore)} перенесена в заказ «${other}»`;
    case 'moved_in': {
      const amount = line.amountBefore !== undefined && line.amountBefore !== line.amountAfter
        ? `, сумма ${money(line.amountBefore)} → ${money(line.amountAfter)}`
        : '';
      return `• перенесена оплата ${describe(line.amountAfter, line.dateAfter, line.typeAfter)} из заказа «${other}»${amount}`;
    }
    case 'changed': {
      const parts: string[] = [];
      if (line.amountAfter !== undefined) parts.push(`сумма ${money(line.amountBefore)} → ${money(line.amountAfter)}`);
      if (line.dateAfter !== undefined) parts.push(`дата ${date(line.dateBefore)} → ${date(line.dateAfter)}`);
      if (line.typeAfter !== undefined) {
        parts.push(`тип ${safeOutboundText(line.typeBefore) || '—'} → ${safeOutboundText(line.typeAfter) || '—'}`);
      }
      return `• изменена оплата: ${parts.join('; ')}`;
    }
    default:
      return '• изменена оплата';
  }
}

function describe(amount: number | undefined, day: string | undefined, type: string | undefined): string {
  const kind = safeOutboundText(type);
  return `${money(amount)}${day ? ` от ${date(day)}` : ''}${kind ? ` (${kind})` : ''}`;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const [whole, cents] = Math.abs(Number(value)).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${Number(value) < 0 ? '−' : ''}${grouped}${cents === '00' ? '' : `,${cents}`} ₸`;
}

function date(value: string | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '—';
}

function erpOrderUrl(base: string | null, orderId: string): string | null {
  if (!base || !/^[1-9][0-9]*$/.test(orderId)) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}/orders/show/${orderId}`;
  } catch {
    return null;
  }
}

function dealUrl(host: string | null, dealId: string): string | null {
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !/^[1-9][0-9]*$/.test(dealId)) return null;
  return `https://${host}/crm/deal/details/${dealId}/`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

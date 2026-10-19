import { describe, expect, it } from 'vitest';
import type { PaymentNotificationPayload } from '../../payments/application/payment-change-notification';
import { NOTIFICATION_TEXT_LIMIT, notificationMarker, renderPaymentNotification } from './bitrix24-payment-notification-text';
import { safeOutboundText } from './bitrix24-safe-text';

const WEBHOOK = 'https://x.bitrix24.kz/rest/1/abcdef0123456789abcd/';
const context = {
  notificationId: '6f1c2f3e-0d5b-4f39-9f7e-111111111111',
  orderId: '11501',
  dealId: '7001',
  erpBaseUrl: 'https://mebelkz.app',
  portalHost: 'portal.bitrix24.kz',
  syncIncomplete: false,
};

function payload(overrides: Partial<PaymentNotificationPayload> = {}): PaymentNotificationPayload {
  return {
    orderName: '1258тест',
    finalAmount: 285434,
    paidAfter: 142716,
    statusAfter: 'Частично оплачен',
    actorName: 'Иванов Иван',
    paymentIds: [1],
    lines: [{ kind: 'changed', amountBefore: 142717, amountAfter: 142716 }],
    ...overrides,
  };
}

describe('safeOutboundText', () => {
  it.each([
    [`Заказ ${WEBHOOK} конец`, 'Заказ … конец'],
    ['см. www.example.com/x', 'см. …'],
    ['x.bitrix24.kz/rest/1/abcdef0123456789', '…'],
    ['/rest/1/k3x9a8b7c6d5', '/rest…'],
    ['пишите a.b@example.com', 'пишите …'],
    ['токен AbCdEfGhIjKlMnOpQrStUv', 'токен …'],
    ['[URL=https://evil]клик[/URL]', '…'],
    ['[B]жирный[/B]', 'Bжирный/B'],
    ['строка\nвторая третья', 'строка вторая третья'],
    ['Кухня 1/2/3', 'Кухня 1/2/3'],
    ['ключ abcdef0123456789', 'ключ …'],
    ['access_token=abcd1234-efgh5678-ijkl9012 и всё', 'access_token=…'],
    ['Пароль password: x1y2z3', 'Пароль password=…'],
    ['{"password":"x1y2z3"}', '{password=…'],
    ['{"access_token":"abcd1234-efgh5678"} конец', '{access_token=…'],
    ["'secret' = 'a b c' дальше", 'secret=…'],
    ['{"password":"a\\" x1y2z3"}', '{password=…'],
    ['Заказ password=x1,y2z3 конец', 'Заказ password=…'],
    ['Kitchen-Ivanov-Almaty-2026', '…'],
    ['Kitchen-2026', 'Kitchen-2026'],
    ['Кухня Иванова Алматы 2026', 'Кухня Иванова Алматы 2026'],
  ])('%s → %s', (input, expected) => {
    expect(safeOutboundText(input)).toBe(expected);
  });

  it('cuts to 120 characters', () => {
    expect(safeOutboundText('а'.repeat(300))).toHaveLength(120);
  });
});

describe('renderPaymentNotification', () => {
  it('builds the comment with the order, the author, the change, the totals, the ERP link and the marker', () => {
    const { comment, notify } = renderPaymentNotification(payload(), context);
    expect(comment).toBe([
      'Оплаты заказа «1258тест» изменены в ERP (Иванов Иван):',
      '• изменена оплата: сумма 142 717 ₸ → 142 716 ₸',
      'Оплачено: 142 716 ₸ из 285 434 ₸ — Частично оплачен',
      '[URL=https://mebelkz.app/orders/show/11501]Открыть заказ в ERP[/URL]',
      notificationMarker(context.notificationId),
    ].join('\n'));
    expect(notify).toContain('[URL=https://portal.bitrix24.kz/crm/deal/details/7001/]Сделка[/URL]');
    expect(notify).not.toContain('ERP-уведомление');
  });

  it('renders every kind of line', () => {
    const { comment } = renderPaymentNotification(payload({
      lines: [
        { kind: 'added', amountAfter: 1000, dateAfter: '2026-10-19', typeAfter: 'Наличные' },
        { kind: 'deleted', amountBefore: 500.5, dateBefore: '2026-10-18', typeBefore: 'Карта' },
        { kind: 'restored', amountAfter: 10, dateAfter: '2026-10-17' },
        { kind: 'moved_out', otherOrderName: 'Б-2', amountBefore: 300, dateBefore: '2026-10-16' },
        { kind: 'moved_in', otherOrderName: 'А-1', amountBefore: 300, amountAfter: 350, dateAfter: '2026-10-16' },
        { kind: 'changed', dateBefore: '2026-10-01', dateAfter: '2026-10-02', typeBefore: 'Карта', typeAfter: 'Kaspi' },
      ],
    }), context);
    expect(comment).toContain('• добавлена оплата 1 000 ₸ от 19.10.2026 (Наличные)');
    expect(comment).toContain('• удалена оплата 500,50 ₸ от 18.10.2026 (Карта)');
    expect(comment).toContain('• восстановлена оплата 10 ₸ от 17.10.2026');
    expect(comment).toContain('• оплата 300 ₸ от 16.10.2026 перенесена в заказ «Б-2»');
    expect(comment).toContain('• перенесена оплата 350 ₸ от 16.10.2026 из заказа «А-1», сумма 300 ₸ → 350 ₸');
    expect(comment).toContain('• изменена оплата: дата 01.10.2026 → 02.10.2026; тип Карта → Kaspi');
  });

  it('warns when the Bitrix24 payment is not updated yet', () => {
    const { comment, notify } = renderPaymentNotification(payload(), { ...context, syncIncomplete: true });
    expect(comment).toContain('Оплата в Bitrix ещё не обновлена — проверьте в ERP.');
    expect(notify).toContain('Оплата в Bitrix ещё не обновлена — проверьте в ERP.');
  });

  it('never carries a webhook URL or BB-code from the order or the author name', () => {
    const { comment, notify } = renderPaymentNotification(payload({
      orderName: `Заказ ${WEBHOOK}`,
      actorName: `[URL=${WEBHOOK}]Иван[/URL]`,
      lines: [{ kind: 'moved_out', otherOrderName: WEBHOOK, amountBefore: 1 }],
    }), context);
    for (const text of [comment, notify]) {
      expect(text).not.toContain('abcdef0123456789abcd');
      expect(text).not.toContain('x.bitrix24.kz');
      expect(text.match(/\[URL=/g)?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the text within the limit with «и ещё N изменений» and the marker intact', () => {
    const lines = Array.from({ length: 80 }, (_, index) => ({ kind: 'added' as const, amountAfter: index + 1, dateAfter: '2026-10-19', typeAfter: 'Наличные' }));
    const { comment, notify } = renderPaymentNotification(payload({ lines }), context);
    expect(comment.length).toBeLessThanOrEqual(NOTIFICATION_TEXT_LIMIT);
    expect(notify.length).toBeLessThanOrEqual(NOTIFICATION_TEXT_LIMIT);
    expect(comment).toMatch(/и ещё \d+ изменени(е|я|й)/);
    expect(comment.endsWith(notificationMarker(context.notificationId))).toBe(true);
  });

  it('never carries a quoted (JSON-shaped) credential from names into the comment or the notification', () => {
    const { comment, notify } = renderPaymentNotification(payload({
      orderName: 'Кухня {"password":"a\\" x1y2z3"} password=q1,w2e3r4',
      actorName: '{"access_token":"abcd1234-efgh5678"}',
    }), context);
    for (const text of [comment, notify]) {
      expect(text).toContain('Кухня');
      expect(text).not.toMatch(/x1y2z3|w2e3r4/);
      expect(text).not.toContain('abcd1234-efgh5678');
    }
  });

  it('omits links it cannot build safely', () => {
    const { comment, notify } = renderPaymentNotification(payload(), { ...context, erpBaseUrl: 'javascript:alert(1)', portalHost: 'evil host/x' });
    expect(comment).not.toContain('[URL=');
    expect(notify).not.toContain('[URL=');
  });
});

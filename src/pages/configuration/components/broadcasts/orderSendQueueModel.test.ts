import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isOrderSendCancellable, orderSendRecipientText, orderSendStateDetail, orderSendStateLabel, orderSendWhenText } from './orderSendQueueModel';
import { orderSendStatusText } from './orderSendSettingsModel';

describe('order send queue journal', () => {
  it('labels states and details without a phone or a group id', () => {
    expect(orderSendStateLabel('queued')).toBe('Ждёт');
    expect(orderSendStateLabel('future_state')).toBe('future_state');
    expect(orderSendStateDetail({ state: 'cancelled', cancelReason: 'manual', errorCode: null, cancelledBy: { id: '1', username: 'admin' } })).toBe('вручную, admin');
    expect(orderSendStateDetail({ state: 'unknown', cancelReason: null, errorCode: 'PARTIAL_DELIVERY', cancelledBy: null })).toBe('ушла часть изображений');
    expect(orderSendStateDetail({ state: 'sent', cancelReason: null, errorCode: null, cancelledBy: null })).toBeNull();
    expect(orderSendRecipientText({ targetKind: 'client', recipientLabel: 'Клиент', recipientMasked: '7701***2060' })).toBe('клиенту 7701***2060');
    expect(orderSendRecipientText({ targetKind: 'chat', recipientLabel: 'Цех ЧПУ', recipientMasked: '1203…@g.us' })).toBe('в чат «Цех ЧПУ»');
  });

  it('shows «≈ when», the pause and the expiry risk for a waiting send, the finish time otherwise', () => {
    const waiting = { state: 'queued', estimatedAt: '2026-10-03T09:35:00Z', mayExpire: false, finishedAt: null, sentAt: null };
    expect(orderSendWhenText(waiting, false)).toBe('≈ 03.10 14:35');
    expect(orderSendWhenText(waiting, true)).toBe('пауза');
    expect(orderSendWhenText({ ...waiting, mayExpire: true }, false)).toBe('может истечь');
    expect(orderSendWhenText({ ...waiting, state: 'sent', sentAt: '2026-10-03T09:36:00Z' }, false)).toBe('03.10 14:36');
    expect(isOrderSendCancellable({ state: 'queued' })).toBe(true);
    expect(isOrderSendCancellable({ state: 'sending' })).toBe(false);
  });

  it('the settings status reports the queue; an older backend keeps its old status', () => {
    expect(orderSendStatusText(null, false, Date.now(), { queueLength: 0, nextDeliveryAt: null })).toBeNull();
    expect(orderSendStatusText(null, true, Date.now(), { queueLength: 3, nextDeliveryAt: '2026-10-03T09:35:00Z' }))
      .toBe('В очереди отправок из карточек: 3; следующая ≈ 14:35.');
    expect(orderSendStatusText(null, true, Date.now(), undefined)).toBe('Предыдущая отправка из карточки ещё выполняется.');
  });

  it('the journal is in «Рассылка сообщений» for whatsapp.manage and hides on an older backend', () => {
    const panel = readFileSync(new URL('./BroadcastsPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('<OrderSendQueue />');
    const queue = readFileSync(new URL('./OrderSendQueue.tsx', import.meta.url), 'utf8');
    expect(queue).toContain("can('whatsapp.manage', authSession.getUser())");
    expect(queue).toContain('err.status === 404) setUnsupported(true)');
    expect(queue).toContain('orderSendApi.cancel(item.sendId)');
  });
});

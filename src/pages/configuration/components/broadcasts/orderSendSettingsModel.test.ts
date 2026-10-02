import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../../api/apiError';
import type { OrderSendSettings } from '../../../../api/orderSendApiTypes';
import {
  buildOrderSendUpdate,
  duplicateGroupIndexes,
  isOrderSendVersionConflict,
  orderSendDirty,
  orderSendSettingsErrorMessage,
  orderSendStatusText,
  toOrderSendFormValues,
  validateOrderSendCaption,
  validateOrderSendGroup,
  validateOrderSendInterval,
  validateOrderSendLabel,
} from './orderSendSettingsModel';

const settings: OrderSendSettings = {
  version: 4, enabled: true, minIntervalMinutes: 10, sendWindowMinutes: 5, clientForms: ['production_pdf'], clientCaption: 'Заказ {order_name}',
  chats: [{ chatKey: 'c1', groupChatId: '120363338054016575@g.us', label: 'ЧПУ', forms: ['production_pdf', 'order_pdf'], caption: '' }],
  updatedAt: '2026-10-01T00:00:00Z', updatedBy: null,
};

describe('order send settings form <-> payload', () => {
  it('round-trips settings into a PUT body keeping version and chatKey', () => {
    expect(buildOrderSendUpdate(4, toOrderSendFormValues(settings))).toEqual({
      version: 4, enabled: true, minIntervalMinutes: 10, sendWindowMinutes: 5, clientForms: ['production_pdf'], clientCaption: 'Заказ {order_name}',
      chats: [{ chatKey: 'c1', groupChatId: '120363338054016575@g.us', label: 'ЧПУ', forms: ['production_pdf', 'order_pdf'], caption: '' }],
    });
  });

  it('sends chatKey null for a new row, trims group and label, keeps the key when the group changes', () => {
    const values = toOrderSendFormValues(settings);
    values.chats[0].groupChatId = ' 120363111111111111@g.us ';
    values.chats.push({ chatKey: null, groupChatId: '120363222222222222@g.us', label: '  Менеджеры ', forms: ['production_excel'], caption: 'x' });
    const body = buildOrderSendUpdate(4, values);
    expect(body?.chats.map((c) => [c.chatKey, c.groupChatId, c.label])).toEqual([
      ['c1', '120363111111111111@g.us', 'ЧПУ'], [null, '120363222222222222@g.us', 'Менеджеры'],
    ]);
  });

  it('refuses a body with a bad interval', () => {
    expect(buildOrderSendUpdate(1, { ...toOrderSendFormValues(settings), minIntervalMinutes: null })).toBeNull();
    expect(buildOrderSendUpdate(1, { ...toOrderSendFormValues(settings), minIntervalMinutes: 0 })).toBeNull();
    expect(buildOrderSendUpdate(1, { ...toOrderSendFormValues(settings), minIntervalMinutes: 1441 })).toBeNull();
  });

  it('detects changes', () => {
    const values = toOrderSendFormValues(settings);
    expect(orderSendDirty(values, settings)).toBe(false);
    expect(orderSendDirty({ enabled: false }, settings)).toBe(true);
    expect(orderSendDirty({ chats: [] }, settings)).toBe(true);
    expect(orderSendDirty({ clientForms: ['production_pdf', 'order_pdf'] }, settings)).toBe(true);
  });
});

describe('order send settings validation', () => {
  it('validates interval, group, label', () => {
    expect(validateOrderSendInterval(1)).toBeNull();
    expect(validateOrderSendInterval(1440)).toBeNull();
    expect(validateOrderSendInterval(0)).not.toBeNull();
    expect(validateOrderSendInterval(2.5)).not.toBeNull();
    expect(validateOrderSendInterval(null)).not.toBeNull();
    expect(validateOrderSendGroup('120363338054016575@g.us')).toBeNull();
    expect(validateOrderSendGroup('120363338054-1700000000@g.us')).toBeNull();
    expect(validateOrderSendGroup('')).not.toBeNull();
    expect(validateOrderSendGroup('abc@g.us')).not.toBeNull();
    expect(validateOrderSendLabel('Цех')).toBeNull();
    expect(validateOrderSendLabel('  ')).not.toBeNull();
    expect(validateOrderSendLabel('я'.repeat(101))).not.toBeNull();
  });

  it('validates captions like the backend grammar', () => {
    const known = ['order_name', 'client'];
    expect(validateOrderSendCaption('Заказ {order_name} для {client}', known)).toBeNull();
    expect(validateOrderSendCaption('{{не переменная}}', known)).toBeNull();
    expect(validateOrderSendCaption('{unknown}', known)).toContain('Неизвестная переменная');
    expect(validateOrderSendCaption('{order_name', known)).toContain('Не закрыта');
    expect(validateOrderSendCaption('a } b', known)).toContain('Лишняя');
    expect(validateOrderSendCaption('x'.repeat(1001), known)).toContain('1000');
    expect(validateOrderSendCaption('', known)).toBeNull();
  });

  it('finds duplicate groups', () => {
    expect([...duplicateGroupIndexes([{ groupChatId: 'a@g.us' }, { groupChatId: ' b@g.us' }, { groupChatId: 'a@g.us ' }, { groupChatId: '' }, { groupChatId: '' }])]).toEqual([2]);
  });
});

describe('order send settings errors and status', () => {
  it('recognises the CAS conflict and maps errors', () => {
    expect(isOrderSendVersionConflict(new ApiError({ code: 'ORDER_SEND_SETTINGS_VERSION_CONFLICT', message: 'x', status: 409 }))).toBe(true);
    expect(isOrderSendVersionConflict(new ApiError({ code: 'BROADCAST_VERSION_CONFLICT', message: 'x', status: 409 }))).toBe(false);
    expect(orderSendSettingsErrorMessage(new ApiError({ code: 'VALIDATION_ERROR', message: 'Одна группа указана в списке чатов дважды', status: 422 }), 'f')).toBe('Одна группа указана в списке чатов дважды');
    expect(orderSendSettingsErrorMessage(new ApiError({ code: 'VALIDATION_ERROR', message: 'Некорректный запрос', status: 422 }), 'f')).toContain('Проверьте');
    expect(orderSendSettingsErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });

  it('words the status line', () => {
    expect(orderSendStatusText(null, true)).toContain('ещё выполняется');
    expect(orderSendStatusText('2026-10-01T07:30:00Z', false, Date.parse('2026-10-01T07:00:00Z'))).toBe('Следующая отправка из карточки возможна с 12:30.');
    expect(orderSendStatusText('2026-10-01T07:30:00Z', false, Date.parse('2026-10-01T08:00:00Z'))).toBeNull();
  });
});

describe('send window', () => {
  it('is whole minutes, at most half of the threshold, 0 allowed', async () => {
    const { validateOrderSendWindow } = await import('./orderSendSettingsModel');
    expect(validateOrderSendWindow(5, 10)).toBeNull();
    expect(validateOrderSendWindow(0, 1)).toBeNull();
    expect(validateOrderSendWindow(6, 10)).toContain('до 5 мин');
    expect(validateOrderSendWindow(1, 1)).toContain('до 0 мин');
    expect(validateOrderSendWindow(null, 10)).not.toBeNull();
    expect(validateOrderSendWindow(-1, 10)).not.toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { OrderSendMenu } from '../../api/orderSendApiTypes';
import {
  NO_CLIENT_PHONE_TITLE,
  buildOrderWhatsAppMenuItems,
  describeOrderWhatsAppSend,
  isOrderWhatsAppKey,
  orderWhatsAppItemKey,
  parseOrderWhatsAppKey,
} from './whatsappOrderSendMenu';

const runtime = { enabled: true, relayAvailable: true, unavailableReason: null };
const FORMS = [
  { code: 'production_pdf' as const, title: 'PDF для производства', financial: false },
  { code: 'order_pdf' as const, title: 'PDF заказа', financial: true },
  { code: 'production_excel' as const, title: 'Excel для производства', financial: false },
];
const menu = (over: Partial<OrderSendMenu> = {}): OrderSendMenu => ({
  enabled: true, forms: FORMS, client: { forms: ['production_pdf', 'order_pdf'] },
  chats: [{ chatKey: 'c1', label: 'Цех ЧПУ', forms: ['production_pdf'] }, { chatKey: 'c2', label: 'Менеджеры', forms: ['production_pdf', 'production_excel'] }],
  nextAllowedAt: null, activeSend: false, runtime, ...over,
});

describe('buildOrderWhatsAppMenuItems', () => {
  it('builds a client submenu, a plain item for a one-form chat and a submenu for a multi-form chat', () => {
    const items = buildOrderWhatsAppMenuItems(menu(), { hasClientPhone: true });
    expect(items.map((i) => i.label)).toEqual(['Отправить клиенту в WhatsApp', 'Отправить в чат «Цех ЧПУ» — PDF для производства', 'Отправить в чат «Менеджеры»']);
    expect(items[0].children?.map((c) => [c.key, c.label])).toEqual([
      ['wa-send:client:production_pdf', 'PDF для производства'], ['wa-send:client:order_pdf', 'PDF заказа'],
    ]);
    expect(items[1].key).toBe('wa-send:chat:c1:production_pdf');
    expect(items[1].children).toBeUndefined();
    expect(items[2].children?.map((c) => c.key)).toEqual(['wa-send:chat:c2:production_pdf', 'wa-send:chat:c2:production_excel']);
  });

  it('disables the client item with a hint when the client has no phone, chats stay enabled', () => {
    const items = buildOrderWhatsAppMenuItems(menu(), { hasClientPhone: false });
    expect(items[0]).toMatchObject({ key: 'wa-send:group:client', label: 'Отправить клиенту в WhatsApp', disabled: true, title: NO_CLIENT_PHONE_TITLE });
    expect(items[0].children).toBeUndefined();
    expect(NO_CLIENT_PHONE_TITLE).toBe('У клиента нет телефона');
    expect(items[1].disabled).toBe(false);
    const single = buildOrderWhatsAppMenuItems(menu({ client: { forms: ['production_pdf'] } }), { hasClientPhone: false });
    expect(single[0]).toMatchObject({ key: 'wa-send:client:production_pdf', label: 'Отправить клиенту в WhatsApp — PDF для производства', disabled: true, title: NO_CLIENT_PHONE_TITLE });
  });

  it('is empty when disabled, absent or without recipients', () => {
    expect(buildOrderWhatsAppMenuItems(null, { hasClientPhone: true })).toEqual([]);
    expect(buildOrderWhatsAppMenuItems(undefined, { hasClientPhone: true })).toEqual([]);
    expect(buildOrderWhatsAppMenuItems(menu({ enabled: false }), { hasClientPhone: true })).toEqual([]);
    expect(buildOrderWhatsAppMenuItems(menu({ client: { forms: [] }, chats: [] }), { hasClientPhone: true })).toEqual([]);
    expect(buildOrderWhatsAppMenuItems(menu({ client: { forms: [] }, chats: [{ chatKey: 'x', label: 'Пустой', forms: [] }] }), { hasClientPhone: true })).toEqual([]);
  });

  it('shows exactly the forms the API returned (financial forms only when listed)', () => {
    const noFinancial = menu({ forms: [FORMS[0]], client: { forms: ['production_pdf', 'order_pdf'] } });
    const items = buildOrderWhatsAppMenuItems(noFinancial, { hasClientPhone: true });
    expect(items[0].label).toBe('Отправить клиенту в WhatsApp — PDF для производства');
    expect(JSON.stringify(items)).not.toContain('order_pdf');
  });

  it('disables leaves being sent and passes the icon to top-level items', () => {
    const sending = new Set([orderWhatsAppItemKey({ kind: 'chat', chatKey: 'c2' }, 'production_excel')]);
    const items = buildOrderWhatsAppMenuItems(menu(), { hasClientPhone: true, sending, icon: 'ICON' as never });
    expect(items.every((i) => i.icon === 'ICON')).toBe(true);
    expect(items[2].children?.map((c) => c.disabled)).toEqual([false, true]);
  });
});

describe('item keys', () => {
  it('round-trips target and form', () => {
    expect(parseOrderWhatsAppKey('wa-send:client:order_pdf')).toEqual({ target: { kind: 'client' }, form: 'order_pdf' });
    expect(parseOrderWhatsAppKey('wa-send:chat:c-1:production_excel')).toEqual({ target: { kind: 'chat', chatKey: 'c-1' }, form: 'production_excel' });
    expect(parseOrderWhatsAppKey('wa-send:group:client')).toBeNull();
    expect(parseOrderWhatsAppKey('refresh')).toBeNull();
    expect(isOrderWhatsAppKey('wa-send:client:x')).toBe(true);
    expect(isOrderWhatsAppKey('json')).toBe(false);
  });

  it('describes the toast recipient', () => {
    expect(describeOrderWhatsAppSend(menu(), { kind: 'client' }, 'order_pdf')).toEqual({ targetLabel: 'клиенту', formTitle: 'PDF заказа' });
    expect(describeOrderWhatsAppSend(menu(), { kind: 'chat', chatKey: 'c1' }, 'production_pdf')).toEqual({ targetLabel: 'в чат «Цех ЧПУ»', formTitle: 'PDF для производства' });
  });
});

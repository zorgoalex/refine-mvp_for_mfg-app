import { describe, expect, it } from 'vitest';
import type { OrderSendMenu } from '../../api/orderSendApiTypes';
import {
  NO_CLIENT_PHONE_TITLE,
  buildOrderWhatsAppMenuItems,
  describeOrderWhatsAppSend,
  isOrderWhatsAppKey,
  orderWhatsAppItemKey,
  parseOrderWhatsAppKey,
  withPhoneToken,
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

describe('employee recipients in the card menu', () => {
  const employees = [
    { recipientKey: 'e1', label: 'ivanov / Иванов И.', forms: ['production_pdf' as const], contacts: [{ contactId: 5, masked: '7701***0101', isPrimary: true }] },
    { recipientKey: 'e2', label: 'Петров П.', forms: ['production_pdf' as const, 'production_excel' as const], contacts: [
      { contactId: 7, masked: '7701***0202', isPrimary: true }, { contactId: 8, masked: '7701***0303', isPrimary: false }] },
    { recipientKey: 'e3', label: 'Сидоров С.', forms: ['production_pdf' as const], contacts: [] },
  ];

  it('one phone — like a chat; several — a submenu of phones (primary first); none — locked with a hint', () => {
    const items = buildOrderWhatsAppMenuItems(menu({ chats: [], employees }), { hasClientPhone: true });
    expect(items[1]).toMatchObject({ key: 'wa-send:employee:e1:primary:production_pdf', label: 'Отправить сотруднику «ivanov / Иванов И.» — PDF для производства' });
    expect(items[2].label).toBe('Отправить сотруднику «Петров П.»');
    expect(items[2].children?.map((child) => child.label)).toEqual(['7701***0202 (основной)', '7701***0303']);
    expect(items[2].children?.[1].children?.map((child) => child.key)).toEqual([
      'wa-send:employee:e2:8:production_pdf', 'wa-send:employee:e2:8:production_excel']);
    expect(items[3]).toMatchObject({ label: 'Отправить сотруднику «Сидоров С.» — PDF для производства', disabled: true, title: 'У сотрудника нет рабочего телефона' });
  });

  it('round-trips employee keys and describes the send', () => {
    for (const target of [{ kind: 'employee' as const, recipientKey: 'e2' }, { kind: 'employee' as const, recipientKey: 'e2', contactId: 8 }]) {
      expect(parseOrderWhatsAppKey(orderWhatsAppItemKey(target, 'production_pdf'))).toEqual({ target, form: 'production_pdf' });
    }
    expect(parseOrderWhatsAppKey('wa-send:employee:e2:x:production_pdf')).toBeNull();
    expect(describeOrderWhatsAppSend(menu({ employees }), { kind: 'employee', recipientKey: 'e2', contactId: 8 }, 'production_pdf'))
      .toEqual({ targetLabel: 'сотруднику «Петров П.» (7701***0303)', formTitle: 'PDF для производства' });
  });

  it('an older backend without employees changes nothing', () => {
    expect(buildOrderWhatsAppMenuItems(menu(), { hasClientPhone: true })).toHaveLength(3);
  });
});
});

describe('a chosen phone of the client in the card menu', () => {
  const clientContacts = [{ phoneId: 11, masked: '7701***2060', isPrimary: true, isDefault: true, token: 't11' },
    { phoneId: 12, masked: '7777***4567', isPrimary: false, isDefault: false, token: 't12' }];

  it('several phones: a submenu of phones (the primary first), each with the client forms; one phone: the default send', () => {
    const items = buildOrderWhatsAppMenuItems(menu({ chats: [] }), { hasClientPhone: true, clientContacts });
    expect(items[0]).toMatchObject({ key: 'wa-send:group:client-phones', label: 'Отправить клиенту в WhatsApp' });
    expect(items[0].children?.map((child) => child.label)).toEqual(['7701***2060 (основной)', '7777***4567']);
    expect(items[0].children?.[1].children?.map((child) => child.key)).toEqual([
      'wa-send:client-phone:12:production_pdf', 'wa-send:client-phone:12:order_pdf']);
    const single = buildOrderWhatsAppMenuItems(menu({ chats: [] }), { hasClientPhone: true, clientContacts: clientContacts.slice(0, 1) });
    expect(single[0].children?.map((child) => child.key)).toEqual(['wa-send:client:production_pdf', 'wa-send:client:order_pdf']);
    // No phone at all: locked with the hint, whatever the list says.
    const none = buildOrderWhatsAppMenuItems(menu({ chats: [] }), { hasClientPhone: false, clientContacts });
    expect(none[0]).toMatchObject({ key: 'wa-send:group:client', disabled: true, title: NO_CLIENT_PHONE_TITLE });
  });

  it('while the phones are loading the client item waits: no default send that could double a later choice', () => {
    const items = buildOrderWhatsAppMenuItems(menu({ chats: [] }), { hasClientPhone: true, clientContacts: [], clientContactsLoading: true });
    expect(items[0]).toMatchObject({ key: 'wa-send:group:client', disabled: true, title: 'Загружаются телефоны клиента' });
    expect(items[0].children).toBeUndefined();
    // Loaded with nothing (an older backend, a failure): the default send is back.
    const loaded = buildOrderWhatsAppMenuItems(menu({ chats: [] }), { hasClientPhone: true, clientContacts: [], clientContactsLoading: false });
    expect(loaded[0].children?.map((child) => child.key)).toEqual(['wa-send:client:production_pdf', 'wa-send:client:order_pdf']);
  });

  it('the only readable phone is not the default one (unreadable primary): it is offered as a chosen phone', () => {
    const sole = buildOrderWhatsAppMenuItems(menu({ chats: [] }), { hasClientPhone: true, clientContacts: clientContacts.slice(1) });
    expect(sole[0].label).toBe('Отправить клиенту в WhatsApp');
    expect(sole[0].children?.map((child) => child.key)).toEqual(['wa-send:client-phone:12:production_pdf', 'wa-send:client-phone:12:order_pdf']);
  });

  it('a chosen phone is sent with the token of the number the menu showed; a choice gone from the lists sends nothing', () => {
    expect(withPhoneToken({ kind: 'client', phoneId: 12 }, menu(), clientContacts)).toEqual({ kind: 'client', phoneId: 12, phoneToken: 't12' });
    expect(withPhoneToken({ kind: 'client' }, menu(), clientContacts)).toEqual({ kind: 'client' });
    expect(withPhoneToken({ kind: 'client', phoneId: 99 }, menu(), clientContacts)).toBeNull();
    const employees = [{ recipientKey: 'e1', label: 'x', forms: ['production_pdf' as const], contacts: [
      { contactId: 7, masked: 'm', isPrimary: true, token: 'te7' }, { contactId: 8, masked: 'm', isPrimary: false }] }];
    expect(withPhoneToken({ kind: 'employee', recipientKey: 'e1', contactId: 7 }, menu({ employees }), [])).toEqual({ kind: 'employee', recipientKey: 'e1', contactId: 7, contactToken: 'te7' });
    // An older backend gives no token: the employee send goes as before.
    expect(withPhoneToken({ kind: 'employee', recipientKey: 'e1', contactId: 8 }, menu({ employees }), [])).toEqual({ kind: 'employee', recipientKey: 'e1', contactId: 8 });
    expect(withPhoneToken({ kind: 'employee', recipientKey: 'e1', contactId: 9 }, menu({ employees }), [])).toBeNull();
    expect(withPhoneToken({ kind: 'employee', recipientKey: 'e1' }, menu({ employees }), [])).toEqual({ kind: 'employee', recipientKey: 'e1' });
    expect(withPhoneToken({ kind: 'chat', chatKey: 'c1' }, menu(), [])).toEqual({ kind: 'chat', chatKey: 'c1' });
  });

  it('round-trips the phone keys and names the phone in the toast', () => {
    const target = { kind: 'client' as const, phoneId: 12 };
    expect(parseOrderWhatsAppKey(orderWhatsAppItemKey(target, 'order_pdf'))).toEqual({ target, form: 'order_pdf' });
    expect(parseOrderWhatsAppKey(orderWhatsAppItemKey({ kind: 'client' }, 'order_pdf'))).toEqual({ target: { kind: 'client' }, form: 'order_pdf' });
    expect(parseOrderWhatsAppKey('wa-send:client-phone:x:order_pdf')).toBeNull();
    expect(describeOrderWhatsAppSend(menu(), target, 'order_pdf', clientContacts)).toEqual({ targetLabel: 'клиенту (7777***4567)', formTitle: 'PDF заказа' });
    expect(describeOrderWhatsAppSend(menu(), { kind: 'client' }, 'order_pdf', clientContacts).targetLabel).toBe('клиенту');
  });
});

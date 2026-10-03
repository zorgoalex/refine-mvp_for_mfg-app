import type { ReactNode } from 'react';
import type { OrderFormCode, OrderSendMenu, OrderSendTarget } from '../../api/orderSendApiTypes';

export const NO_CLIENT_PHONE_TITLE = 'У клиента нет телефона';
export const NO_EMPLOYEE_PHONE_TITLE = 'У сотрудника нет рабочего телефона';
const KEY_PREFIX = 'wa-send';

/** A menu item in the shape antd's `Menu` takes; `icon` is whatever the caller passes in. */
export interface OrderWhatsAppMenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  children?: OrderWhatsAppMenuItem[];
}

export interface OrderWhatsAppMenuOptions {
  /** The order's client has a phone (the client item is disabled otherwise). */
  hasClientPhone: boolean;
  /** Keys of the leaf items being sent right now (disabled while in flight). */
  sending?: ReadonlySet<string>;
  /** Icon for the top-level items. */
  icon?: ReactNode;
}

export function orderWhatsAppItemKey(target: OrderSendTarget, form: OrderFormCode): string {
  if (target.kind === 'client') return `${KEY_PREFIX}:client:${form}`;
  if (target.kind === 'employee') return `${KEY_PREFIX}:employee:${target.recipientKey}:${target.contactId ?? 'primary'}:${form}`;
  return `${KEY_PREFIX}:chat:${target.chatKey}:${form}`;
}

function groupKey(target: OrderSendTarget): string {
  if (target.kind === 'client') return `${KEY_PREFIX}:group:client`;
  if (target.kind === 'employee') return `${KEY_PREFIX}:group:employee:${target.recipientKey}:${target.contactId ?? 'primary'}`;
  return `${KEY_PREFIX}:group:${target.chatKey}`;
}

export function isOrderWhatsAppKey(key: string): boolean {
  return key.startsWith(`${KEY_PREFIX}:`);
}

/** The target and form of a leaf item key; null for any other key. */
export function parseOrderWhatsAppKey(key: string): { target: OrderSendTarget; form: OrderFormCode } | null {
  const parts = key.split(':');
  if (parts[0] !== KEY_PREFIX || parts.length < 3) return null;
  const form = parts[parts.length - 1] as OrderFormCode;
  if (parts[1] === 'client' && parts.length === 3) return { target: { kind: 'client' }, form };
  if (parts[1] === 'employee' && parts.length === 5) {
    const contact = parts[3] === 'primary' ? undefined : Number(parts[3]);
    if (contact !== undefined && !Number.isInteger(contact)) return null;
    return { target: { kind: 'employee', recipientKey: parts[2], ...(contact !== undefined ? { contactId: contact } : {}) }, form };
  }
  if (parts[1] === 'chat' && parts.length >= 4) return { target: { kind: 'chat', chatKey: parts.slice(2, -1).join(':') }, form };
  return null;
}

/**
 * The «Отправить в WhatsApp» items of the order card «⋯» menu. Empty while the feature is off or
 * nothing is allowed. A recipient with one form gets a plain item, with several — a submenu.
 */
export function buildOrderWhatsAppMenuItems(menu: OrderSendMenu | null | undefined, options: OrderWhatsAppMenuOptions): OrderWhatsAppMenuItem[] {
  if (!menu || !menu.enabled) return [];
  const sending = options.sending ?? new Set<string>();
  const titles = new Map(menu.forms.map((form) => [form.code, form.title]));
  const known = (codes: readonly OrderFormCode[]) => codes.filter((code) => titles.has(code));
  const withIcon = (item: OrderWhatsAppMenuItem): OrderWhatsAppMenuItem => (options.icon === undefined ? item : { ...item, icon: options.icon });

  const recipient = (target: OrderSendTarget, head: string, codes: readonly OrderFormCode[], locked: boolean, lockTitle?: string): OrderWhatsAppMenuItem | null => {
    const forms = known(codes);
    if (forms.length === 0) return null;
    const leaf = (code: OrderFormCode): OrderWhatsAppMenuItem => {
      const key = orderWhatsAppItemKey(target, code);
      return { key, label: titles.get(code) as string, disabled: locked || sending.has(key) };
    };
    if (forms.length === 1) {
      const only = leaf(forms[0]);
      return withIcon({ ...only, label: `${head} — ${only.label}`, ...(locked && lockTitle ? { title: lockTitle } : {}) });
    }
    // A locked recipient is a plain disabled item: a submenu title cannot carry the hint (rc-menu overrides it).
    if (locked) {
      return withIcon({ key: groupKey(target), label: head, disabled: true, ...(lockTitle ? { title: lockTitle } : {}) });
    }
    return withIcon({
      key: groupKey(target),
      label: head,
      disabled: false,
      children: forms.map(leaf),
    });
  };

  const items: Array<OrderWhatsAppMenuItem | null> = [
    recipient({ kind: 'client' }, 'Отправить клиенту в WhatsApp', menu.client.forms, !options.hasClientPhone, NO_CLIENT_PHONE_TITLE),
    ...menu.chats.map((chat) => recipient({ kind: 'chat', chatKey: chat.chatKey }, `Отправить в чат «${chat.label}»`, chat.forms, false)),
    ...(menu.employees ?? []).map((employee) => {
      const head = `Отправить сотруднику «${employee.label}»`;
      const target = { kind: 'employee' as const, recipientKey: employee.recipientKey };
      // One phone (or none): like a chat — the primary phone, locked without one.
      if (employee.contacts.length <= 1) return recipient(target, head, employee.forms, employee.contacts.length === 0, NO_EMPLOYEE_PHONE_TITLE);
      if (known(employee.forms).length === 0) return null;
      // Several phones: a submenu of phones (the primary first), each with its forms.
      const phones = employee.contacts.map((contact) => recipient({ ...target, contactId: contact.contactId },
        `${contact.masked}${contact.isPrimary ? ' (основной)' : ''}`, employee.forms, false));
      return withIcon({
        key: `${KEY_PREFIX}:group:employee:${employee.recipientKey}`,
        label: head,
        disabled: false,
        children: phones.filter((item): item is OrderWhatsAppMenuItem => item !== null).map(({ icon: _icon, ...item }) => item),
      });
    }),
  ];
  return items.filter((item): item is OrderWhatsAppMenuItem => item !== null);
}

/** Display data for the toast: who and which form a leaf key stands for. */
export function describeOrderWhatsAppSend(menu: OrderSendMenu, target: OrderSendTarget, form: OrderFormCode): { targetLabel: string; formTitle: string } {
  const formTitle = menu.forms.find((item) => item.code === form)?.title ?? form;
  if (target.kind === 'client') return { targetLabel: 'клиенту', formTitle };
  if (target.kind === 'employee') {
    const employee = (menu.employees ?? []).find((item) => item.recipientKey === target.recipientKey);
    const contact = target.contactId !== undefined ? employee?.contacts.find((item) => item.contactId === target.contactId) : undefined;
    return { targetLabel: `сотруднику «${employee?.label ?? 'сотрудник'}»${contact ? ` (${contact.masked})` : ''}`, formTitle };
  }
  const chat = menu.chats.find((item) => item.chatKey === target.chatKey);
  return { targetLabel: `в чат «${chat?.label ?? 'чат'}»`, formTitle };
}
